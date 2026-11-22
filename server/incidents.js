// Machine-readable, read-only issue derivation. Evidence is data, never commands.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateNetwork, explorerReadiness } from '../shared/evaluate.js';
import { expectations } from '../shared/monitoring.js';
import { readJSON, writeAtomic } from '../shared/settings.js';
import { dynamoScaleInControl } from '../shared/aws-alarm-semantics.js';
import { activityKey } from './change-activity.js';

export const issueId = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
const iso = (now) => new Date(now).toISOString();
const fresh = (at, now, max) => Number.isFinite(Date.parse(at)) && now - Date.parse(at) <= max && Date.parse(at) <= now + 60_000;
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const height = (v) => Number.isSafeInteger(v) && v > 0;
const text = (v) => typeof v === 'string' && v.length > 0;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => Array.isArray(v) ? v.filter(object) : [];
const pct = (used, total) => num(used) && num(total) && total > 0 && used <= total ? used / total * 100 : null;
const faultKey = (rule, subject = '') => JSON.stringify([rule, subject]);

// Classify evaluator facts, not changing measurements/error prose. Unknown
// facts remain actionable but cannot be cleared without a recognized proof.
function classify(text) {
  const subjects = [
    [/^disk (.+) [\d.]+%$/, 'disk'], [/^wallet (.+) balance /, 'wallet'],
    [/^container (\S+) /, 'container'], [/^P2P :(\d+) /, 'p2p'],
    [/^(.+) functional health check failed$/, 'service'], [/^(.+) has \d+ failing scrape targets$/, 'scrapes'],
  ];
  for (const [pattern, rule] of subjects) { const match = pattern.exec(text); if (match) return faultKey(rule, match[1]); }
  const rules = [
    [/^(probe failed:|host observation is stale)/, 'probe'],
    [/^(Core RPC not answering|no Dash services running)/, 'core_rpc'], [/^Core on chain /, 'core_chain'],
    [/^Core initial sync /, 'core_sync'], [/^Core \d+ blocks behind/, 'core_lag'], [/^Core headers /, 'core_headers'],
    [/^ChainLock older/, 'chainlock_age'], [/^ChainLock is behind/, 'chainlock_lag'], [/^DKG session/, 'dkg'],
    [/^no outbound Core peers/, 'peers'], [/^masternode sync/, 'mn_sync'], [/^masternode /, 'mn_ready'], [/^PoSe penalty/, 'pose'],
    [/^Tenderdash RPC/, 'platform_rpc'], [/^Tenderdash catching/, 'platform_sync'], [/^Platform \d+ blocks behind/, 'platform_lag'],
    [/^DAPI getStatus/, 'dapi'], [/^DAPI Drive epoch/, 'dapi_query'], [/^DAPI epoch and consensus protocol/, 'protocol'],
    [/^DAPI and consensus chain/, 'chain_ids'], [/^DAPI :443/, 'dapi_public'], [/^gateway certificate/, 'tls'],
    [/^consensus round /, 'consensus_round'], [/^memory /, 'memory'], [/^Insight block\/transaction/, 'insight_query'], [/^Insight /, 'insight'],
    [/^legacy faucet queue unavailable/, 'faucet_queue'], [/^legacy faucet has requests queued/, 'faucet_wait'], [/^CoinJoin /, 'coinjoin'],
    [/^Core height unchanged/, 'core_progress'], [/^Platform height unchanged/, 'platform_progress'],
    [/^faucet balance /, 'faucet_balance'], [/^faucet /, 'faucet_http'],
    [/^quorum server /, 'quorums'], [/^explorer API /, 'explorer_api'], [/^explorer indexer (not running|restarting|unhealthy|health check)/, 'explorer_runtime'],
    [/^explorer (indexing heights|indexed height)/, 'explorer_heights'], [/^explorer indexer \d+ blocks behind/, 'explorer_lag'],
    [/^mainnet /, 'mainnet'], [/^running images differ/, 'images'],
  ];
  for (const [pattern, rule] of rules) if (pattern.test(text)) return faultKey(rule);
  return faultKey('unclassified', text.slice(0, 300));
}

