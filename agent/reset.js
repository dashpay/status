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
import { mapLimit } from './collector.js';

const SCRIPT = readFileSync(new URL('./reset-remote.py', import.meta.url), 'utf8');
const IMAGE = { drive: /^(docker\.io\/)?dashpay\/drive(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/, dapi: /^(docker\.io\/)?dashpay\/rs-dapi(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/, tenderdash: /^(docker\.io\/)?dashpay\/tenderdash(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/ };

export function validateReset(settings, q) {
  const n = settings.networks.find((x) => x.name === q.network);
  if (!n || n.chainType !== 'devnet' || n.kind === 'dashnet') throw new Error('Platform reset applies to dashmate-managed devnets');
  const images = q.images || {};
  for (const k of ['drive', 'dapi', 'tenderdash']) if (!IMAGE[k].test(images[k] || '')) throw new Error(`${k}: image must be ${k === 'dapi' ? 'dashpay/rs-dapi' : `dashpay/${k}`}:<tag>`);
  const epoch = q.options?.epochSeconds ?? 3600;
  if (!Number.isInteger(epoch) || epoch < 60 || epoch > 86400 * 30) throw new Error('epoch length 60 s .. 30 days');
  return { network: n, images, epoch };
}

export function createReset({ ctx, dirs, pool, getSettings }) {
  const { step, save, write } = ctx;

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
      if (r.stages[name][h.name]?.ok && name !== 'verify') return r.stages[name][h.name];
      const q = Buffer.from(JSON.stringify({ ...base, role: h.resetRole, address: h.publicIp })).toString('base64');
      let v;
      try { v = JSON.parse((await pool.exec(h, `sudo -n python3 - ${name} ${q}`, SCRIPT, timeoutMs)).trim().split('\n').pop()); }
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
    const { network, epoch } = validateReset(getSettings(), r.request);
    r.epoch = epoch; r.coreChain = network.coreNetwork;
    r.status = 'preparing'; save(r);
    const all = targets(r.network);
    const hpmns = all.filter((h) => h.resetRole === 'hpmn'), seeds = all.filter((h) => h.resetRole === 'seed');
    if (!hpmns.length) throw new Error('no HPMNs discovered for this network');
    const unreachable = all.filter((h) => h.state !== 'running' || !h.probe?.ok).map((h) => h.name);
    if (unreachable.length) throw new Error(`not reachable by the agent: ${unreachable.join(', ')}`);
    r.targets = all.map((h) => ({ name: h.name, role: h.resetRole, ip: h.publicIp }));
    const base = await barrier(r, `Baseline ${all.length} targets: Core, READY, backups, hashes`, 'baseline', all);
    await barrier(r, 'Pull images on every target', 'stage', all);
    const done = step(r, 'Fresh ChainLock anchor');
    const a = (await stage(r, 'anchor', [hpmns[0]])).results[0];
    if (!a.ok) { done('failed', a.error); throw new Error(`anchor: ${a.error}`); }
    r.anchor = a.result; save(r);
    done('ok', `height ${a.result.height}`);
    await barrier(r, 'Anchor block known on every target', 'anchor-check', all, { anchorHeight: r.anchor.height, anchorHash: r.anchor.hash });
    const canary = (await barrier(r, `Non-destructive configuration canary on ${hpmns[0].name}`, 'canary', [hpmns[0]], { anchorHeight: r.anchor.height }))[0];
    const hb = base.filter((_, i) => all[i].resetRole === 'hpmn').map((x) => x.result);
    const sb = base.filter((_, i) => all[i].resetRole === 'seed').map((x) => x.result);
    const uniq = (xs) => [...new Set(xs.map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x));
    r.review = {
      kind: 'platform-reset', planId: `reset-${r.id}-${r.anchor.height}`, preparedAt: new Date().toISOString(), coreChain: network.coreNetwork,
      targets: r.targets, hpmns: hpmns.length, seeds: seeds.length, anchor: r.anchor, previousAnchor: uniq(hb.map((x) => x.anchor)),
      current: uniq(hb.map((x) => x.images)), next: r.request.images, epoch: { current: uniq(hb.map((x) => x.epochTime)), next: epoch },
      dashmate: uniq(hb.map((x) => x.dashmate)), configFormat: uniq(hb.map((x) => x.configFormatVersion)), tor: uniq(hb.map((x) => x.tor?.enabled)),
      seedImages: uniq(sb.map((x) => x.tenderdashImage)), canary: canary.result.checks, rendered: canary.result.rendered,
      coreHeight: Math.max(...hb.map((x) => x.height)),
    };
  }

  async function executeReset(r) {
    const all = targets(r.network).filter((h) => r.targets.some((t) => t.name === h.name));
    if (all.length !== r.targets.length) throw new Error(`targets changed since review: expected ${r.targets.map((t) => t.name).join(', ')}`);
    const hpmns = all.filter((h) => h.resetRole === 'hpmn'), seeds = all.filter((h) => h.resetRole === 'seed');
    const anchor = { anchorHeight: r.anchor.height, anchorHash: r.anchor.hash };
    r.status = 'running'; r.progress = { phase: 'wipe', completed: [], current: null }; save(r);
    await barrier(r, `Wipe Platform on ${hpmns.length} HPMNs (dashmate reset --platform --force)`, 'wipe', hpmns);
    if (seeds.length) await barrier(r, 'Reset seed Tenderdash data only', 'wipe', seeds);
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
    done('ok', `consensus height ${r.result.consensusHeight}`);
  }

  return { prepareReset, executeReset };
}
