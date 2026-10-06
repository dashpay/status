// Platform wipe/redeploy for dashmate devnets (the Moutai rulebook):
//
//   prepare:  baseline -> stage images -> fresh ChainLock anchor -> anchor check -> canary
//   -- operator reviews versions, anchor, canary and targets, then confirms --
//   execute:  wipe all HPMNs -> reset seed Tenderdash data -> apply -> start -> verify
//
// Core chain, wallets, masternode registrations, identities and certificates
// are preserved. Every stage runs on every target and must succeed on all of
// them before the next stage; missing or unreachable hosts are failures.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readJSON, writeAtomic } from '../shared/settings.js';
import { createResetJournal, RESET_COMPONENTS } from './reset-journal.js';
import { resetSidecars, sidecarsFor } from './reset-images.js';
import { mapLimit } from './collector.js';

const NATIVE_SCRIPT = readFileSync(new URL('./reset-dashnet.py', import.meta.url), 'utf8');
const SCRIPT = readFileSync(new URL('./reset-remote.py', import.meta.url), 'utf8');
const REPOS = { drive:'drive', dapi:'rs-dapi', tenderdash:'tenderdash', gateway:'envoy', helper:'dashmate-helper' };
const IMAGE = Object.fromEntries(Object.entries(REPOS).map(([c, repo]) => [c, new RegExp(`^((index\\.)?docker\\.io/)?dashpay/${repo}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$`)]));

export function validateReset(settings, q) {
  const n = settings.networks.find((x) => x.name === q.network);
  if (!n || n.chainType !== 'devnet' || n.kind === 'external') throw new Error('Platform reset applies to dashmate-managed devnets');
  if (n.kind === 'dashnet') {
    if (q.options?.epochSeconds != null) throw new Error('native reset preserves epoch settings');
    const images = q.images || {};
    for (const [c, ref] of Object.entries(images)) if (!RESET_COMPONENTS.includes(c) || !IMAGE[c].test(ref)) throw Error(`${c}: invalid Platform image reference`);
    return { network:n, images, epoch:null };
  }
  const images = q.images || {};
  for (const k of ['drive', 'dapi', 'tenderdash']) if (!IMAGE[k].test(images[k] || '')) throw new Error(`${k}: image must be ${k === 'dapi' ? 'dashpay/rs-dapi' : `dashpay/${k}`}:<tag>`);
  const epoch = q.options?.epochSeconds ?? 3600;
  if (!Number.isInteger(epoch) || epoch < 60 || epoch > 86400 * 30) throw new Error('epoch length 60 s .. 30 days');
  return { network: n, images, epoch };
}