function hostProofs(row, network, settings, coreTip, platformTip, now) {
  const h = row.host, d = row.data, c = d.core || {}, td = d.tenderdash || {}, t = settings.thresholds;
  const proofs = new Set();
  const prove = (rule, ok, subject = '') => { if (ok === true) proofs.add(faultKey(rule, subject)); };
  prove('probe', h.probe?.ok === true && object(h.probe.data) && !h.probe.skipped);
  prove('core_rpc', height(c.blocks) && text(c.chain));
  prove('core_chain', c.chain === network.coreNetwork || (network.chainType === 'devnet' && c.chain === 'devnet'));
  prove('core_sync', c.ibd === false); prove('core_lag', height(c.blocks) && coreTip > 0 && coreTip - c.blocks <= t.coreLagBlocks);
  prove('core_headers', height(c.blocks) && height(c.headers) && c.headers >= c.blocks && c.headers - c.blocks <= t.coreLagBlocks);
  prove('chainlock_age', c.ibd === false && num(c.chainLockTime) && c.chainLockTime > 0 && c.chainLockTime <= now / 1000 + 60 && now / 1000 - c.chainLockTime <= 1800);
  prove('chainlock_lag', height(c.blocks) && height(c.chainLockHeight) && c.chainLockHeight <= c.blocks && c.blocks - c.chainLockHeight <= Math.max(t.coreLagBlocks, 6));
  prove('dkg', Array.isArray(c.dkg) && c.dkg.length > 0 && c.dkg.every((v) => v.aborted === false));
  prove('peers', height(c.peerDiversity?.outbound)); prove('mn_sync', c.synced === true);
  prove('mn_ready', c.masternode?.state === 'READY'); prove('pose', c.masternode?.posePenalty === 0);
  for (const w of list(c.wallets)) prove('wallet', num(w.trusted) && w.trusted >= t.balanceWarn, w.name);
  prove('platform_rpc', height(td.height) && text(td.network)); prove('platform_sync', td.catchingUp === false);
  prove('platform_lag', height(td.height) && platformTip > 0 && platformTip - td.height <= t.platformLagBlocks);
  prove('dapi', d.dapi?.ok === true); prove('dapi_query', d.dapi?.query?.ok === true);
  prove('protocol', height(d.dapi?.query?.protocol) && height(td.protocolApp) && d.dapi.query.protocol === td.protocolApp);
  prove('chain_ids', text(d.dapi?.chainId) && text(td.network) && d.dapi.chainId === td.network);
  prove('consensus_round', Number.isSafeInteger(td.round) && td.round >= 0 && td.round <= 5);
  prove('dapi_public', h.dapiPublic?.ok === true); prove('p2p', h.p2p?.ok === true, String(h.p2p?.port));
  prove('tls', d.dapi?.tls?.trusted === true && d.dapi.tls.expired !== true && Date.parse(d.dapi.tls.expiresAt) - now >= 36 * 3600_000);
  for (const k of list(d.containers)) {
    const completed = k.oneShot === true && k.state === 'exited' && k.exitCode === 0 && k.restartPolicy === 'no' && !k.restarting;
    const replacement = !k.oneShot && text(k.repo) && list(d.containers).some((v) => v !== k && v.running === true && v.state === 'running'
      && !v.restarting && v.health !== 'unhealthy' && v.health !== 'starting' && v.repo === k.repo && (k.service ? k.service === v.service : !v.service));
    prove('container', completed || replacement || (k.running === true && k.state === 'running' && !k.restarting && k.health !== 'unhealthy' && k.health !== 'starting'), k.name);
  }
  for (const disk of list(d.system?.disks)) {
    const used = pct(disk.used, disk.size); prove('disk', used !== null && used < t.diskWarnPercent, disk.mount);
  }
  const mem = num(d.system?.memAvailable) ? pct(d.system.memTotal - d.system.memAvailable, d.system.memTotal) : null;
  prove('memory', mem !== null && mem < t.memWarnPercent);
  prove('insight', d.insight?.syncStatus === 'finished' && height(d.insight.blocks) && coreTip > 0 && coreTip - d.insight.blocks <= t.coreLagBlocks);
  prove('insight_query', d.insight?.query?.ok === true); prove('faucet_queue', d.faucet?.queue?.ok === true);
  const q = d.faucet?.queue;
  prove('faucet_wait', q?.ok === true && (q.queued === 0 || (height(q.queued) && num(q.oldestQueuedAt) && q.oldestQueuedAt <= now / 1000 + 60 && now / 1000 - q.oldestQueuedAt <= 3600)));
  prove('coinjoin', c.coinjoin?.enabled === true && c.coinjoin.running === true);
  for (const service of list(d.services)) { prove('service', service.ok === true, service.service); prove('scrapes', service.ok === true && service.down === 0, service.service); }
  for (const chain of ['core', 'platform']) prove(`${chain}_progress`, h.observation?.continuous === true && height(h.observation[chain]?.blocks) && h.observation[chain]?.stalledSeconds === 0);
  prove('faucet_balance', d.faucet?.kind === 'dash-faucet' && d.faucet.status === 200 && d.faucet.state === 'ok');
  prove('faucet_http', d.faucet?.status === 200);
  prove('quorums', d.quorumServer?.status === 200 && height(d.quorumServer.quorums));
  const m = d.mainnet;
  prove('mainnet', object(m) && height(m.chainLockHeight) && num(m.chainLockAgeSeconds) && m.chainLockAgeSeconds <= 1800 && height(m.platformHeight)
    && num(m.bigBans) && num(m.newBans) && m.newBans < (network.mainnetSignals?.bigBanThreshold || 20)
    && m.platformSyncing === false && m.coreStall === false && m.platformStall === false && m.quorumServer?.status === 200 && height(m.quorumServer.quorums) && height(m.quorumServer.listed));
  prove('images', row.convergence?.length > 0 && row.convergence.every((v) => v.status === 'matched'));
  return [...proofs];
}
export const TITLES = {
  platform_release_compatibility: 'Platform release compatibility check and dash-network-go fix',
  core_release_compatibility: 'Dash Core release compatibility check and dash-network-go fix',
  tenderdash_release_compatibility: 'Tenderdash release compatibility check and dash-network-go fix',
  collector_stale: 'Network observations missing or stale', discovery_failed: 'Network discovery incomplete',
  host_health: 'Network host health check failed', endpoint_failed: 'Network endpoint check failed',
  reporter_missing: 'CI reporter has never reported', reporter_stale: 'CI reporter stopped reporting',
  runner_offline: 'CI runner unavailable', disk_pressure: 'Disk space pressure', memory_pressure: 'Memory pressure',
  queue_stale: 'CI queue observation missing or stale', queue_wait: 'Self-hosted CI job waiting over 15 minutes', job_failed: 'CI job failed',
  aws_stale: 'AWS inventory missing or stale', aws_collection_failed: 'AWS collection incomplete',
  aws_instance_impaired: 'EC2 status check failed', aws_alarm: 'CloudWatch alarm is active', aws_scaling_control: 'Scale-in control alarm (informational)',
  aws_health_missing: 'AWS runtime health collection unavailable', aws_scheduled_event: 'EC2 scheduled maintenance event', idle_volume: 'Unattached EBS volume requires ownership review',
  idle_address: 'Unassociated public address requires ownership review',
};

// A case that can never be proven recovered must still end. These periods say
// when: they close the case, they do not claim the fault was repaired.
export const JOB_FAILED_MAX_AGE_MS = 24 * 3600_000; // the producer sees finished jobs for a day
export const QUEUE_WAIT_UNSEEN_MS = 24 * 3600_000; // GitHub itself gives up on a job queued for a day
export const GONE_AFTER_MS = 10 * 60_000; // a target missing from complete inventories this long is gone
export const QUIET_SAMPLES = 10; // healthy samples before a host fault with no proof of its own is dropped

