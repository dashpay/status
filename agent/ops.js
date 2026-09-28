// Executes operator requests with the dashnet CLI on this host.
//
// The web process may only create request files; this module owns operation
// records, logs and every dashnet artifact. One operation runs per network.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPONENTS, COMPONENT_REPOS, readJSON, writeAtomic } from '../shared/settings.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIONS = new Set(['upgrade', 'deploy', 'enroll', 'doctor']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'rejected']);
const REPO_COMPONENT = Object.fromEntries(Object.entries(COMPONENT_REPOS).flatMap(([c, r]) => [[r, c], [`index.docker.io/${r}`, c]]));
const IMAGE = (component) => new RegExp(`^(docker\\.io/)?${COMPONENT_REPOS[component]}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$`);

export function manifestFor(settings, network, state) {
  const targets = [], excluded = [];
  for (const h of state?.hosts || []) {
    if (!['validator', 'masternode', 'seed'].includes(h.role) || h.duplicate) continue;
    const why = h.state !== 'running' ? h.state : !h.publicIp ? 'no public address' : !h.tagged ? `missing ${settings.aws.tagKey} tag` : null;
    const containers = h.probe?.data?.containers || h.lastGood?.data?.containers;
    if (why || !containers) { excluded.push({ name: h.name, reason: why || 'not yet probed' }); continue; }
    const map = {};
    for (const c of [...containers].sort((a, b) => b.running - a.running)) {
      const component = REPO_COMPONENT[c.repo];
      if (component && !map[component]) map[component] = c.name;
    }
    let chosen = map;
    if (h.role === 'masternode') chosen = map.core ? { core: map.core } : null;
    if (h.role === 'seed') chosen = map.tenderdash ? Object.fromEntries(['core', 'tenderdash'].filter((c) => map[c]).map((c) => [c, map[c]])) : null;
    if (h.role === 'validator' && !['core', 'drive', 'tenderdash', 'dapi', 'gateway'].every((c) => map[c])) chosen = null;
    if (!chosen) { excluded.push({ name: h.name, reason: 'expected containers not found' }); continue; }
    targets.push({ name: h.name, instanceId: h.instanceId, address: h.publicIp, architecture: h.arch, role: h.role, containers: chosen });
  }
  return {
    manifest: {
      apiVersion: 'dash.network/v1alpha1', kind: 'ExistingNetwork',
      metadata: { name: network.name, displayName: network.displayName, description: 'Discovered from EC2 and live host inspection by the status agent', visibility: network.public ? 'public' : 'private' },
      chainType: network.chainType, coreNetwork: network.coreNetwork,
      accountId: settings.aws.accountId, region: settings.aws.region, networkTagKey: settings.aws.tagKey, stateTable: settings.aws.stateTable,
      access: { user: 'ubuntu', port: 22, address: 'public' }, targets,
    },
    excluded,
  };
}

export function validateRequest(settings, q) {
  if (!q || !UUID.test(q.id)) throw new Error('invalid request id');
  const network = settings.networks.find((n) => n.name === q.network);
  if (!network?.deployable) throw new Error('network is not deployable');
  if (!ACTIONS.has(q.action)) throw new Error('unsupported action');
  if (!Array.isArray(q.nodes) || !q.nodes.length || q.nodes.length > 200 || new Set(q.nodes).size !== q.nodes.length || !q.nodes.every((n) => /^[a-z][a-z0-9-]{0,62}$/.test(n))) throw new Error('select one or more nodes');
  const components = q.components || [], images = q.images || {};
  if (['upgrade', 'deploy'].includes(q.action)) {
    if (!components.length || !components.every((c) => COMPONENTS.includes(c)) || new Set(components).size !== components.length) throw new Error('select components');
  } else if (components.length) throw new Error('components apply to upgrade/deploy only');
  if (q.action === 'upgrade') {
    for (const c of components) if (!IMAGE(c).test(images[c] || '')) throw new Error(`${c}: image must be ${COMPONENT_REPOS[c]}:<tag> or @sha256:<digest>`);
    if (Object.keys(images).some((c) => !components.includes(c))) throw new Error('image for an unselected component');
  } else if (Object.keys(images).length) throw new Error('only upgrades change images');
  const d = /^[1-9][0-9]{0,3}(s|m|h)$/;
  const window = q.options?.observationWindow || network.observationWindow;
  const timeout = q.options?.timeout || network.operationTimeout;
  if (!d.test(window) || !d.test(timeout)) throw new Error('durations look like 4m / 110m');
  return { network, window, timeout, components, images };
}

