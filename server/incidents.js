// Machine-readable, read-only issue derivation. Evidence is data, never commands.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateNetwork, explorerReadiness } from '../shared/evaluate.js';
import { readJSON, writeAtomic } from '../shared/settings.js';
import { dynamoScaleInControl } from '../shared/aws-alarm-semantics.js';

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
  collector_stale: 'Network observations missing or stale', discovery_failed: 'Network discovery incomplete',
  host_health: 'Network host health check failed', endpoint_failed: 'Network endpoint check failed',
  reporter_missing: 'CI reporter has never reported', reporter_stale: 'CI reporter stopped reporting',
  runner_offline: 'CI runner unavailable', disk_pressure: 'Disk space pressure', memory_pressure: 'Memory pressure',
  queue_stale: 'CI queue observation missing or stale', queue_wait: 'Self-hosted CI job waiting over 15 minutes', job_failed: 'CI job failed',
  aws_stale: 'AWS inventory missing or stale', aws_collection_failed: 'AWS collection incomplete',
  aws_instance_impaired: 'EC2 status check failed', aws_alarm: 'CloudWatch alarm is active',
  aws_health_missing: 'AWS runtime health collection unavailable', aws_scheduled_event: 'EC2 scheduled maintenance event', idle_volume: 'Unattached EBS volume requires ownership review',
  idle_address: 'Unassociated public address requires ownership review',
};