// settings.remediation.ignoredCiJobs: jobs whose failure is a verdict on the
// change under test (title lint, milestone, review bots), not a CI fault. Each
// entry names at least a workflow or a job; every field given must match. `*`
// matches any run of characters; case is ignored. A field the job record does
// not carry never matches, so an old record cannot be ignored by accident.
const IGNORE_FIELDS = ['repo', 'workflow', 'job', 'event', 'branch'];
export function validIgnoredCiJobs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new Error('remediation.ignoredCiJobs must be a list of at most 200 entries');
  for (const e of value) {
    if (!object(e) || Object.keys(e).some((k) => ![...IGNORE_FIELDS, 'note'].includes(k))) throw new Error(`remediation.ignoredCiJobs entries take ${IGNORE_FIELDS.join(', ')} and note`);
    for (const k of [...IGNORE_FIELDS, 'note']) if (e[k] !== undefined && (typeof e[k] !== 'string' || !e[k].trim() || e[k].length > 300)) throw new Error(`remediation.ignoredCiJobs: ${k} must be a non-empty string`);
    if (e.workflow === undefined && e.job === undefined) throw new Error('remediation.ignoredCiJobs: each entry needs a workflow or a job');
  }
  return value;
}
// Whole-string match, case ignored, `*` for any run of characters. Two pointers
// that fall back to the last `*` only: the time is bounded by pattern × text,
// whatever a rule looks like. Not a regular expression on purpose.
export function wildcard(pattern, value) {
  const p = pattern.trim().toLowerCase(), s = value.toLowerCase();
  let i = 0, j = 0, star = -1, mark = 0;
  while (i < s.length) {
    if (j < p.length && p[j] !== '*' && p[j] === s[i]) { i++; j++; }
    else if (j < p.length && p[j] === '*') { star = j++; mark = i; }
    else if (star !== -1) { j = star + 1; i = ++mark; }
    else return false;
  }
  while (p[j] === '*') j++;
  return j === p.length;
}
export function ciJobIgnored(settings) {
  let entries;
  // A damaged list ignores nothing: failures stay visible rather than hidden.
  try { entries = validIgnoredCiJobs(settings?.remediation?.ignoredCiJobs); } catch { entries = []; }
  const rules = entries.map((e) => IGNORE_FIELDS.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
  return (job) => rules.some((rule) => rule.every(([k, pattern]) => typeof job?.[k] === 'string' && wildcard(pattern, job[k])));
}
const branchOf = (j) => (text(j?.headRef) ? j.headRef : text(j?.ref) ? j.ref : null);
const attemptKey = (repo, runId, name) => JSON.stringify([repo, runId, name]);
// Both refs identify the line of work: for a pull request `ref` is its own
// refs/pull/<n>/merge, so two forks that named their branch alike stay apart.
// (Under pull_request_target `ref` is the base branch, and they do not.)
const branchKey = (repo, workflow, name, headRef, ref) => (text(workflow) && (text(headRef) || text(ref))
  ? JSON.stringify([repo, workflow, name, text(headRef) ? headRef : '', text(ref) ? ref : '']) : null);
// `job` is the evidence of a failed job. It passed later when a later attempt
// of the same run succeeded, or a later run of the same workflow job on the
// same refs did. Either must have finished after the failure, and the other run
// must be a later one: an older run that was slow to pass says nothing about a
// newer one that failed.
function passedLater(passed, job) {
  const again = passed?.attempts?.get(attemptKey(job.repo, job.runId, job.jobName));
  if (again && height(job.attempt) && again.attempt > job.attempt && Date.parse(again.end) > Date.parse(job.end)) return { reason: 'later_attempt_passed', ...again };
  const next = passed?.branches?.get(branchKey(job.repo, job.workflow, job.jobName, job.headRef, job.ref));
  return next && height(job.runId) && next.runId > job.runId && Date.parse(next.end) > Date.parse(job.end) ? { reason: 'later_run_passed', ...next } : null;
}

export function deriveIssues({ settings, states, ci, aws, operations = [], maintenance = {}, activity = null, now = Date.now() }) {
  const issues = [], sources = {}, checks = {}, samples = {}, suppressions = {}, heldInstances = new Set();
  // Where a target that is absent can be told from a target that was not
  // looked at: only a complete, current inventory says "it is not there".
  const inventories = {};
  const source = (key, at, complete, max) => {
    sources[key] = { observedAt: Number.isFinite(Date.parse(at)) ? at : null, fresh: fresh(at, now, max), complete: complete === true, maxAgeMs: max };
    return sources[key].fresh && sources[key].complete;
  };
  // Optional identity is local derivation metadata, not a new wire schema.
  const idFor = (domain, scope, target, code, identity = []) => issueId(domain, scope, target, code, ...identity);
  const check = (domain, scope, target, code, sourceKey, clear, identity = [], extra = {}) => {
    const id = idFor(domain, scope, target, code, identity);
    checks[id] = { sourceKey, observedAt: sources[sourceKey]?.observedAt, clear: clear === true, ...extra };
    return id;
  };
  const add = (domain, scope, target, code, severity, sourceKey, evidence = {}, observedAt = iso(now), identity = []) => {
    // Collection gaps are observed NOW. Their stale/future clocks belong in
    // bounded evidence, not in the signed event's current observation clock.
    const at = fresh(observedAt, now, 24 * 3600_000) ? observedAt : iso(now);
    issues.push({ id: idFor(domain, scope, target, code, identity), domain, scope, target, code, severity,
      summary: TITLES[code], sourceKey, observedAt: at, evidence });
  };
  for (const n of list(settings.networks)) {
    const s = states?.[n.name], generation = n.generation ?? s?.generation ?? n.coreNetwork ?? 'unversioned';
    const identity = [generation], key = `network:${n.name}`, max = Math.max(180_000, settings.pollSeconds * 4000);
    const declared = ['creating', 'services'].includes(n.lifecycle?.status) || n.lifecycle?.platform?.status === 'starting'
      || maintenance[n.name]?.active === true || n.maintenance?.active === true || s?.maintenance?.active === true;
    // A journal claim is held through the bounded activity result, so a runner
    // that crashed without releasing it cannot silence the network forever.
    const suppressed = declared || (activity ? activity.networks?.[n.name]?.held === true : text(s?.journal?.owner));
    suppressions[n.name] = suppressed;
    // A rolling change is only inferred from other hosts restarting cleanly. It
    // says nothing about a host in a crash loop, whose fault stays actionable.
    // A declared operation or a journal claim still holds every host.
    const crashing = new Set(!declared && activity?.networks?.[n.name]?.reason === 'rolling' && Array.isArray(activity.crashing) ? activity.crashing : []);
    // A recognised change on one host (for example the services host carrying
    // the quorum server) also holds that network's public endpoint checks.
    const hostChanging = Object.values(activity?.hosts || {}).some((v) => v?.network === n.name && v.held === true);
    // Collected before the freshness exits below: a collector gap must not
    // release the EC2 status check of a host that is still held.
    for (const v of Object.values(activity?.hosts || {})) if (v?.network === n.name && v.held === true && text(v.instanceId)) heldInstances.add(v.instanceId);
    if (suppressed) for (const h of list(s?.hosts)) if (text(h.instanceId) && !crashing.has(activityKey(n.name, h))) heldInstances.add(h.instanceId);
    const current = source(key, s?.generatedAt, object(s) && Array.isArray(s.hosts), max);
    source(`${key}:monitor`, iso(now), true, max);
    // Preserve hold/exemption metadata even when freshness or evaluation exits
    // before health checks exist. These checks provide no recovery evidence.
    for (const h of list(s?.hosts)) {
      if (h.duplicate) continue;
      const resource = h.instanceId || (n.source === 'report' ? `report:${h.name}` : null);
      const exempt = crashing.has(activityKey(n.name, h));
      check('network', n.name, h.name, 'host_health', key, false,
        [...identity, resource || `unidentified:${h.name}`],
        { suppressed: !exempt && (suppressed || activity?.hosts?.[activityKey(n.name, h)]?.held === true), exempt });
    }
    for (const e of list(s?.endpoints)) if (text(e.label)) {
      check('network', n.name, e.label, 'endpoint_failed', key, false,
        [...identity, e.kind || 'http', list(n.endpoints).find((v) => v.label === e.label)?.url || e.url || e.label],
        { suppressed: suppressed || hostChanging });
    }
    check('network', n.name, 'collector', 'collector_stale', key, current, identity, { suppressed });
    if (!current) {
      add('network', n.name, 'collector', 'collector_stale', 'critical', `${key}:monitor`, { lastObservationAt: sources[key].observedAt }, iso(now), identity);
      continue;
    }
    const dk = `${key}:discovery`;
    const discoveryOk = source(dk, n.source === 'report' ? s.generatedAt : s.discovery?.at,
      n.source === 'report' || (object(s.discovery) && !s.discovery.error), Math.max(900_000, settings.discoverySeconds * 3000));
    inventories[key] = discoveryOk;
    check('network', n.name, 'discovery', 'discovery_failed', dk, discoveryOk, identity, { suppressed });
    if (!discoveryOk) add('network', n.name, 'discovery', 'discovery_failed', 'warning', `${key}:monitor`,
      { error: String(s.discovery?.error || 'stale discovery').slice(0, 300) }, iso(now), identity);
    let evaluation;
    try { evaluation = evaluateNetwork({ ...n, lifecycle: undefined }, s, settings, now, {}, expectations(operations.filter((op) => op.network === n.name), now)); }
    catch {
      // A malformed nested report cannot turn a previously failing fleet green.
      sources[key].complete = false; checks[idFor('network', n.name, 'collector', 'collector_stale', identity)].clear = false;
      inventories[key] = false;
      add('network', n.name, 'collector', 'collector_stale', 'critical', `${key}:monitor`, { error: 'malformed network observation' }, iso(now), identity);
      continue;
    }
    const coreTip = evaluation.summary.core?.height || 0, platformTip = evaluation.summary.platform?.height || 0;
    for (const row of evaluation.rows) {
      const h = row.host;
      if (h.duplicate) continue;
      const resource = h.instanceId || (n.source === 'report' ? `report:${h.name}` : null);
      const hi = [...identity, resource || `unidentified:${h.name}`], hk = `${key}:host:${resource || h.name}`;
      const valid = source(hk, h.probe?.at, discoveryOk && text(resource) && h.state === 'running'
        && h.probe?.ok === true && !h.probe.skipped && object(h.probe.data), max);
      const exempt = crashing.has(activityKey(n.name, h));
      const held = !exempt && (suppressed || activity?.hosts?.[activityKey(n.name, h)]?.held === true);
      const id = check('network', n.name, h.name, 'host_health', hk, valid, hi, {
        kind: 'host', suppressed: held, exempt, healthyRules: valid ? hostProofs(row, n, settings, coreTip, platformTip, now) : [],
        sampleKey: idFor('network', n.name, resource, 'explorer_sample', identity), maxLagBlocks: settings.thresholds.platformLagBlocks,
      });
      if (fresh(h.probe?.at, now, max) && text(resource)) {
        // Store only fields used for verification; never full probe output.
        const e = row.data.explorer;
        const explorer = object(e) ? Object.fromEntries(['status', 'indexerRunning', 'indexerState', 'indexerRestarting', 'indexerHealth', 'indexerId', 'indexerRestarts', 'network', 'indexedHeight', 'chainHeight'].map((k) => [k, e[k]])) : undefined;
        samples[checks[id].sampleKey] = { scope: n.name, instanceId: h.instanceId, state: h.state,
          probe: { ok: h.probe.ok, at: h.probe.at, data: { explorer } }, suppressed: held };
        // A separately observed consensus tip must also be respected.
        checks[id].explorerLagOk = height(e?.indexedHeight) && Math.max(platformTip, e?.chainHeight || 0) - e.indexedHeight <= settings.thresholds.platformLagBlocks;
      }
      const reasons = row.reasons.filter((r) => ['warn', 'down', 'unreachable'].includes(r.level));
      if (['warn', 'down', 'unreachable'].includes(row.level)) {
        const faults = [...new Set(reasons.map((r) => classify(r.text)))].sort();
        const faultLevels = Object.fromEntries(faults.map((f) => [f, reasons.some((r) => classify(r.text) === f && r.level !== 'warn') ? 'critical' : 'warning']));
        add('network', n.name, h.name, 'host_health', row.level === 'warn' ? 'warning' : 'critical', hk,
          { level: row.level, generation, instanceId: h.instanceId, faults, faultLevels, reasons: reasons.map((r) => r.text).slice(0, 30) },
          fresh(h.probe?.at, now, max) ? h.probe.at : iso(now), hi);
      }
    }
    for (const e of list(s.endpoints)) {
      if (!text(e.label)) continue;
      // Endpoint observations are produced in the same collection batch. If
      // an explicit per-endpoint clock is provided it must also be fresh.
      const ek = `${key}:endpoint:${e.label}`;
      const ei = [...identity, e.kind || 'http', list(n.endpoints).find((v) => v.label === e.label)?.url || e.url || e.label];
      const valid = source(ek, e.at ?? s.generatedAt, true, max);
      check('network', n.name, e.label, 'endpoint_failed', ek, valid && e.ok === true, ei, { suppressed: suppressed || hostChanging });
      if (valid && e.ok === false) add('network', n.name, e.label, 'endpoint_failed', 'warning', ek, { kind: e.kind, status: e.status }, sources[ek].observedAt, ei);
    }
  }
  for (const reg of list(ci?.reporters)) {
    const h = list(ci?.hosts).find((x) => x.id === reg.id), key = `ci:host:${reg.id}`;
    source(`${key}:monitor`, iso(now), true, 180_000);
    const measuredAt = h?.measuredAt ?? h?.at;
    const current = source(key, measuredAt, !!h && fresh(h.receivedAt, now, 180_000)
      && Date.parse(measuredAt) <= Date.parse(h.receivedAt) + 60_000, 180_000);
    for (const code of ['reporter_missing', 'reporter_stale']) check('ci', reg.id, reg.id, code, key, current);
    if (!h || !current) { add('ci', reg.id, reg.id, h ? 'reporter_stale' : 'reporter_missing', 'warning', `${key}:monitor`, { lastObservationAt: sources[key].observedAt }); continue; }
    inventories[key] = true;
    // The reporter keeps a host's first six disks: beyond that a disk it does
    // not list may still be mounted.
    inventories[`${key}:disks`] = h.disksCut !== true;
    for (const d of list(h.disks)) {
      if (!text(d.path)) continue;
      const used = num(d.free) ? pct(d.total - d.free, d.total) : null;
      check('ci', h.id, d.path, 'disk_pressure', key, used !== null && used < 85);
      if (used !== null && used >= 85) add('ci', h.id, d.path, 'disk_pressure', used >= 95 ? 'critical' : 'warning', key, { usedPercent: used, freeBytes: d.free, sharedHumanHost: true }, measuredAt);
    }
    const mem = pct(h.memUsed, h.memTotal);
    check('ci', h.id, 'memory', 'memory_pressure', key, mem !== null && mem < 95);
    if (mem !== null && mem >= 95) add('ci', h.id, 'memory', 'memory_pressure', 'warning', key, { usedPercent: mem, sharedHumanHost: true }, measuredAt);
    for (const r of list(ci?.runners).filter((r) => r.host === h.id && text(r.name))) {
      const rk = `${key}:runner:${r.name}`;
      const valid = source(rk, measuredAt, fresh(r.receivedAt, now, 180_000) && r.receivedAt === h.receivedAt, 180_000);
      check('ci', h.id, r.name, 'runner_offline', rk, valid && ['idle', 'busy'].includes(r.status));
      if (valid && ['offline', 'error'].includes(r.status)) add('ci', h.id, r.name, 'runner_offline', 'warning', rk, { busy: !!r.job, status: r.status, sharedHumanHost: true }, measuredAt);
    }
  }
  source('ci:queue:monitor', iso(now), true, 180_000);
  const queueCurrent = source('ci:queue', ci?.queue?.at, Array.isArray(ci?.queue?.jobs) && !ci.queue.error, 10 * 60_000);
  check('ci', 'github', 'queue', 'queue_stale', 'ci:queue', queueCurrent);
  if (!queueCurrent) add('ci', 'github', 'queue', 'queue_stale', 'warning', 'ci:queue:monitor');
  else for (const j of list(ci.queue.jobs)) {
    if (!text(j.repo) || !height(j.id)) continue;
    const target = `${j.repo}/${j.id}`;
    check('ci', 'github', target, 'queue_wait', 'ci:queue', ['in_progress', 'completed'].includes(j.status));
    if ((!j.status || j.status === 'queued') && Number.isFinite(Date.parse(j.createdAt)) && Date.parse(j.createdAt) < now - 15 * 60_000)
      add('ci', 'github', target, 'queue_wait', 'warning', 'ci:queue', { repo: j.repo, jobId: j.id, createdAt: j.createdAt,
        ...(Number.isFinite(Date.parse(j.runCreatedAt)) ? { runCreatedAt: j.runCreatedAt } : {}),
        ...Object.fromEntries(['name', 'workflow', 'branch', 'url'].filter((k) => text(j[k])).map((k) => [k, j[k].slice(0, 300)])) }, ci.queue.at);
  }
  // A job that is not listed has left the queue only where the listing is
  // whole: not cut to a display size, complete for the job's repository, and
  // carrying every queued job, not only those whose labels our runners serve.
  const queueWhole = queueCurrent && !(Number.isSafeInteger(ci.queue.total) && ci.queue.total > ci.queue.jobs.length)
    && Array.isArray(ci.queue.covered) && Array.isArray(ci.queue.queued);
  const queue = { current: queueCurrent, observedAt: ci?.queue?.at || null, windowMs: num(ci?.queue?.windowMs) ? ci.queue.windowMs : 0,
    covered: queueWhole ? ci.queue.covered.filter(text) : [], queued: new Set(queueWhole ? ci.queue.queued : []),
    // Jobs GitHub recorded as started on one of our runners. A fact that does
    // not age: it needs no current queue listing.
    started: new Set(Array.isArray(ci?.startedJobs) ? ci.startedJobs.filter(height) : []) };
  const ignored = ciJobIgnored(settings);
  // The newest pass of each job: by run (a later attempt) and by branch (a later run).
  const passed = { attempts: new Map(), branches: new Map() };
  const jobs = list(ci?.recent).filter((j) => fresh(j.end, now, JOB_FAILED_MAX_AGE_MS) && Date.parse(j.start) <= Date.parse(j.end));
  for (const j of jobs) {
    if (j.result !== 'Succeeded' || !text(j.repo) || !height(j.runId) || !text(j.name) || !height(j.attempt)) continue;
    const proof = { runId: j.runId, attempt: j.attempt, end: j.end };
    const ak = attemptKey(j.repo, j.runId, j.name), bk = branchKey(j.repo, j.workflow, j.name, j.headRef, j.ref);
    if (!(passed.attempts.get(ak)?.attempt >= j.attempt)) passed.attempts.set(ak, proof);
    // The pass of the latest run: run ids only grow.
    if (bk && !(passed.branches.get(bk)?.runId >= j.runId)) passed.branches.set(bk, proof);
  }
  // Failed jobs in the ledger that are not cases, by the id their case has or
  // would have: the ledger knows the workflow and branch of a job whose case was
  // filed before those were kept in its evidence.
  const jobEndings = new Map();
  for (const j of jobs) {
    if (j.result !== 'Failed') continue;
    const scope = j.host || 'github', target = `${j.repo}/${j.runId}/${j.runnerName}/${j.start}`;
    const pass = passedLater(passed, { repo: j.repo, runId: j.runId, jobName: j.name, attempt: j.attempt, workflow: j.workflow, headRef: j.headRef, ref: j.ref, end: j.end });
    const ending = ignored({ repo: j.repo, workflow: j.workflow, job: j.name, event: j.event, branch: branchOf(j) }) ? { reason: 'ignored_job' } : pass;
    if (ending) { jobEndings.set(idFor('ci', scope, target, 'job_failed', [j.name, j.attempt]), ending); continue; }
    const jk = `ci:job:${issueId(j.host, j.repo, j.runId, j.name, j.attempt, j.start)}`;
    source(jk, j.end, true, JOB_FAILED_MAX_AGE_MS);
    add('ci', scope, target, 'job_failed', 'warning', jk,
      { repo: j.repo, runId: j.runId, attempt: j.attempt, jobName: j.name, runner: j.runnerName, end: j.end,
        ...Object.fromEntries([['workflow', j.workflow], ['event', j.event], ['branch', branchOf(j)], ['headRef', j.headRef], ['ref', j.ref]].filter(([, v]) => text(v)).map(([k, v]) => [k, v.slice(0, 200)])) }, j.end, [j.name, j.attempt]);
  }
  source('aws:monitor', iso(now), true, 180_000);
  const awsCurrent = source('aws:inventory', aws?.at, Array.isArray(aws?.errors) && !aws.errors.length && Array.isArray(aws.volumes) && Array.isArray(aws.addresses), 30 * 60_000);
  check('aws', 'account', 'inventory', 'aws_stale', 'aws:inventory', awsCurrent);
  if (!fresh(aws?.at, now, 30 * 60_000)) add('aws', 'account', 'inventory', 'aws_stale', 'critical', 'aws:monitor', { lastObservationAt: sources['aws:inventory'].observedAt });
  else {
    for (const e of list(aws.errors)) add('aws', e.region, e.scope, 'aws_collection_failed', 'warning', 'aws:monitor', { error: String(e.error || 'collection failed').slice(0, 300) }, aws.at);
    // Only regularly refreshed API partitions have positive completeness.
    // Cached heavy/global scans need their own per-partition clocks first.
    const partitions = { 'ec2:DescribeInstances': 'instances', 'ec2:DescribeVolumes': 'volumes', 'ec2:DescribeAddresses': 'addresses', 'ec2:DescribeNatGateways': 'natGateways',
      'elasticloadbalancing:DescribeLoadBalancers': 'loadBalancers', 'elasticloadbalancing:DescribeLoadBalancers (classic)': 'loadBalancers', 'lambda:ListFunctions': 'lambda', 'dynamodb:ListTables': 'dynamodb' };
    for (const region of Array.isArray(aws.regions) ? aws.regions : []) for (const [scope, field] of Object.entries(partitions)) {
      const pk = `aws:inventory:${region}:${scope}`;
      const valid = source(pk, aws.at, Array.isArray(aws.errors) && Array.isArray(aws[field]) && !aws.errors.some((e) => e?.region === region && e?.scope === scope), 30 * 60_000);
      check('aws', region, scope, 'aws_collection_failed', pk, valid);
    }
    inventories['aws:inventory'] = awsCurrent;
    if (awsCurrent) {
      for (const v of list(aws.volumes)) {
        check('aws', v.region, v.id, 'idle_volume', 'aws:inventory', v.state === 'in-use' && text(v.attachedTo));
        if (v.state === 'available' && !v.attachedTo) add('aws', v.region, v.id, 'idle_volume', 'info', 'aws:inventory', { sizeGiB: v.sizeGiB, action: 'review-only; retained data may be intentional' }, aws.at);
      }
      for (const a of list(aws.addresses)) {
        const target = a.allocationId || a.publicIp;
        check('aws', a.region, target, 'idle_address', 'aws:inventory', a.associated === true);
        if (a.associated === false) add('aws', a.region, target, 'idle_address', 'info', 'aws:inventory', { action: 'review-only; address may be reserved or part of an operation' }, aws.at);
      }
    }
  }
  const health = aws?.health;
  const healthySource = source('aws:health', health?.at, Array.isArray(health?.errors) && !health.errors.length
    && Array.isArray(health.instances) && Array.isArray(health.alarms), 10 * 60_000);
  check('aws', 'account', 'health', 'aws_health_missing', 'aws:health', healthySource);
  if (!healthySource) add('aws', 'account', 'health', 'aws_health_missing', 'warning', 'aws:monitor', { errors: list(health?.errors).slice(0, 20) });
  if (fresh(health?.at, now, 10 * 60_000)) {
    inventories['aws:health'] = healthySource;
    for (const i of list(health.instances)) {
      // An instance of a host or network under a recognised change is held with it.
      check('aws', i.region, i.id, 'aws_instance_impaired', 'aws:health', i.state === 'running' && i.instanceStatus === 'ok' && i.systemStatus === 'ok',
        [], heldInstances.has(i.id) ? { suppressed: true } : {});
      check('aws', i.region, i.id, 'aws_scheduled_event', 'aws:health', Array.isArray(i.events) && i.events.length === 0);
      if (i.instanceStatus === 'impaired' || i.systemStatus === 'impaired') add('aws', i.region, i.id, 'aws_instance_impaired', 'critical', 'aws:health', { instanceStatus: i.instanceStatus, systemStatus: i.systemStatus }, health.at);
      if (Array.isArray(i.events) && i.events.length) add('aws', i.region, i.id, 'aws_scheduled_event', 'warning', 'aws:health', { events: list(i.events).slice(0, 20) }, health.at);
    }
    for (const a of list(health.alarms)) {
      const control = healthySource && a.scalingControl?.verifiedAt === health.at
        ? dynamoScaleInControl(a, a.scalingControl.policy) : null;
      const resolutionEvidence = control && a.state === 'ALARM' ? { reason: 'verified_control_signal',
        explanation: 'Monitoring classification corrected; scale-in control, not evidence of table recovery.',
        alarmArn: a.arn, state: a.state, verifiedAt: health.at, ...control } : null;
      check('aws', a.region, a.name, 'aws_alarm', 'aws:health', a.state === 'OK' || !!resolutionEvidence,
        [], resolutionEvidence ? { resolutionEvidence } : {});
      // A verified scale-in control is in ALARM whenever its table is idle. That
      // is its design, so it is not a case; cases earlier releases filed for it end.
      check('aws', a.region, a.name, 'aws_scaling_control', 'aws:health', a.state === 'OK' || !!resolutionEvidence,
        [], resolutionEvidence ? { resolutionEvidence } : {});
      if (a.state === 'ALARM' && !control) add('aws', a.region, a.name, 'aws_alarm', 'warning', 'aws:health', { state: a.state }, health.at);
    }
  }
  return { issues, sources, checks, samples, suppressions, inventories, queue, passed, ignored, jobEndings,
    networks: list(settings.networks).map((n) => n.name), reporters: Array.isArray(ci?.reporters) ? list(ci.reporters).map((r) => r.id) : null,
    excludedCiHosts: (Array.isArray(settings.remediation?.excludedCiHosts) ? settings.remediation.excludedCiHosts : []).filter((id) => typeof id === 'string') };
}

export function reconcile(previous, derived, now = Date.now()) {
  const state = structuredClone(previous || { schemaVersion: 1, issues: [], outbox: [] });
  const existing = new Map((state.issues || []).map((i) => [i.id, i]));
  const counters = { ...(state.revisionCounters || {}) };
  // Seed migrations from BOTH records and unsent events. Display retention
  // must never recycle an event ID still remembered by the receiver.
  for (const i of [...existing.values(), ...(state.outbox || []).map((e) => e.issue), ...(state.quarantined || []).map((q) => q.event?.issue)]) {
    if (i && Number.isSafeInteger(i.revision)) counters[i.id] = Math.max(counters[i.id] || 0, i.revision);
  }
  const events = [];
  const emit = (issue, transition) => {
    const revision = (counters[issue.id] || 0) + 1;
    if (!Number.isSafeInteger(revision) || revision > 999_999_999) throw new Error('incident revision exhausted; refusing event ID reuse');
    counters[issue.id] = revision;
    Object.assign(issue, { revision, lastEventAt: iso(now) });
    events.push({ schemaVersion: 1, eventId: `${issue.id}:${revision}`, occurredAt: iso(now), transition, issue: structuredClone(issue) });
  };
  // `exempt` marks a check the network-wide hold must not cover (a crash loop).
  const excluded = (issue) => issue?.domain === 'ci' && (derived.excludedCiHosts || []).includes(issue.scope);
  const suppressed = (issue, check) => excluded(issue) || check?.suppressed === true || (check?.exempt !== true && issue.domain === 'network' && derived.suppressions?.[issue.scope] === true);
  const positive = (issue, check) => {
    const s = derived.sources?.[check?.sourceKey];
    const at = Date.parse(check?.observedAt), lastFault = Date.parse(issue.lastFaultAt || issue.observedAt || issue.firstSeen);
    const pause = Date.parse(issue.suppressedUntil || '');
    return !suppressed(issue, check) && check?.clear === true && s?.fresh === true && s.complete === true
      && fresh(check.observedAt, now, s.maxAgeMs || 180_000) && at === Date.parse(s.observedAt)
      && Number.isFinite(lastFault) && at > lastFault && (!Number.isFinite(pause) || at > pause);
  };
  const faultsOf = (issue) => Array.isArray(issue?.evidence?.faults) ? issue.evidence.faults
    : list(issue?.evidence?.reasons).map((r) => classify(r.text));
  const knownFaults = (issue) => {
    const faults = faultsOf(issue);
    if (faults.length) return [...new Set(faults)].sort();
    if (Array.isArray(issue?.evidence?.reasons) && issue.evidence.reasons.length) return [...new Set(issue.evidence.reasons.map(classify))].sort();
    return [faultKey('unclassified', issue.code)];
  };
  const healthyRules = (issue, check) => {
    if (!positive(issue, check)) return new Set();
    const rules = new Set(check.healthyRules || []);
    const sample = derived.samples?.[check.sampleKey], baseline = state.explorerSamples?.[check.sampleKey];
    if (check.explorerLagOk === true && explorerReadiness(sample, baseline, check.maxLagBlocks, now).ready) {
      for (const rule of ['explorer_api', 'explorer_runtime', 'explorer_heights', 'explorer_lag']) rules.add(faultKey(rule));
    }
    return rules;
  };
  // A fault the evaluator has stopped reporting, on a host whose observation is
  // valid, counts one quiet sample per new probe. After QUIET_SAMPLES in a row
  // it is dropped even without a proof of its own: a task container that no
  // longer exists, or a fact no rule recognises, can never be proven healthy.
  const quietFaults = (issue, check, incoming) => {
    const quiet = {}, counted = positive(issue, check);
    for (const f of knownFaults(issue)) {
      if (incoming.includes(f)) continue;
      const old = issue.quiet?.[f];
      quiet[f] = counted && old?.at !== check.observedAt ? { n: (old?.n || 0) + 1, at: check.observedAt } : old || { n: 0, at: null };
    }
    return quiet;
  };
  const settled = (quiet) => new Set(Object.entries(quiet).filter(([, v]) => v.n >= QUIET_SAMPLES).map(([f]) => f));
  // Why an open case is over although nothing recovered. Checked before holds
  // and exclusions: neither keeps alive a case whose subject no longer exists.
  const GONE = { host_health: (i) => `network:${i.scope}`, endpoint_failed: (i) => `network:${i.scope}`,
    disk_pressure: (i) => `ci:host:${i.scope}:disks`, runner_offline: (i) => `ci:host:${i.scope}`,
    idle_volume: () => 'aws:inventory', idle_address: () => 'aws:inventory', aws_instance_impaired: () => 'aws:health',
    aws_scheduled_event: () => 'aws:health', aws_alarm: () => 'aws:health', aws_scaling_control: () => 'aws:health' };
  const REPORTER = ['reporter_missing', 'reporter_stale', 'disk_pressure', 'memory_pressure', 'runner_offline'];
  const gone = (issue, check) => {
    if (issue.domain === 'network' && Array.isArray(derived.networks)) {
      if (!derived.networks.includes(issue.scope)) return { reason: 'network_removed', sure: true };
    } else if (issue.domain === 'ci' && REPORTER.includes(issue.code) && Array.isArray(derived.reporters) && !derived.reporters.includes(issue.scope)) return { reason: 'target_removed', sure: true };
    if (check || !Object.hasOwn(GONE, issue.code)) return null;
    return { reason: 'target_removed', sure: derived.inventories?.[GONE[issue.code](issue)] === true };
  };
  // The pass that ends a failed job's case: known for the job while the ledger
  // has it, otherwise matched from what the case recorded.
  const jobPass = (issue) => {
    const e = issue.evidence || {}, known = derived.jobEndings?.get(issue.id);
    if (known?.end) return known;
    return text(e.repo) && text(e.jobName) && height(e.runId) ? passedLater(derived.passed, { ...e, end: e.end || issue.lastFaultAt }) : null;
  };
  const ended = (issue, check) => {
    const missing = gone(issue, check);
    if (!missing) delete issue.missingSince;
    else {
      // The clock starts at the first complete inventory without the target and
      // is kept through incomplete ones; only a complete one may end the case.
      if (missing.sure) issue.missingSince ||= iso(now);
      if (missing.sure && now - Date.parse(issue.missingSince) >= GONE_AFTER_MS) return { reason: missing.reason, missingSince: issue.missingSince };
    }
    const e = issue.evidence || {};
    if (issue.code === 'job_failed') {
      if (derived.jobEndings?.get(issue.id)?.reason === 'ignored_job'
        || derived.ignored?.({ repo: e.repo, workflow: e.workflow, job: e.jobName, event: e.event, branch: e.branch })) return { reason: 'ignored_job' };
      const failedAt = Date.parse(e.end || issue.lastFaultAt || issue.firstSeen);
      // A pass still on record outlives the failure in the ledger: it is a
      // recovery, and is taken as one below, not an expiry.
      if (Number.isFinite(failedAt) && now - failedAt >= JOB_FAILED_MAX_AGE_MS && !jobPass(issue)) return { reason: 'expired', after: 'a day without a later pass on record' };
    }
    if (issue.code === 'queue_wait' && derived.queue?.current && now - Date.parse(issue.lastSeen || issue.firstSeen) >= QUEUE_WAIT_UNSEEN_MS)
      return { reason: 'expired', after: 'a day without being seen waiting' };
    return null;
  };
  const close = (issue, at, evidence) => {
    issue.status = 'resolved'; issue.resolvedAt = iso(now); if (at) issue.observedAt = at;
    if (evidence) issue.resolutionEvidence = evidence; else delete issue.resolutionEvidence;
    issue.suppressed = false; delete issue.missingSince; delete issue.quiet;
    emit(issue, 'resolved');
  };
  const signature = (issue) => issue.code === 'host_health' ? JSON.stringify(knownFaults(issue))
    : issue.code === 'aws_instance_impaired' ? JSON.stringify([issue.evidence?.instanceStatus === 'impaired', issue.evidence?.systemStatus === 'impaired'])
      : issue.code === 'aws_scheduled_event' ? JSON.stringify(list(issue.evidence?.events).map((e) => [e.code, e.notBefore]).sort()) : issue.code;
  const active = new Set();
  for (const current of derived.issues || []) {
    active.add(current.id);
    const old = existing.get(current.id);
    const observedAt = Number.isFinite(Date.parse(current.observedAt)) ? current.observedAt : iso(now);
    // A re-sent historical sample cannot replace later facts or reopen a
    // recovered issue. Equal clocks are allowed only for an existing fault.
    const priorAt = Date.parse(old?.observedAt);
    if (Number.isFinite(priorAt) && (Date.parse(observedAt) < priorAt || (old.status === 'resolved' && Date.parse(observedAt) <= priorAt))) continue;
    const check = derived.checks?.[current.id];
    const maintenance = suppressed(current, check);
    const awaitingPostMaintenance = old?.suppressed === true && Date.parse(observedAt) <= Date.parse(old.suppressedUntil);
    const issue = { ...old, ...current, observedAt, status: 'open', firstSeen: old?.firstSeen || iso(now), lastSeen: iso(now), resolvedAt: null,
      lastFaultAt: observedAt, suppressed: maintenance || awaitingPostMaintenance };
    delete issue.resolutionEvidence; // a reopened fault cannot retain an earlier classification correction
    delete issue.missingSince; delete issue.quiet;
    if (old?.status === 'open' && current.code === 'host_health') {
      const proofs = healthyRules(old, check), incoming = knownFaults(current), oldFaults = knownFaults(old);
      const quiet = quietFaults(old, check, incoming), dropped = settled(quiet);
      const retained = oldFaults.filter((f) => !proofs.has(f) && !incoming.includes(f) && !dropped.has(f));
      const waiting = Object.fromEntries(retained.map((f) => [f, quiet[f]]));
      if (retained.length) issue.quiet = waiting;
      const faults = [...new Set([...incoming, ...retained])].sort();
      // Levels of the faults that remain; a fault that left takes its level along.
      const faultLevels = Object.fromEntries(Object.entries({ ...old.evidence?.faultLevels, ...current.evidence?.faultLevels }).filter(([f]) => faults.includes(f)));
      issue.evidence = { ...current.evidence, faults, faultLevels,
        reasons: [...(current.evidence?.reasons || []), ...(old.evidence?.reasons || []).filter((r) => retained.includes(classify(r)))].slice(0, 30) };
      if (retained.some((f) => (faultLevels[f] || old.severity) === 'critical')) issue.severity = 'critical';
    }
    if (maintenance) issue.suppressedUntil = iso(now);
    if (!issue.suppressed) {
      if (!old || !old.revision || old.status !== 'open') emit(issue, old?.revision ? 'reopened' : 'opened');
      else if (old.suppressed || old.severity !== issue.severity || signature(old) !== signature(issue)) emit(issue, 'changed');
      else if (now - Date.parse(old.lastEventAt) >= 6 * 3600_000) emit(issue, 'reminder');
    }
    existing.set(issue.id, issue);
  }
  for (const issue of existing.values()) if (issue.status === 'open' && !active.has(issue.id)) {
    const check = derived.checks?.[issue.id];
    const over = ended(issue, check);
    if (over) { close(issue, null, over); continue; }
    issue.suppressed = suppressed(issue, check);
    if (issue.suppressed) { issue.suppressedUntil = iso(now); continue; }
    let clear = positive(issue, check), clearAt = check?.observedAt, evidence = check?.resolutionEvidence;
    if (check?.kind === 'host') {
      // Recovered when every fault is either proven healthy or has stayed
      // unreported through enough valid samples.
      const proofs = healthyRules(issue, check), quiet = quietFaults(issue, check, []), dropped = settled(quiet);
      issue.quiet = quiet;
      const unproven = knownFaults(issue).filter((f) => !proofs.has(f));
      clear = clear && unproven.every((f) => dropped.has(f));
      if (clear && unproven.length) evidence = { reason: 'quiet', samples: QUIET_SAMPLES, faults: unproven.slice(0, 30) };
    }
    // An omitted failed job proves nothing. A later attempt of the same job, or
    // a later run of it on the same branch, that passed after the failure does.
    if (!clear && issue.code === 'job_failed') {
      const pass = jobPass(issue);
      if (pass) { clear = true; clearAt = pass.end; evidence = pass; }
    }
    // A waiting job has left the queue when GitHub recorded it starting on one
    // of our runners, or when it is not among the queued jobs of a whole,
    // current listing of its repository, for a run the listing still follows
    // (then it started, finished or was cancelled). A case that does not know
    // when its run began cannot use the listing: its run may be outside it.
    if (!clear && issue.code === 'queue_wait') {
      const q = derived.queue, e = issue.evidence || {}, seen = Date.parse(q?.observedAt), runAt = Date.parse(e.runCreatedAt);
      if (q?.started?.has(e.jobId)) { clear = true; clearAt = q.current ? q.observedAt : null; evidence = { reason: 'left_queue', how: 'started on a runner' }; }
      else if (q?.current && q.covered.includes(e.repo) && !q.queued.has(e.jobId) && Number.isFinite(runAt) && seen - runAt < q.windowMs - GONE_AFTER_MS
        && seen > Date.parse(issue.lastFaultAt || issue.observedAt || issue.firstSeen)) { clear = true; clearAt = q.observedAt; evidence = { reason: 'left_queue', how: 'no longer queued' }; }
    }
    if (clear) close(issue, clearAt, evidence);
  }
  state.issues = [...existing.values()].filter((i) => i.status === 'open' || now - Date.parse(i.resolvedAt) < 30 * 86400_000);
  // Exclusion is not recovery. Retain observations/history and withdraw only
  // undelivered remediation events; the broker rechecks suppressed live issues.
  for (const issue of state.issues) {
    issue.remediationExcluded = excluded(issue);
    if (issue.remediationExcluded) issue.suppressed = true;
  }
  const pending = [...(state.outbox || []), ...events];
  state.quarantined = [...(state.quarantined || []), ...pending.filter((e) => excluded(e.issue))
    .map((event) => ({ event, at: iso(now), reason: 'owner-configured remediation exclusion' }))];
  state.outbox = pending.filter((e) => !excluded(e.issue));
  state.revisionCounters = counters;
  const samples = { ...(state.explorerSamples || {}) };
  for (const [key, sample] of Object.entries(derived.samples || {})) {
    if (sample.suppressed) { delete samples[key]; continue; }
    if (fresh(sample.probe?.at, now, 180_000) && (!samples[key] || Date.parse(sample.probe.at) > Date.parse(samples[key].probe?.at))) samples[key] = sample;
  }
  // No unbounded probe history. Expired identities cannot verify recovery.
  state.explorerSamples = Object.fromEntries(Object.entries(samples).filter(([, s]) => !derived.suppressions?.[s.scope] && fresh(s.probe?.at, now, 180_000)));
  state.generatedAt = iso(now); state.sources = derived.sources;
  return state;
}

// More than one delivery batch waiting is a backlog: the receiver is away or
// behind. It acts on the newest state of an issue, so only the newest waiting
// event of each issue is kept. Otherwise a receiver that returns is handed days
// of faults that are long over, hours before the events that say so.
//
// The newest event is always kept, an ending included, even for an issue the
// receiver may never have heard of: an earlier event can have been accepted
// with its acknowledgement lost, and then only the ending closes it there. An
// ending the receiver did not need is a record it files and ignores.
export const BACKLOG_EVENTS = 50;
export function compactBacklog(state) {
  const outbox = state.outbox || [];
  if (outbox.length <= BACKLOG_EVENTS) return state;
  const last = new Map();
  for (const e of outbox) last.set(e.issue?.id, e);
  state.outbox = outbox.filter((e) => last.get(e.issue?.id) === e);
  return state;
}

export function publicIssues(state, visibleNetworks = []) {
  const names = new Set(visibleNetworks);
  const issues = (state?.issues || []).filter((i) => i.domain !== 'network' || names.has(i.scope)).map((i) => ({
    id: i.id, domain: i.domain, ...(i.domain === 'network' ? { network: i.scope } : {}), code: i.code, severity: i.severity,
    summary: TITLES[i.code] || 'Status issue', status: i.status, firstSeen: i.firstSeen, lastSeen: i.lastSeen, resolvedAt: i.resolvedAt,
  }));
  return { schemaVersion: 1, generatedAt: state?.generatedAt || null, issues };
}
export function apiAuthorized(header, token) {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7)), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function loadIncidentState(dataDir) { return readJSON(join(dataDir, 'incidents', 'state.json')); }
export function saveIncidentState(dataDir, state) { writeAtomic(join(dataDir, 'incidents', 'state.json'), JSON.stringify(state), 0o600); }
export function readSecret(path) { return path ? readFileSync(path, 'utf8').trim() : null; }
export function signedHeaders(body, secret, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  return { 'Content-Type': 'application/json', 'X-Dash-Timestamp': timestamp, 'X-Dash-Signature': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex') };
}
export function validateDestination(value) {
  const url = new URL(value);
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(?::(?:443|8444))?\/v1\/events$/.test(value)
    || url.protocol !== 'https:' || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname)
    || !['', '443', '8444'].includes(url.port) || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/events')
    throw new Error('incident destination must be a Tailscale node FQDN HTTPS 443/8444 /v1/events endpoint');
  return url.href;
}
