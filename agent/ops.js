// Executes operator requests with the dashnet CLI on this host.
//
// The web process may only create request files; this module owns operation
// records, logs and every dashnet artifact. One operation runs per network.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPONENTS, COMPONENT_REPOS, adminFor, operatorFor, readJSON, validateDevnetDefaults, writeAtomic } from '../shared/settings.js';
import { createDevnets, validateDevnetRequest } from './devnets.js';
import { createReset, validateReset } from './reset.js';

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

export const LIFECYCLE = new Set(['create-devnet', 'delete-devnet', 'devnet-services', 'devnet-platform', 'platform-reset']);

export function validateRequest(settings, q, registry = {}) {
  if (!q || !UUID.test(q.id)) throw new Error('invalid request id');
  if (q.action === 'create-devnet') { validateDevnetRequest(settings, q, registry); return { lifecycle: true }; }
  // Queued by a creation once Core is ready; never requested directly.
  if (q.action === 'devnet-platform') throw new Error('Platform starts automatically after a devnet is created');
  if (q.action === 'platform-reset') { validateReset(settings, q); return { lifecycle: true }; }
  if (q.action === 'devnet-services') {
    const reg = registry[q.network];
    if (!reg || reg.status === 'deleted') throw new Error('services are managed only for console devnets');
    const sv = q.services || {};
    const allowed = ['quorumServer', 'insightImage', 'explorerVersion', 'faucetRef', 'faucetAmount', 'faucetRateLimit', 'faucetFunding'];
    if (Object.keys(sv).some((k) => !allowed.includes(k))) throw new Error(`service settings: ${allowed.join(', ')}`);
    validateDevnetDefaults({ ...settings.devnets, services: { ...settings.devnets.services, ...sv } });
    return { lifecycle: true };
  }
  if (q.action === 'delete-devnet') {
    const reg = registry[q.network];
    if (!reg || reg.status === 'deleted') throw new Error('only devnets created from this console can be deleted');
    if (q.confirmName !== q.network) throw new Error(`type ${q.network} to confirm deletion`);
    return { lifecycle: true };
  }
  const network = settings.networks.find((n) => n.name === q.network);
  if (network?.kind === 'dashnet') {
    // Console devnets: dash-network-go native upgrade (all validators) and doctor.
    if (!['upgrade', 'doctor'].includes(q.action)) throw new Error('console devnets support upgrade and health check');
    if (!registry[q.network] || registry[q.network].status !== 'ready') throw new Error('devnet is not ready');
    const components = q.components || [], images = q.images || {};
    if (q.action === 'upgrade') {
      // Core needs a devnet whose pinned dash-network-go supports --scope core.
      // dashnet upgrades a network-ready deployment only.
      if (['starting', 'stopped'].includes(registry[q.network].platform)) throw new Error('Platform has not started on this devnet yet; upgrade once its Platform operation has finished');
      const core = (registry[q.network].upgradeScopes || []).includes('core');
      const allowed = ['drive', 'dapi', 'gateway', 'helper', 'tenderdash', ...(core ? ['core'] : [])];
      if (components.includes('core') && !core) throw new Error('this devnet was created with a dash-network-go that cannot upgrade Core; devnets created since Core upgrades landed can');
      if (!components.length || components.some((c) => !allowed.includes(c)) || new Set(components).size !== components.length) throw new Error(`select from ${allowed.join(', ')}`);
      for (const c of components) if (!IMAGE(c).test(images[c] || '')) throw new Error(`${c}: image must be ${COMPONENT_REPOS[c]}:<tag> or @sha256:<digest>`);
      if (Object.keys(images).some((c) => !components.includes(c))) throw new Error('image for an unselected component');
    } else if (components.length) throw new Error('components apply to upgrade only');
    return { network, native: true, components, images };
  }
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

export function createOps({ settings: getSettings, dirs, key, pool, binary, onChange = () => {}, log = console.log, spawnImpl = spawn, devnetsImpl }) {
  const { requests, ops, work } = dirs;
  for (const d of [requests, ops, work]) mkdirSync(d, { recursive: true });
  const running = new Map();
  const live = new Map(); // id -> record object owned by a running run()
  let shuttingDown = false; // set by shutdown(): stopped operations are interrupted, not failed
  const seen = new Map(); // op file -> { mtime, status } so tick() skips unchanged records
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

  // Plans bind dashnet's node recipes, so every operation keeps using the exact
  // binary it was planned with, even after the agent image is upgraded.
  function pinBinary(dir) {
    const pinned = join(dir, 'dashnet');
    if (!existsSync(pinned) && existsSync(binary)) { copyFileSync(binary, pinned); chmodSync(pinned, 0o700); }
    return existsSync(pinned) ? pinned : binary;
  }

  function dashnet(r, args, { timeoutMs, onLine, bin } = {}) {
    return new Promise((resolve) => {
      write(r.id, `$ dashnet ${args.map((a) => a.startsWith(work) ? a.slice(work.length + 1) : a).join(' ')}`);
      const child = spawnImpl(bin || r.binary || binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_REGION: getSettings().aws.region } });
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
      // Node clamps delays above 2^31-1 ms to 1 ms: never let a long budget kill at once.
      const timer = timeoutMs ? setTimeout(() => child.kill('SIGTERM'), Math.min(timeoutMs, 2 ** 31 - 1)) : null;
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
    if (r.cancelRequested) throw new Error('cancelled by operator');
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
    r.binary = pinBinary(dir);
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
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      child.on('close', (c) => { clearTimeout(timer); resolve(c ?? 1); }); child.on('error', () => { clearTimeout(timer); resolve(1); });
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
      // A replaced node may take minutes to serve again (a new Core can migrate
      // its indexes on first start); dashnet waits on that node alone.
      m = /^managed target (\S+) starting: (.*)$/.exec(line);
      if (m) { p.phase = 'node-startup'; p.starting = `${m[1]}: ${m[2]}`.slice(0, 300); }
      if (/^managed target \S+ (ready|applied)$/.test(line)) p.starting = undefined;
      save(r);
    };
    // The configured timeout is a per-node budget: nodes are replaced one at a
    // time, each behind its own startup wait and fleet health gate.
    const budget = operationBudget(timeout, r.review?.targets?.length || r.request.nodes.length);
    const c = await dashnet(r, [`managed-${plan.operation}`, '--plan', join(dir, 'plan.json'), '--confirm', plan.id, ...access(dir), '--observation-window', window, '--timeout', budget.flag, '--out', join(dir, `result-${Date.now()}.json`)], { timeoutMs: budget.ms + 60_000, onLine });
    if (r.progress.starting) { r.progress.starting = undefined; save(r); }
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
    const done = step(r, 'Health check (managed-doctor)');
    const c = await dashnet(r, ['managed-doctor', '--snapshot', join(dir, 'snapshot.json'), ...access(dir), '--observation-window', window, '--timeout', '40m', '--out', join(dir, 'health.json')], { timeoutMs: 41 * 60_000 });
    const h = readJSON(join(dir, 'health.json'));
    const nodes = Object.fromEntries(r.request.nodes.map((n) => [n, h?.nodes?.[n] ? { healthy: !!h.nodes[n].healthy, status: h.nodes[n].status, problems: h.nodes[n].problems || [] } : null]));
    r.result = { healthy: r.request.nodes.every((n) => nodes[n]?.healthy), nodes };
    done(r.result.healthy ? 'ok' : 'failed', c === 0 ? 'fleet healthy' : 'see node results');
  }

  // "Run as soon as the plan is ready": the prepared plan is still recorded and
  // shown, and confirmed on the requester's behalf (upgrades/restores only).
  function autoConfirm(r) {
    if (r.request.options?.autoRun !== true || r.status !== 'review' || !['upgrade', 'deploy'].includes(r.request.action) || r.cancelRequested) return;
    Object.assign(r, { status: 'confirmed', confirmedBy: r.actor, confirmedAt: new Date().toISOString(), autoConfirmed: true });
    save(r);
    write(r.id, `plan ${r.review?.planId} confirmed automatically for ${r.actor.login} (run as soon as ready)`);
  }

  async function run(r) {
    live.set(r.id, r);
    try {
      if (LIFECYCLE.has(r.request.action)) {
        const impl = { 'create-devnet': ['prepareCreate', 'executeCreate'], 'delete-devnet': ['prepareDelete', 'executeDelete'], 'devnet-services': ['prepareServices', 'executeServices'], 'devnet-platform': [null, 'executePlatform'], 'platform-reset': ['prepareReset', 'executeReset'] }[r.request.action];
        const mod = r.request.action === 'platform-reset' ? reset : devnets;
        if (r.status === 'queued') {
          if (!impl[0]) throw new Error(`${r.request.action} runs only as queued by its creation`);
          await mod[impl[0]](r); r.status = 'review';
        }
        else if (r.status === 'confirmed') { await mod[impl[1]](r); r.status = 'succeeded'; r.finishedAt = new Date().toISOString(); }
      } else if (getSettings().networks.find((n) => n.name === r.network)?.kind === 'dashnet') {
        if (r.request.action === 'doctor') { await devnets.doctor(r); r.status = r.result.healthy ? 'succeeded' : 'failed'; }
        else {
          if (r.status === 'queued') { await devnets.prepareUpgrade(r); r.status = 'review'; autoConfirm(r); }
          if (r.status === 'confirmed') { await devnets.executeUpgrade(r); r.status = 'succeeded'; r.finishedAt = new Date().toISOString(); }
        }
      } else {
        if (r.status === 'queued') {
          const { dir } = await prepare(r);
          if (r.request.action === 'doctor') { await doctor(r, dir); r.status = r.result.healthy ? 'succeeded' : 'failed'; }
          else if (r.request.action === 'enroll') r.status = 'succeeded';
          else { r.status = 'review'; autoConfirm(r); }
        }
        if (r.status === 'confirmed') {
          await execute(r);
          r.status = 'succeeded'; r.finishedAt = new Date().toISOString();
        }
      }
    } catch (e) {
      r.status = r.cancelRequested ? 'cancelled' : shuttingDown ? 'interrupted' : 'failed';
      r.error = e.message.slice(0, 500);
      for (const st of r.steps) if (st.status === 'running') { st.status = 'failed'; st.finishedAt = new Date().toISOString(); st.detail ??= r.error.slice(0, 200); }
      write(r.id, `error: ${r.error}`);
      if (r.request.action === 'create-devnet' && r.confirmedAt && !shuttingDown) devnets.markFailed?.(r.network);
      if (r.request.action === 'devnet-platform') devnets.markPlatformFailed?.(r.network);
    }
    r.cancelRequested = undefined;
    live.delete(r.id);
    save(r);
    if (['succeeded', 'failed', 'cancelled'].includes(r.status)) onChange(r, true);
  }

  const reset = createReset({ ctx: { step, save, write, dashnet }, dirs, pool, getSettings });
  const devnets = devnetsImpl || createDevnets({ ctx: { dashnet, step, save, write, pinBinary, binary }, dirs, key, pool, getSettings, region: getSettings().aws.region, log });

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
      const path = join(ops, f);
      let mtime; try { mtime = statSync(path).mtimeMs; } catch { continue; }
      const hit = seen.get(f);
      if (hit && hit.mtime === mtime && !['queued', 'confirmed'].includes(hit.status)) continue;
      const r = readJSON(path);
      seen.set(f, { mtime, status: r?.status });
      if (!r || running.has(r.network) || !['queued', 'confirmed'].includes(r.status)) continue;
      if ([...running.keys()].includes(r.network)) continue;
      running.set(r.network, { id: r.id, child: null });
      run(r).finally(() => { if (running.get(r.network)?.id === r.id) running.delete(r.network); });
    }
  }

  function handle(s, q) {
    const actor = q.actor && Number.isInteger(q.actor.id) ? { id: q.actor.id, login: String(q.actor.login).slice(0, 39) } : null;
    const lifecycle = LIFECYCLE.has(q.action) || LIFECYCLE.has(load(q.id)?.request?.action);
    if (!actor || !(lifecycle ? adminFor(s, actor) : operatorFor(s, actor, q.network))) throw new Error(lifecycle ? 'only admins create or delete devnets' : 'actor is not an operator for this network');
    if (q.type === 'create') {
      const options = { ...(q.options || {}) };
      if (options.autoRun !== undefined && typeof options.autoRun !== 'boolean') delete options.autoRun;
      const request = { id: q.id, network: q.network, action: q.action, nodes: q.nodes || [], components: q.components || [], images: q.images || {}, options, ...(q.devnet ? { devnet: q.devnet } : {}), ...(q.services ? { services: q.services } : {}), ...(q.confirmName ? { confirmName: q.confirmName } : {}) };
      let r = { id: q.id, network: q.network, actor, createdAt: new Date().toISOString(), request, status: 'queued', steps: [] };
      if (existsSync(recordPath(q.id))) throw new Error('duplicate request id');
      try { validateRequest(s, request, devnets.registry()); } catch (e) { r = { ...r, status: 'rejected', error: e.message }; }
      save(r); write(r.id, `requested by ${actor.login}: ${request.action} ${request.nodes.join(',')} ${request.components.join(',')} ${Object.values(request.images).join(' ')}`);
      return;
    }
    const r = UUID.test(q.id || '') ? load(q.id) : null;
    if (!r || r.network !== q.network) throw new Error('unknown operation');
    if (live.has(r.id) && q.type !== 'cancel') throw new Error('operation is running; cancel it first');
    if (q.type === 'confirm') {
      if (r.status !== 'review' || q.planId !== r.review?.planId) throw new Error('plan changed or not awaiting review');
      if (Date.now() - Date.parse(r.review.preparedAt) > 60 * 60_000) { r.status = 'failed'; r.error = 'review expired after 60 minutes; prepare again'; save(r); return; }
      r.status = 'confirmed'; r.confirmedBy = actor; r.confirmedAt = new Date().toISOString(); save(r);
      write(r.id, `confirmed by ${actor.login}: plan ${r.review.planId}`);
    } else if (q.type === 'cancel') {
      const active = running.get(r.network);
      const mine = live.get(r.id);
      if (active?.id === r.id && mine) {
        // The running copy owns the record: flag it there so the next save keeps it.
        mine.cancelRequested = true; save(mine); write(r.id, `cancel requested by ${actor.login}`);
        active.child?.kill('SIGTERM');
      } else if (['queued', 'review', 'confirmed'].includes(r.status)) {
        r.status = 'cancelled'; save(r); write(r.id, `cancelled by ${actor.login}`);
        if (r.request.action === 'devnet-platform') devnets.markPlatformFailed?.(r.network);
      }
    } else if (q.type === 'resume') {
      if (!['failed', 'interrupted', 'cancelled'].includes(r.status)) throw new Error('only a stopped operation can be resumed');
      // Never confirmed: prepare a fresh plan. Confirmed: continue the exact reviewed plan.
      if (!r.confirmedAt) {
        // Nothing reviewed survives: stage results, anchors and targets are retaken.
        Object.assign(r, { status: 'queued', steps: [], review: undefined, stages: undefined, anchor: undefined, targets: undefined, execId: `${r.id}.${Date.now()}` });
      }
      else r.status = 'confirmed';
      r.error = undefined; save(r); write(r.id, `resume requested by ${actor.login}`);
    }
  }

  // SIGTERM each running dashnet and wait, so it journals its state and
  // releases its claim instead of being killed mid-step.
  async function shutdown(ms = 25_000) {
    shuttingDown = true;
    const children = [...running.values()].map((x) => x.child).filter(Boolean);
    for (const c of children) c.kill('SIGTERM');
    await Promise.race([Promise.all(children.map((c) => new Promise((res) => (c.exitCode !== null ? res() : c.once('close', res))))), new Promise((res) => setTimeout(res, ms))]);
  }
  return { tick, running, isTerminal: (s) => TERMINAL.has(s), manifestFor, devnets, shutdown };
}

export function toMs(d) {
  const m = /^(\d+)(s|m|h)$/.exec(d);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
}
// A week at most: longer is a typo, and Node timers top out near 24.8 days.
const MAX_BUDGET_MS = 7 * 24 * 3_600_000;
export function operationBudget(perNode, nodes) {
  const ms = Math.min(MAX_BUDGET_MS, toMs(perNode) * Math.max(1, nodes || 1));
  return { ms, flag: ms % 60_000 ? `${Math.ceil(ms / 1000)}s` : `${ms / 60_000}m` };
}