export function deriveIssues({ settings, states, ci, aws, now = Date.now() }) {
  const issues = [], sources = {}, checks = {}, samples = {}, suppressions = {};
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
    const suppressed = ['creating', 'services'].includes(n.lifecycle?.status) || n.lifecycle?.platform?.status === 'starting'
      || n.maintenance?.active === true || s?.maintenance?.active === true || text(s?.journal?.owner);
    suppressions[n.name] = suppressed;
    const current = source(key, s?.generatedAt, object(s) && Array.isArray(s.hosts), max);
    source(`${key}:monitor`, iso(now), true, max);
    check('network', n.name, 'collector', 'collector_stale', key, current, identity, { suppressed });
    if (!current) {
      add('network', n.name, 'collector', 'collector_stale', 'critical', `${key}:monitor`, { lastObservationAt: sources[key].observedAt }, iso(now), identity);
      continue;
    }
    const dk = `${key}:discovery`;
    const discoveryOk = source(dk, n.source === 'report' ? s.generatedAt : s.discovery?.at,
      n.source === 'report' || (object(s.discovery) && !s.discovery.error), Math.max(900_000, settings.discoverySeconds * 3000));
    check('network', n.name, 'discovery', 'discovery_failed', dk, discoveryOk, identity, { suppressed });
    if (!discoveryOk) add('network', n.name, 'discovery', 'discovery_failed', 'warning', `${key}:monitor`,
      { error: String(s.discovery?.error || 'stale discovery').slice(0, 300) }, iso(now), identity);
    let evaluation;
    try { evaluation = evaluateNetwork({ ...n, lifecycle: undefined }, s, settings, now); }
    catch {
      // A malformed nested report cannot turn a previously failing fleet green.
      sources[key].complete = false; checks[idFor('network', n.name, 'collector', 'collector_stale', identity)].clear = false;
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
      const id = check('network', n.name, h.name, 'host_health', hk, valid, hi, {
        kind: 'host', suppressed, healthyRules: valid ? hostProofs(row, n, settings, coreTip, platformTip, now) : [],
        sampleKey: idFor('network', n.name, resource, 'explorer_sample', identity), maxLagBlocks: settings.thresholds.platformLagBlocks,
      });
      if (fresh(h.probe?.at, now, max) && text(resource)) {
        // Store only fields used for verification; never full probe output.
        const e = row.data.explorer;
        const explorer = object(e) ? Object.fromEntries(['status', 'indexerRunning', 'indexerState', 'indexerRestarting', 'indexerHealth', 'indexerId', 'indexerRestarts', 'network', 'indexedHeight', 'chainHeight'].map((k) => [k, e[k]])) : undefined;
        samples[checks[id].sampleKey] = { scope: n.name, instanceId: h.instanceId, state: h.state,
          probe: { ok: h.probe.ok, at: h.probe.at, data: { explorer } }, suppressed };
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
      check('network', n.name, e.label, 'endpoint_failed', ek, valid && e.ok === true, ei, { suppressed });
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
    // Disappearance from the truncated 50-job summary is never recovery.
    check('ci', 'github', target, 'queue_wait', 'ci:queue', ['in_progress', 'completed'].includes(j.status));
    if ((!j.status || j.status === 'queued') && Number.isFinite(Date.parse(j.createdAt)) && Date.parse(j.createdAt) < now - 15 * 60_000)
      add('ci', 'github', target, 'queue_wait', 'warning', 'ci:queue', { repo: j.repo, jobId: j.id, createdAt: j.createdAt }, ci.queue.at);
  }
  const jobSuccesses = [];
  const jobs = list(ci?.recent).filter((j) => fresh(j.end, now, 24 * 3600_000) && Date.parse(j.start) <= Date.parse(j.end));
  for (const j of jobs) {
    const jk = `ci:job:${issueId(j.host, j.repo, j.runId, j.name, j.attempt, j.start)}`;
    source(jk, j.end, true, 24 * 3600_000);
    const evidence = { repo: j.repo, runId: j.runId, attempt: j.attempt, jobName: j.name, runner: j.runnerName, end: j.end };
    if (j.result === 'Succeeded' && text(j.repo) && height(j.runId) && text(j.name) && height(j.attempt)) jobSuccesses.push({ ...evidence, sourceKey: jk });
  }
  for (const j of jobs) if (j.result === 'Failed' && !jobSuccesses.some((s) => s.repo === j.repo && s.runId === j.runId && s.jobName === j.name
    && height(j.attempt) && s.attempt > j.attempt && Date.parse(s.end) > Date.parse(j.end))) {
    const jk = `ci:job:${issueId(j.host, j.repo, j.runId, j.name, j.attempt, j.start)}`;
    add('ci', j.host || 'github', `${j.repo}/${j.runId}/${j.runnerName}/${j.start}`, 'job_failed', 'warning', jk,
      { repo: j.repo, runId: j.runId, attempt: j.attempt, jobName: j.name, runner: j.runnerName, end: j.end }, j.end, [j.name, j.attempt]);
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
    for (const i of list(health.instances)) {
      check('aws', i.region, i.id, 'aws_instance_impaired', 'aws:health', i.state === 'running' && i.instanceStatus === 'ok' && i.systemStatus === 'ok');
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
      check('aws', a.region, a.name, 'aws_scaling_control', 'aws:health', a.state === 'OK');
      if (a.state === 'ALARM' && control) add('aws', a.region, a.name, 'aws_scaling_control', 'info', 'aws:health',
        { state: a.state, alarmArn: a.arn, ...control, action: 'informational scale-in control; no service recovery asserted' }, health.at);
      else if (a.state === 'ALARM') add('aws', a.region, a.name, 'aws_alarm', 'warning', 'aws:health', { state: a.state }, health.at);
    }
  }
  return { issues, sources, checks, samples, suppressions, jobSuccesses };
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
  const suppressed = (issue, check) => check?.suppressed === true || (issue.domain === 'network' && derived.suppressions?.[issue.scope] === true);
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
    if (old?.status === 'open' && current.code === 'host_health') {
      const proofs = healthyRules(old, check), incoming = knownFaults(current), oldFaults = knownFaults(old);
      const retained = oldFaults.filter((f) => !proofs.has(f) && !incoming.includes(f));
      const faults = [...new Set([...incoming, ...retained])].sort();
      const faultLevels = { ...old.evidence?.faultLevels, ...current.evidence?.faultLevels };
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
    issue.suppressed = suppressed(issue, check);
    if (issue.suppressed) { issue.suppressedUntil = iso(now); continue; }
    let clear = positive(issue, check), clearAt = check?.observedAt;
    if (clear && check.kind === 'host') {
      const proofs = healthyRules(issue, check);
      clear = knownFaults(issue).every((f) => proofs.has(f));
    }
    // Failed jobs remain unresolved when omitted or aged out. Only a later
    // successful attempt of the exact logical job is positive recovery.
    if (!clear && issue.code === 'job_failed') {
      const e = issue.evidence || {};
      for (const j of derived.jobSuccesses || []) if (text(e.repo) && text(e.jobName) && height(e.runId) && height(e.attempt)
        && j.repo === e.repo && j.runId === e.runId && j.jobName === e.jobName && j.attempt > e.attempt) {
        const candidate = { sourceKey: j.sourceKey, observedAt: j.end, clear: true };
        if (positive(issue, candidate)) { clear = true; clearAt = candidate.observedAt; break; }
      }
    }
    if (clear) {
      issue.status = 'resolved'; issue.resolvedAt = iso(now); issue.observedAt = clearAt;
      if (check?.resolutionEvidence) issue.resolutionEvidence = check.resolutionEvidence;
      emit(issue, 'resolved');
    }
  }
  state.issues = [...existing.values()].filter((i) => i.status === 'open' || now - Date.parse(i.resolvedAt) < 30 * 86400_000);
  state.outbox = [...(state.outbox || []), ...events];
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