export function createOps({ settings: getSettings, dirs, key, pool, binary, onChange = () => {}, log = console.log, spawnImpl = spawn }) {
  const { requests, ops, work } = dirs;
  for (const d of [requests, ops, work]) mkdirSync(d, { recursive: true });
  const running = new Map();
  const recordPath = (id) => join(ops, `${id}.json`);
  const logPath = (id) => join(ops, `${id}.log`);
  const load = (id) => readJSON(recordPath(id));
  const save = (r) => { r.updatedAt = new Date().toISOString(); writeAtomic(recordPath(r.id), JSON.stringify(r)); onChange(r); return r; };
  const write = (id, line) => appendFileSync(logPath(id), `${new Date().toISOString().slice(11, 19)} ${line}\n`);

  // An agent restart leaves a dashnet runner claim behind; mark it resumable.
  for (const f of readdirSync(ops).filter((f) => f.endsWith('.json'))) {
    const r = readJSON(join(ops, f));
    if (r && ['preparing', 'running', 'queued-run'].includes(r.status)) {
      r.status = 'interrupted'; r.error = 'Agent restarted during this step. Resume continues the same reviewed plan.';
      save(r); write(r.id, 'agent restarted; operation interrupted');
    }
  }

  function dashnet(r, args, { timeoutMs, onLine } = {}) {
    return new Promise((resolve) => {
      write(r.id, `$ dashnet ${args.map((a) => a.startsWith(work) ? a.slice(work.length + 1) : a).join(' ')}`);
      const child = spawnImpl(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_REGION: getSettings().aws.region } });
      const slot = running.get(r.network);
      if (slot?.id === r.id) slot.child = child; else running.set(r.network, { id: r.id, child });
      let buffer = '';
      const onData = (d) => {
        buffer += d.toString();
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          if (!line.trim()) continue;
          write(r.id, line.slice(0, 2000));
          onLine?.(line);
        }
      };
      child.stderr.on('data', onData);
      child.stdout.on('data', () => {}); // JSON results go to --out files
      const timer = timeoutMs ? setTimeout(() => child.kill('SIGTERM'), timeoutMs) : null;
      child.on('error', (e) => { write(r.id, `failed to start dashnet: ${e.message}`); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const current = running.get(r.network);
        if (current?.id === r.id) current.child = null;
        if (buffer.trim()) write(r.id, buffer.trim());
        write(r.id, `exit ${code ?? signal}`);
        resolve(code ?? 1);
      });
    });
  }

  function step(r, name) {
    const s = { name, status: 'running', startedAt: new Date().toISOString() };
    r.steps.push(s); save(r);
    return (status, detail) => { s.status = status; s.finishedAt = new Date().toISOString(); if (detail) s.detail = detail; save(r); };
  }

  const access = (dir) => ['--ssh-key', key.path, '--known-hosts', join(dir, 'known_hosts')];

  async function readState(network) { return readJSON(join(dirs.state, `${network}.json`)); }

  async function prepare(r) {
    const s = getSettings();
    const { network, components, images } = validateRequest(s, r.request);
    // Each preparation gets fresh artifacts; dashnet never overwrites outputs.
    r.attempt = (r.attempt || 0) + 1;
    const dir = join(work, r.id, String(r.attempt)); mkdirSync(dir, { recursive: true, mode: 0o700 });
    r.status = 'preparing'; save(r);
    let done = step(r, 'Build manifest from discovery');
    const state = await readState(network.name);
    const { manifest, excluded } = manifestFor(s, network, state);
    const names = new Set(manifest.targets.map((t) => t.name));
    const missing = r.request.nodes.filter((n) => !names.has(n));
    if (missing.length) { done('failed'); throw new Error(`not operable: ${missing.map((n) => `${n} (${excluded.find((e) => e.name === n)?.reason || 'unknown'})`).join(', ')}`); }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1), { mode: 0o600 });
    writeFileSync(join(dir, 'known_hosts'), pool.knownHosts(manifest.targets.map((t) => ({ instanceId: t.instanceId }))), { mode: 0o600 });
    const missingPins = manifest.targets.filter((t) => !pool.pins[t.instanceId]).map((t) => t.name);
    if (missingPins.length) { done('failed'); throw new Error(`no pinned host key yet for ${missingPins.join(', ')}`); }
    done('ok', `${manifest.targets.length} targets${excluded.length ? `, ${excluded.length} excluded` : ''}`);

    done = step(r, 'Import live state (managed-import)');
    const code = await dashnet(r, ['managed-import', '--manifest', join(dir, 'manifest.json'), ...access(dir), '--timeout', '6m', '--out', join(dir, 'snapshot.json')], { timeoutMs: 7 * 60_000 });
    const snapshot = readJSON(join(dir, 'snapshot.json'));
    if (!snapshot) { done('failed'); throw new Error('import produced no snapshot'); }
    const unavailable = r.request.nodes.filter((n) => { const o = snapshot.nodes?.[n]; return !o || o.error || o.problems?.length; });
    done(code === 0 ? 'ok' : 'warn', code === 0 ? `snapshot ${snapshot.id.slice(0, 12)}` : 'some unselected targets incomplete');
    if (unavailable.length) throw new Error(`selected nodes not observable: ${unavailable.map((n) => `${n}: ${snapshot.nodes?.[n]?.error || snapshot.nodes?.[n]?.problems?.join(', ') || 'missing'}`).join('; ')}`);

    if (r.request.action === 'doctor') return { dir, snapshot, manifest };
    const journal = await journalFor(dir);
    const enrolled = new Set(Object.entries(journal?.record?.enrolled || {}).filter(([n, v]) => v && (!journal.record.instances || journal.record.instances[n] === manifest.targets.find((t) => t.name === n)?.instanceId)).map(([n]) => n));
    const toEnroll = r.request.nodes.filter((n) => !enrolled.has(n));
    if (toEnroll.length) {
      done = step(r, `Enroll ${toEnroll.length} node(s) (no restarts)`);
      const c = await dashnet(r, ['managed-enroll', '--snapshot', join(dir, 'snapshot.json'), '--confirm', snapshot.id, '--nodes', toEnroll.join(','), ...access(dir), '--timeout', '15m', '--out', join(dir, 'enroll.json')], { timeoutMs: 16 * 60_000, onLine: parseRunner(r) });
      if (c !== 0) { done('failed'); throw new Error('enrollment failed; see log'); }
      done('ok', toEnroll.join(', '));
    }
    if (r.request.action === 'enroll') return { dir, snapshot, manifest };

    done = step(r, 'Resolve images and plan (managed-plan)');
    // dashnet parses references strictly: the registry must be explicit.
    const explicit = Object.fromEntries(Object.entries(images).map(([c, ref]) => [c, ref.startsWith('docker.io/') ? ref : `docker.io/${ref}`]));
    writeFileSync(join(dir, 'images.json'), JSON.stringify(explicit), { mode: 0o600 });
    const planArgs = ['managed-plan', '--snapshot', join(dir, 'snapshot.json'), '--operation', r.request.action, '--scope', components.join(','), '--nodes', r.request.nodes.join(','), '--timeout', '5m', '--out', join(dir, 'plan.json')];
    if (r.request.action === 'upgrade') planArgs.push('--images', join(dir, 'images.json'));
    const pc = await dashnet(r, planArgs, { timeoutMs: 6 * 60_000 });
    const plan = readJSON(join(dir, 'plan.json'));
    if (pc !== 0 || !plan) { done('failed'); throw new Error('planning failed; see log'); }
    const changes = [];
    for (const [node, pins] of Object.entries(plan.images || {})) for (const [component, to] of Object.entries(pins)) {
      const before = snapshot.nodes[node]?.components?.[component] || {};
      changes.push({ node, component, from: before.image, fromDigest: before.digests?.[0]?.split('@')[1] || null, to, requested: images[component] || null, dependency: !components.includes(component) });
    }
    done('ok', `${changes.length} container change(s)`);
    r.review = { planId: plan.id, snapshotId: snapshot.id, changes, targets: r.request.nodes, operation: plan.operation, preparedAt: new Date().toISOString() };
    return { dir, snapshot, manifest, plan };
  }

  async function journalFor(dir) {
    const out = join(dir, `journal-${randomUUID()}.json`);
    const code = await new Promise((resolve) => {
      const child = spawnImpl(binary, ['managed-operation', '--manifest', join(dir, 'manifest.json'), '--timeout', '1m', '--out', out], { stdio: 'ignore' });
      child.on('close', (c) => resolve(c ?? 1)); child.on('error', () => resolve(1));
    });
    const v = code === 0 ? readJSON(out) : null;
    rmSync(out, { force: true });
    return v;
  }

  const parseRunner = (r) => (line) => {
    const m = /^runner: ([0-9a-f]{32})$/.exec(line);
    if (m) { r.runner = m[1]; save(r); }
  };

  async function execute(r) {
    const dir = r.attempt ? join(work, r.id, String(r.attempt)) : join(work, r.id);
    const plan = readJSON(join(dir, 'plan.json'));
    if (!plan || plan.id !== r.review?.planId) throw new Error('reviewed plan is missing');
    const { window, timeout } = validateRequest(getSettings(), r.request);
    // Resuming after an agent/runner death: release only our own stale claim.
    const journal = await journalFor(dir);
    if (journal?.owner && journal.owner === r.runner) {
      const done = step(r, 'Release stale runner claim');
      const c = await dashnet(r, ['managed-unlock', '--manifest', join(dir, 'manifest.json'), '--expected-owner', r.runner, '--confirm-runner-stopped', '--timeout', '1m']);
      done(c === 0 ? 'ok' : 'failed');
      if (c !== 0) throw new Error('could not release the previous runner claim');
    } else if (journal?.owner) throw new Error(`network journal is claimed by runner ${journal.owner}; another operation is active`);
    r.status = 'running'; r.progress = { phase: 'starting', completed: [], current: null }; save(r);
    const done = step(r, `${r.request.action === 'upgrade' ? 'Upgrade' : 'Restore'} (managed-${plan.operation})`);
    const onLine = (line) => {
      parseRunner(r)(line);
      const p = r.progress;
      if (/^managed-(staging|applying|verifying)$/.test(line)) p.phase = line.slice(8);
      let m = /^managed target (\S+) applying$/.exec(line);
      if (m) p.current = m[1];
      m = /^managed target (\S+) applied$/.exec(line);
      if (m) { p.completed.push(m[1]); p.current = null; }
      m = /^managed health gate waiting: (.*)$/.exec(line);
      p.waiting = m ? m[1].slice(0, 300) : undefined;
      save(r);
    };
    const ms = toMs(timeout);
    const c = await dashnet(r, [`managed-${plan.operation}`, '--plan', join(dir, 'plan.json'), '--confirm', plan.id, ...access(dir), '--observation-window', window, '--timeout', timeout, '--out', join(dir, `result-${Date.now()}.json`)], { timeoutMs: ms + 60_000, onLine });
    if (c !== 0) { done('failed'); throw new Error(r.cancelRequested ? 'cancelled by operator' : 'operation stopped; the journal keeps progress. Resume continues the same plan.'); }
    done('ok');
    // Remember which tag each pinned digest came from so the board can show it.
    const tagsPath = join(dirs.state, 'image-tags.json');
    const tags = readJSON(tagsPath, {});
    for (const change of r.review.changes) if (change.requested) tags[change.to.split('@')[1]] = change.requested.replace(/^docker\.io\//, '');
    writeAtomic(tagsPath, JSON.stringify(tags));
  }

  async function doctor(r, dir) {
    const { window } = validateRequest(getSettings(), r.request);
    const done = step(r, 'Health gate (managed-doctor)');
    const c = await dashnet(r, ['managed-doctor', '--snapshot', join(dir, 'snapshot.json'), ...access(dir), '--observation-window', window, '--timeout', '20m', '--out', join(dir, 'health.json')], { timeoutMs: 21 * 60_000 });
    const h = readJSON(join(dir, 'health.json'));
    const nodes = Object.fromEntries(r.request.nodes.map((n) => [n, h?.nodes?.[n] ? { healthy: !!h.nodes[n].healthy, status: h.nodes[n].status, problems: h.nodes[n].problems || [] } : null]));
    r.result = { healthy: r.request.nodes.every((n) => nodes[n]?.healthy), nodes };
    done(r.result.healthy ? 'ok' : 'failed', c === 0 ? 'fleet healthy' : 'see node results');
  }

  async function run(r) {
    try {
      if (r.status === 'queued') {
        const { dir } = await prepare(r);
        if (r.request.action === 'doctor') { await doctor(r, dir); r.status = r.result.healthy ? 'succeeded' : 'failed'; }
        else if (r.request.action === 'enroll') r.status = 'succeeded';
        else r.status = 'review';
      } else if (r.status === 'confirmed') {
        await execute(r);
        r.status = 'succeeded'; r.finishedAt = new Date().toISOString();
      }
    } catch (e) {
      r.status = r.cancelRequested ? 'cancelled' : 'failed';
      r.error = e.message.slice(0, 500);
      write(r.id, `error: ${r.error}`);
    }
    r.cancelRequested = undefined;
    save(r);
    if (['succeeded', 'failed', 'cancelled'].includes(r.status)) onChange(r, true);
  }

  // Poll the request directory: create, confirm, cancel, resume.
  function tick() {
    const s = getSettings();
    for (const f of readdirSync(requests).filter((f) => f.endsWith('.json')).sort()) {
      const path = join(requests, f);
      let q; try { q = JSON.parse(readFileSync(path, 'utf8')); } catch { rmSync(path, { force: true }); continue; }
      rmSync(path, { force: true });
      try { handle(s, q); } catch (e) { log(`request ${f}: ${e.message}`); }
    }
    for (const f of readdirSync(ops).filter((f) => f.endsWith('.json'))) {
      const r = readJSON(join(ops, f));
      if (!r || running.has(r.network) || !['queued', 'confirmed'].includes(r.status)) continue;
      if ([...running.keys()].includes(r.network)) continue;
      running.set(r.network, { id: r.id, child: null });
      run(r).finally(() => { if (running.get(r.network)?.id === r.id) running.delete(r.network); });
    }
  }

  function handle(s, q) {
    const actor = q.actor && Number.isInteger(q.actor.id) ? { id: q.actor.id, login: String(q.actor.login).slice(0, 39) } : null;
    if (!actor || !s.operators.some((o) => o.id === actor.id && (o.networks.includes('*') || o.networks.includes(q.network)))) throw new Error('actor is not an operator for this network');
    if (q.type === 'create') {
      const request = { id: q.id, network: q.network, action: q.action, nodes: q.nodes, components: q.components || [], images: q.images || {}, options: q.options || {} };
      let r = { id: q.id, network: q.network, actor, createdAt: new Date().toISOString(), request, status: 'queued', steps: [] };
      if (existsSync(recordPath(q.id))) throw new Error('duplicate request id');
      try { validateRequest(s, request); } catch (e) { r = { ...r, status: 'rejected', error: e.message }; }
      save(r); write(r.id, `requested by ${actor.login}: ${request.action} ${request.nodes.join(',')} ${request.components.join(',')} ${Object.values(request.images).join(' ')}`);
      return;
    }
    const r = UUID.test(q.id || '') ? load(q.id) : null;
    if (!r || r.network !== q.network) throw new Error('unknown operation');
    if (q.type === 'confirm') {
      if (r.status !== 'review' || q.planId !== r.review?.planId) throw new Error('plan changed or not awaiting review');
      if (Date.now() - Date.parse(r.review.preparedAt) > 60 * 60_000) { r.status = 'failed'; r.error = 'review expired after 60 minutes; prepare again'; save(r); return; }
      r.status = 'confirmed'; r.confirmedBy = actor; r.confirmedAt = new Date().toISOString(); save(r);
      write(r.id, `confirmed by ${actor.login}: plan ${r.review.planId}`);
    } else if (q.type === 'cancel') {
      const active = running.get(r.network);
      if (active?.id === r.id && active.child) { r.cancelRequested = true; save(r); write(r.id, `cancel requested by ${actor.login}`); active.child.kill('SIGTERM'); }
      else if (['queued', 'review', 'confirmed'].includes(r.status)) { r.status = 'cancelled'; save(r); write(r.id, `cancelled by ${actor.login}`); }
    } else if (q.type === 'resume') {
      if (!['failed', 'interrupted', 'cancelled'].includes(r.status)) throw new Error('only a stopped operation can be resumed');
      // Never confirmed: prepare a fresh plan. Confirmed: continue the exact reviewed plan.
      if (!r.confirmedAt) { r.status = 'queued'; r.steps = []; r.review = undefined; }
      else r.status = 'confirmed';
      r.error = undefined; save(r); write(r.id, `resume requested by ${actor.login}`);
    }
  }

  return { tick, running, isTerminal: (s) => TERMINAL.has(s), manifestFor };
}

export function toMs(d) {
  const m = /^(\d+)(s|m|h)$/.exec(d);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
}