export function createReset({ ctx, dirs, pool, getSettings, journalImpl, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const { step, save, write } = ctx;
  const journal = journalImpl || createResetJournal({ dirs, ctx });

  function targets(network) {
    const state = readJSON(join(dirs.state, `${network}.json`));
    const hosts = (state?.hosts || []).filter((h) => ['validator', 'seed'].includes(h.role) && !h.duplicate);
    return hosts.map((h) => ({ ...h, resetRole: h.role === 'validator' ? 'hpmn' : 'seed' }));
  }

  async function stage(r, name, hosts, extra = {}, { parallel = 8, timeoutMs = 20 * 60_000 } = {}) {
    const dir = join(dirs.private, 'resets', r.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A re-prepare gets a new execution id, so the baseline is retaken.
    const base = { config: r.network, exec: r.execId || r.id, coreChain: r.review?.coreChain || r.coreChain, images: r.request.images, epochSeconds: r.epoch, ...extra };
    r.stages ??= {};
    r.stages[name] ??= {};
    const results = await mapLimit(hosts, parallel, async (h) => {
      if (r.stages[name][h.name]?.ok && !['verify', 'mining-pause', 'mining-resume'].includes(name)) return r.stages[name][h.name];
      const q = Buffer.from(JSON.stringify({ ...base, ...(r.native ? { images:r.nativeImages?.[h.name], architecture:r.nativeArchitectures?.[h.name], sidecars:r.nativeSidecars?.[h.name], transition:r.nativeTransitions?.[h.name] } : {}), role: h.resetRole, address: h.publicIp, node: h.name })).toString('base64');
      let v;
      try { v = JSON.parse((await pool.exec(h, `sudo -n python3 - ${name} ${q}`, r.native ? NATIVE_SCRIPT : SCRIPT, timeoutMs)).trim().split('\n').pop()); }
      catch (e) { v = { ok: false, stage: name, error: `unreachable or no result: ${e.message.slice(0, 200)}` }; }
      writeAtomic(join(dir, `${name}.${h.name}.json`), JSON.stringify(v), 0o600);
      // Record each host as it finishes, so a resume skips hosts that completed.
      r.stages[name][h.name] = v; save(r);
      write(r.id, `${name} ${h.name}: ${v.ok ? 'ok' : `FAILED ${v.error || (v.result?.problems || []).join('; ')}`}`);
      return v;
    });
    hosts.forEach((h, i) => { r.stages[name][h.name] = results[i]; });
    save(r);
    const failed = hosts.filter((h, i) => !results[i].ok).map((h) => h.name);
    return { results, failed };
  }

  async function barrier(r, label, name, hosts, extra, opts) {
    const done = step(r, label);
    const { results, failed } = await stage(r, name, hosts, extra, opts);
    if (failed.length) { done('failed', `${failed.length}/${hosts.length} failed: ${failed.join(', ')}`); throw new Error(`${name} failed on ${failed.join(', ')}; nothing further was run`); }
    done('ok', `${hosts.length}/${hosts.length}`);
    return results;
  }

  async function prepareReset(r) {
    const { network, epoch, images } = validateReset(getSettings(), r.request);
    r.native = network.kind === 'dashnet';
    r.epoch = epoch; r.coreChain = network.coreNetwork;
    r.status = 'preparing'; save(r);
    const all = targets(r.network);
    const hpmns = all.filter((h) => h.resetRole === 'hpmn'), seeds = all.filter((h) => h.resetRole === 'seed');
    if (!hpmns.length) throw new Error('no HPMNs discovered for this network');
    let nativePlan;
    if (r.native) {
      const plan = readJSON(join(dirs.private, 'devnets', r.network, 'deployment.json'));
      const expected = plan?.targets?.filter((t) => t.role === 'validator') || [];
      if (!expected.length || seeds.length || expected.length !== hpmns.length || expected.some((t) => !hpmns.some((h) => h.name === t.name && h.instanceId === t.instanceId && h.publicIp === t.sshAddress))) throw new Error('discovered reset targets do not match the dashnet deployment');
    }
    if (r.native) nativePlan = await journal.prepare(r, images);
    const unreachable = all.filter((h) => h.state !== 'running' || !h.probe?.ok).map((h) => h.name);
    if (unreachable.length) throw new Error(`not reachable by the agent: ${unreachable.join(', ')}`);
    r.targets = all.map((h) => ({ name: h.name, role: h.resetRole, ip: h.publicIp, instanceId: h.instanceId }));
    const base = await barrier(r, `Baseline ${all.length} targets: Core, READY, backups, hashes`, 'baseline', all);
    if (r.native && new Set(base.map((x) => x.result.epochTime)).size !== 1) throw new Error('dashnet validators have inconsistent epoch settings');
    await barrier(r, 'Pull reviewed target images on every validator', 'stage', all);
    const done = step(r, 'Fresh ChainLock anchor');
    const a = (await stage(r, 'anchor', [hpmns[0]])).results[0];
    if (!a.ok) { done('failed', a.error); throw new Error(`anchor: ${a.error}`); }
    r.anchor = a.result; save(r);
    done('ok', `height ${a.result.height}`);
    await barrier(r, 'Anchor block known on every target', 'anchor-check', all, { anchorHeight: r.anchor.height, anchorHash: r.anchor.hash });
    let observed, sidecars;
    if (r.native) {
      const others = nativePlan.targets.filter((t) => t.role !== 'validator').map((t) => ({ name:t.name, instanceId:t.instanceId, publicIp:t.sshAddress, resetRole:t.role }));
      const extra = await barrier(r, 'Observe preserved wallet Core for native journal', 'journal-baseline', others);
      observed = Object.fromEntries([...all.map((h,i) => [h.name,base[i].result.journal]), ...others.map((h,i) => [h.name,extra[i].result])]);
      const releases = await barrier(r, 'Render target release in isolation and discover sidecars', 'release', hpmns, { anchorHeight:r.anchor.height });
      const requests = releases[0].result.sidecars;
      if (releases.some((x) => JSON.stringify(Object.entries(x.result.sidecars).sort()) !== JSON.stringify(Object.entries(requests).sort()))) throw Error('target helpers disagree on sidecar requests');
      const original = journal.original(r);
      sidecars = await resetSidecars(original.runtime?.sidecars || original.deployment.sidecars || [], requests, [...new Set(Object.values(r.nativeArchitectures))].sort());
      r.nativeSidecars = Object.fromEntries(hpmns.map((h) => [h.name, sidecarsFor(sidecars, r.nativeArchitectures[h.name])]));
    }
    const canaries = await barrier(r, `Non-destructive configuration canary on ${r.native ? 'every validator' : hpmns[0].name}`, 'canary', r.native ? hpmns : [hpmns[0]], { anchorHeight: r.anchor.height });
    const canary = canaries[0];
    if (r.native) {
      r.coreMigrations = Object.fromEntries(hpmns.map((h,i) => [h.name, canaries[i].result.checks.coreMigration || []]));
      if (Object.values(r.coreMigrations).some((c) => c.length)) {
        const miners = nativePlan.targets.filter((t) => t.role === 'miner' || t.role === 'wallet');
        if (miners.length !== 1) throw Error('automatic Core migration requires one identified native mining host');
        const t = miners[0];
        r.minerTarget = { name:t.name, instanceId:t.instanceId, publicIp:t.sshAddress, resetRole:t.role };
        const [ready] = await barrier(r, 'Check automatic mining pause/recovery for Core migration', 'migration-ready', [r.minerTarget]);
        r.expectedMiner = ready.result.minerId;
      }
    }
    if (r.native) journal.seal(r, observed, sidecars);
    const hb = base.filter((_, i) => all[i].resetRole === 'hpmn').map((x) => x.result);
    const sb = base.filter((_, i) => all[i].resetRole === 'seed').map((x) => x.result);
    const uniq = (xs) => [...new Set(xs.map((x) => JSON.stringify(x ?? null)))].map((x) => JSON.parse(x));
    r.review = {
      kind: 'platform-reset', planId: `reset-${r.id}-${r.anchor.height}`, preparedAt: new Date().toISOString(), coreChain: network.coreNetwork,
      targets: r.targets, hpmns: hpmns.length, seeds: seeds.length, anchor: r.anchor, previousAnchor: uniq(hb.map((x) => x.anchor)),
      native: r.native, coreMigrations: r.coreMigrations, targetImages: r.nativeImages, requested: r.resolvedChoices, current: uniq(hb.map((x) => x.images)), next: r.native ? r.nativeImages[hpmns[0].name] : r.request.images, epoch: { current: uniq(hb.map((x) => x.epochTime)), next: r.native ? hb[0].epochTime : epoch },
      dashmate: uniq(hb.map((x) => x.dashmate)), configFormat: uniq(hb.map((x) => x.configFormatVersion)), tor: uniq(hb.map((x) => x.tor?.enabled)),
      seedImages: uniq(sb.map((x) => x.tenderdashImage)), canary: canary.result.checks, rendered: canary.result.rendered,
      coreHeight: Math.max(...hb.map((x) => x.height)),
    };
  }

  async function executeReset(r) {
    const discovered = targets(r.network);
    const all = r.native ? discovered : discovered.filter((h) => r.targets.some((t) => t.name === h.name));
    if (all.length !== r.targets.length || all.some((h) => !r.targets.some((t) => t.name === h.name && t.ip === h.publicIp && (!t.instanceId || t.instanceId === h.instanceId) && t.role === h.resetRole))) throw new Error(`targets changed since review: expected ${r.targets.map((t) => t.name).join(', ')}`);
    const hpmns = all.filter((h) => h.resetRole === 'hpmn'), seeds = all.filter((h) => h.resetRole === 'seed');
    const anchor = { anchorHeight: r.anchor.height, anchorHash: r.anchor.hash };
    r.status = 'running'; r.progress = { phase: 'wipe', completed: [], current: null }; save(r);
    if (r.native) {
      await journal.begin(r);
      // Fresh check on every host before the first destructive command.
      delete r.stages.prewipe;
      await barrier(r, 'Recheck reviewed files, images and preservation on all targets', 'prewipe', hpmns);
    }
    await barrier(r, `Wipe Platform on ${hpmns.length} HPMNs (${r.native ? 'dashnet Platform data volumes only' : 'dashmate reset --platform --force'})`, 'wipe', hpmns);
    if (seeds.length) await barrier(r, 'Reset seed Tenderdash data only', 'wipe', seeds);
    if (r.native) {
      const migrations = hpmns.filter((h) => r.coreMigrations?.[h.name]?.length);
      r.progress.phase = 'core-migration'; save(r);
      for (const h of migrations) {
        if (r.stages['core-migrate']?.[h.name]?.ok) continue;
        const done = step(r, `Automatic Core configuration migration on ${h.name}; chain and wallets preserved`);
        let migrationError;
        try {
          const deadline = Date.now() + 10 * 60_000;
          for (;;) {
            if (r.cancelRequested) throw Error('cancelled by operator');
            const paused = await stage(r, 'mining-pause', [r.minerTarget], { expectedMiner:r.expectedMiner }, { timeoutMs:90_000 });
            if (paused.failed.length) throw Error('mining pause failed; Core was not migrated');
            if (paused.results[0].result.quiet) break;
            if (Date.now() >= deadline) throw Error('no quiet DKG window for Core migration');
            await wait(5000);
          }
          const migrated = await stage(r, 'core-migrate', [h], {}, { timeoutMs:11 * 60_000 });
          if (migrated.failed.length) throw Error(`Core migration failed on ${h.name}; Resume continues the same migration`);
          r.nativeTransitions[h.name].preserve = migrated.results[0].result.journal.preservation;
          save(r);
          done('ok', 'Core READY, synchronized, quorum links reconnected; data and identities preserved');
        } catch (error) {
          done('failed', error.message); migrationError = error;
        } finally {
          // Cleanup bypasses cancellation and stage caches. An independent
          // host timer also resumes mining after a killed/lost controller.
          const resumed = await stage(r, 'mining-resume', [r.minerTarget], { expectedMiner:r.expectedMiner }, { timeoutMs:90_000 });
          if (resumed.failed.length) migrationError = Error('mining resume unverified; recovery timer is armed; Resume retries cleanup');
        }
        if (migrationError) throw migrationError;
      }
      // Includes a resume after a lost cleanup response on the last node.
      if (migrations.length) {
        const resumed = await stage(r, 'mining-resume', [r.minerTarget], { expectedMiner:r.expectedMiner }, { timeoutMs:90_000 });
        if (resumed.failed.length) throw Error('mining must be resumed before Platform startup');
      }
    }
    r.progress.phase = 'apply'; save(r);
    await barrier(r, 'Apply images, anchor and epoch; render Platform files only', 'apply', all, anchor);
    r.progress.phase = 'start'; save(r);
    if (seeds.length) await barrier(r, 'Start seed Tenderdash', 'start', seeds);
    await barrier(r, `Start Platform on ${hpmns.length} HPMNs`, 'start', hpmns, {}, { parallel: 13 });
    r.progress.phase = 'verify'; save(r);
    const done = step(r, 'Verify: READY, containers, consensus, epochs, DAPI TLS, Core preserved');
    const deadline = Date.now() + 25 * 60_000;
    let failed = [];
    for (let attempt = 1; ; attempt++) {
      ({ failed } = await stage(r, 'verify', all, anchor));
      r.progress.completed = all.filter((h) => !failed.includes(h.name)).map((h) => h.name); save(r);
      if (!failed.length || Date.now() > deadline) break;
      write(r.id, `verify attempt ${attempt}: waiting on ${failed.join(', ')}`);
      await new Promise((res) => setTimeout(res, 30_000));
    }
    if (failed.length) { done('failed', `${failed.length} target(s) not verified: ${failed.join(', ')}`); throw new Error(`verification failed on ${failed.join(', ')}; logs and backups are preserved, recover those hosts individually`); }
    const v = Object.values(r.stages.verify).map((x) => x.result).filter((x) => x.consensus);
    r.result = { healthy: true, consensusHeight: Math.max(...v.map((x) => x.consensus.height)), epochs: v[0]?.epochs, restarts: Object.fromEntries(Object.entries(r.stages.verify).filter(([, x]) => Object.keys(x.result?.restarts || {}).length).map(([k, x]) => [k, x.result.restarts])) };
    if (r.native) {
      const plan = readJSON(join(dirs.private, 'devnets', r.network, 'deployment.json'));
      const receiptHosts = plan.targets.map((t) => ({ name:t.name, instanceId:t.instanceId, publicIp:t.sshAddress, resetRole:t.role }));
      await barrier(r, 'Commit verified native host version receipts', 'journal-commit', receiptHosts);
      await journal.complete(r);
    }
    done('ok', `consensus height ${r.result.consensusHeight}`);
  }

  return { prepareReset, executeReset };
}
