import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validateMainnetReport } from './mainnet.js';
import { evaluateNetwork, projectNetwork } from './evaluate.js';
import { DEFAULT_SETTINGS, validateSettings } from './settings.js';

const now = Date.parse('2026-09-30T08:00:00Z');
const fixture = () => ({ network: 'mainnet', generatedAt: new Date(now).toISOString(),
  core: { chain: 'main', blocks: 100, headers: 100, ibd: false, synced: true, chainLockHeight: 100 },
  platform: { network: 'evo1', height: 200, blockTime: new Date(now).toISOString(), catchingUp: false },
  mainnet: { chainLockAgeSeconds: 1, bigBans: 876, newBans: 0, coreStall: false, platformStall: false },
  quorumServer: { status: 200, listed: 300, quorums: 20 } });
const evaluate = (r) => evaluateNetwork(DEFAULT_SETTINGS.networks.find((n) => n.name === 'mainnet'), validateMainnetReport(r, now), DEFAULT_SETTINGS, now);

test('Mainnet normalization retains time, rejects other chains/stale reports, drops unknown/private data', () => {
  const r = fixture(); r.core.password = 'never-public'; r.containers = [{ image: 'unrelated-private-image' }];
  const state = validateMainnetReport(r, now);
  assert.equal(state.hosts[0].probe.data.tenderdash.blockTime, r.platform.blockTime);
  assert.doesNotMatch(JSON.stringify(state), /never-public|unrelated-private/);
  for (const bad of [{ ...r, core: { ...r.core, chain: 'test' } }, { ...r, platform: { ...r.platform, network: 'testnet' } }, { ...r, generatedAt: new Date(now - 181000).toISOString() }]) assert.throws(() => validateMainnetReport(bad, now));
});

test('Mainnet source failures, syncing, new-ban spikes and historical bans have distinct outcomes', () => {
  assert.equal(evaluate(fixture()).level, 'ok');
  const spike = fixture(); spike.mainnet.newBans = 20;
  assert.equal(evaluate(spike).level, 'warn');
  const sync = fixture(); sync.platform.catchingUp = true; sync.mainnet.platformStall = true;
  const syncing = evaluate(sync);
  assert.equal(syncing.level, 'warn');
  assert.equal(syncing.summary.mainnet.platformStall, null);
  const missing = fixture(); missing.core = null;
  assert.equal(evaluate(missing).level, 'down');
  const quorum = fixture(); quorum.quorumServer = null;
  assert.equal(evaluate(quorum).level, 'down');
  const outage = fixture(); outage.platform = null;
  assert.equal(evaluate(outage).level, 'down');
});

test('Python observer behavior', () => {
  execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'deploy', '-p', 'test_mainnet_observer.py'], { timeout: 15000 });
});


test('mainnet-support cannot enter EC2 discovery, even with malformed legacy settings', async () => {
  const { createDiscovery } = await import('../agent/discover.js');
  let calls = 0;
  const discover = createDiscovery({ region: 'us-west-2', tagKey: 'DashNetwork' }, { send: async () => { calls++; throw new Error('must not call AWS'); } });
  const forbidden = { ...DEFAULT_SETTINGS.networks.find((n) => n.name === 'mainnet'), source: undefined, tag: 'mainnet-support' };
  assert.deepEqual(await discover([forbidden]), { mainnet: [] });
  assert.equal(calls, 0);
  const bad = structuredClone(DEFAULT_SETTINGS); bad.networks[bad.networks.findIndex((n) => n.name === 'mainnet')] = forbidden;
  assert.throws(() => validateSettings(bad), /separate report observer/);
});

test('private Evo fills dashboard metrics without disclosing source identity in state or projection', () => {
  const r = fixture(); r.evo = true; r.core.difficulty = 123.25;
  const privateValue = 'PRIVATE-NODE-IDENTITY';
  r.publicIp = privateValue;
  r.core.masternode = { state: 'READY', type: 'Evo', posePenalty: 0, proTxHash: privateValue,
    service: privateValue, lastPaidHeight: 123456, registeredHeight: 123456 };
  Object.assign(r.platform, { protocolApp: 13, validatorSetSize: 100, peers: 8, nodeId: privateValue, proTxHash: privateValue, proposer: privateValue });
  r.dapi = { ok: true, height: 200, dapiVersion: '4.1.1', driveVersion: '4.1.2', chainId: 'evo1', error: privateValue,
    tls: { issuer: privateValue }, query: { ok: true, epoch: 300, protocol: 13, error: privateValue } };
  r.components = { drive: { version: '4.1.2', running: true, restarts: 0, name: privateValue } };
  const normalized = validateMainnetReport(r, now);
  const publicView = projectNetwork(DEFAULT_SETTINGS.networks.find((n) => n.name === 'mainnet'), evaluate(r), normalized, false);
  assert.doesNotMatch(JSON.stringify([normalized, publicView]), /PRIVATE-NODE-IDENTITY|123456/);
  assert.equal(publicView.summary.core.difficulty, 123.25);
  assert.equal(publicView.summary.mainnet.bigBans, 876);
  assert.equal(publicView.summary.mainnet.quorumCount, 20);
  assert.equal(publicView.summary.mainnet.coreStall, false);
  assert.equal(publicView.summary.platform.protocol, 13);
  assert.equal(publicView.summary.platform.validatorSet, 100);
  assert.deepEqual(publicView.summary.masternodes, { ready: 1, total: 1, pose: 0 });
  assert.deepEqual(publicView.summary.dapi, { ok: 1, total: 1 });
  assert.equal(publicView.summary.versions.drive['4.1.2'], 1);
  assert.equal(publicView.hosts[0].publicIp, null);
});

test('configured private Evo failure cannot manufacture readiness or DAPI health from fallback', () => {
  const r = fixture(); r.evo = true;
  const view = evaluate(r);
  assert.equal(view.level, 'down');
  assert.equal(view.summary.masternodes.ready, 0);
  assert.equal(view.summary.dapi.ok, 0);
  assert.equal(view.summary.core.height, 100);
  assert.equal(view.summary.platform.height, 200);
});

test('private text in allowed-looking fields is rejected before persistence', () => {
  const r = fixture(); r.evo = true;
  r.core.subversion = 'PRIVATE-NODE-IDENTITY'; r.platform.version = '192.0.2.123';
  r.core.masternode = { state: 'PRIVATE-NODE-IDENTITY', type: '192.0.2.123' };
  r.dapi = { driveVersion: 'PRIVATE-NODE-IDENTITY', chainId: 'PRIVATE-NODE-IDENTITY' };
  r.components = { drive: { version: '192.0.2.123', running: true } };
  assert.doesNotMatch(JSON.stringify(validateMainnetReport(r, now)), /PRIVATE-NODE-IDENTITY|192\.0\.2\.123/);
});

test('service projection allowlists identity, fails stale/missing samples, preserves unknown', () => {
  const r = fixture();
  r.serviceChecks = { at: now/1000, services: [{ id: 'insight', ok: true, ms: 3, height: 100, password: 'SECRET' },
    { id: 'quorums', ok: false, reason: 'stale-data', url: 'https://SECRET' }, { id: 'observer', ok: null, reason: 'SECRET' },
    { id: 'seed-2', ok: false }, { id: 'seed-3', ok: false, reason: 'SECRET' }] };
  let endpoints = validateMainnetReport(r,now).endpoints;
  assert.equal(endpoints.find(e=>e.label.startsWith('Insight ·')).ok,true);
  assert.equal(endpoints.find(e=>e.label.startsWith('Quorums ·')).ok,false);
  assert.equal(endpoints.find(e=>e.label.startsWith('Independent')).ok,null);
  assert.equal(endpoints.find(e=>e.label.startsWith('Independent')).error,'not observed');
  assert.equal(endpoints.find(e=>e.label.startsWith('Quorums ·')).error,'stale-data');
  assert.equal(endpoints.find(e=>e.label.startsWith('Platform seed 1')).error,'monitor sample missing or stale');
  assert.equal(endpoints.find(e=>e.label.startsWith('Platform seed 1')).ok,false);
  for (const seed of ['Platform seed 2', 'Platform seed 3']) assert.deepEqual([endpoints.find(e=>e.label.startsWith(seed)).ok, endpoints.find(e=>e.label.startsWith(seed)).error], [false, 'probe-failed']);
  assert.doesNotMatch(JSON.stringify(endpoints),/SECRET/);
  assert.ok(endpoints.every(e=>typeof e.url==='string' && e.url.startsWith('https://')));
  assert.equal(endpoints.find(e=>e.label.startsWith('Insight ·')).status,'OK');
  r.serviceChecks.at -= 241;
  endpoints = validateMainnetReport(r,now).endpoints;
  assert.ok(endpoints.every(e=>e.ok===false && e.error==='monitor sample missing or stale'));
});

test('every Dash Core masternode state survives normalization', () => {
  for (const state of ['READY', 'WAITING_FOR_PROTX', 'POSE_BANNED', 'REMOVED', 'OPERATOR_KEY_CHANGED', 'PROTX_IP_CHANGED', 'ERROR', 'UNKNOWN']) {
    const r = fixture(); r.evo = true; r.core.masternode = { state, type: 'Evo', posePenalty: 0 };
    assert.equal(validateMainnetReport(r, now).hosts[0].probe.data.core.masternode.state, state);
  }
});

test('a stale Evo report is unreachable and says so on the observer row', () => {
  const r = fixture(); r.evo = true; r.core.masternode = { state: 'READY', type: 'Evo', posePenalty: 0 };
  const mainnet = DEFAULT_SETTINGS.networks.find((n) => n.name === 'mainnet'), state = validateMainnetReport(r, now);
  assert.equal(state.hosts[0].role, 'validator');
  assert.ok(!evaluateNetwork(mainnet, state, DEFAULT_SETTINGS, now).rows[0].reasons.some((x) => /stale/.test(x.text)));
  const view = evaluateNetwork(mainnet, state, DEFAULT_SETTINGS, now + 181_000);
  assert.equal(view.level, 'unreachable');
  assert.equal(view.rows[0].level, 'unreachable');
  assert.ok(view.rows[0].reasons.some((x) => x.level === 'unreachable' && x.text === 'mainnet observer report is stale'));
});

test('an impossible calendar date is not a report or block time', () => {
  const later = Date.parse('2026-10-01T08:00:00Z'), r = fixture();
  r.generatedAt = '2026-10-01T08:00:00+00:00'; r.platform.blockTime = '2026-02-30T12:00:00Z';
  const state = validateMainnetReport(r, later);
  assert.equal(state.generatedAt, '2026-10-01T08:00:00.000Z');
  assert.equal(state.hosts[0].probe.data.tenderdash.blockTime, null);
  assert.equal(Date.parse('2026-09-31T08:00:00Z'), later);
  assert.throws(() => validateMainnetReport({ ...r, generatedAt: '2026-09-31T08:00:00Z' }, later), /timestamp invalid/);
});

test('a version suffix is a short label, never an address; a Core user-agent comment is dropped', () => {
  const seen = (v) => { const r = fixture(); r.platform.version = v; r.core.subversion = `/Dash Core:${v}/`; const d = validateMainnetReport(r, now).hosts[0].probe.data; return [d.tenderdash.version, d.core.subversion]; };
  for (const v of ['23.0.2', '1.5.0-dev.2', '2.1.0-rc.1', '3.0.0-hotfix.1', '4.1.2', '1.2.3+build.5', '2.0.0-pr.1234', `1.2.3-${'a'.repeat(32)}`]) assert.deepEqual(seen(v), [v, `/Dash Core:${v}/`], v);
  assert.equal(seen('unreleased-2.0.0')[0], 'unreleased-2.0.0');
  for (const v of ['1.2.3-192.0.2.123', '1.2.3-10-0-0-5', '1.2.3+1.2.3.4', '1.2.3-rc192.0.2.123', '1.2.3-rc.10-0-0-5', '1.2.3-7', `1.2.3-${'a'.repeat(33)}`]) assert.deepEqual(seen(v), [null, null], v);
  const core = (subversion) => { const r = fixture(); r.core.subversion = subversion; return validateMainnetReport(r, now).hosts[0].probe.data.core.subversion; };
  assert.equal(core('/Dash Core:23.1.0/'), '/Dash Core:23.1.0/');
  assert.equal(core('/Dash Core:23.1.0(observer)/'), '/Dash Core:23.1.0/');
  assert.equal(core('/Dash Core:23.1.0-rc.2(PRIVATE-NODE-IDENTITY; 192.0.2.123)/'), '/Dash Core:23.1.0-rc.2/');
  for (const bad of ['/Dash Core:23.1.0(observer)(two)/', '/Dash Core:23.1.0(observer)x/', '/Dash Core:23.1.0(observer/', '/Dash Core:23.1.0-192.0.2.123(observer)/', '/Dash Core:(observer)/']) assert.equal(core(bad), null, bad);
});

test('a service sample fresh at ingest expires when read later; a still-fresh one stays OK', () => {
  const mainnet = DEFAULT_SETTINGS.networks.find((n) => n.name === 'mainnet'), r = fixture();
  const ids = ['quorums', 'insight', 'seed-1', 'seed-2', 'seed-3', 'bootstrap', 'quorums-tls', 'insight-tls', 'observer', 'core', 'platform', 'chainlocks'];
  r.serviceChecks = { at: now / 1000 - 200, services: ids.map((id) => ({ id, ok: true, ms: 3, height: 100 })) };
  r.serviceChecks.services[0] = { id: 'quorums', ok: null };
  const state = validateMainnetReport(r, now);
  assert.equal(state.endpoints.length, ids.length);
  assert.ok(state.endpoints.every((e) => e.sampledAt === r.serviceChecks.at));
  const view = (at) => { const e = evaluateNetwork(mainnet, state, DEFAULT_SETTINGS, at); return { level: e.level, endpoints: projectNetwork(mainnet, e, state, false).endpoints }; };
  const fresh = view(now + 40_000);
  assert.equal(fresh.level, 'ok');
  assert.deepEqual(fresh.endpoints.map((e) => e.ok), [null, ...ids.slice(1).map(() => true)]);
  assert.equal(fresh.endpoints[0].error, 'not observed');
  assert.deepEqual([fresh.endpoints[1].status, fresh.endpoints[1].ms, fresh.endpoints[1].height], ['OK', 3, 100]);
  const expired = view(now + 41_000);
  assert.equal(expired.level, 'warn');
  assert.ok(expired.endpoints.every((e) => e.ok === false && e.status === null && e.ms === null && e.error === 'monitor sample missing or stale'));
  assert.ok([...fresh.endpoints, ...expired.endpoints].every((e) => !('sampledAt' in e)));
  // Rows stored before the sample time was kept cannot be shown as OK.
  const legacy = { ...state, endpoints: state.endpoints.map((e) => ({ ...e, sampledAt: undefined })) };
  const old = evaluateNetwork(mainnet, legacy, DEFAULT_SETTINGS, now);
  assert.equal(old.level, 'warn');
  assert.ok(projectNetwork(mainnet, old, legacy, false).endpoints.every((e) => e.ok === false));
  // Other networks' endpoint rows pass through untouched.
  const other = [{ label: 'Seed', kind: 'dapi', url: 'https://seed.example', ok: true, status: 200, ms: 5 }];
  assert.deepEqual(evaluateNetwork(mainnet, { ...state, endpoints: other }, DEFAULT_SETTINGS, now + 41_000).endpoints, other);
});

test('a DAPI on another chain is a failed DAPI and its chain ID is never stored', () => {
  const evo = (dapi) => { const r = fixture(); r.evo = true; r.core.masternode = { state: 'READY', type: 'Evo', posePenalty: 0 }; r.dapi = { ok: true, height: 200, ...dapi }; return r; };
  const disagree = (view) => view.rows[0].reasons.some((x) => x.text === 'DAPI and consensus chain IDs disagree');
  const wrong = evo({ chainId: 'PRIVATE-OTHER-CHAIN' }), state = validateMainnetReport(wrong, now).hosts[0].probe.data.dapi;
  assert.deepEqual([state.ok, state.chainId], [false, 'other']);
  assert.doesNotMatch(JSON.stringify(validateMainnetReport(wrong, now)), /PRIVATE-OTHER-CHAIN/);
  assert.ok(disagree(evaluate(wrong)));
  assert.equal(evaluate(wrong).level, 'down');
  assert.deepEqual(evaluate(wrong).summary.dapi, { ok: 0, total: 1 });
  for (const [dapi, chainId] of [[{ chainId: 'evo1' }, 'evo1'], [{}, null], [{ chainId: '' }, null]]) {
    const right = evo(dapi), stored = validateMainnetReport(right, now).hosts[0].probe.data.dapi;
    assert.deepEqual([stored.ok, stored.chainId], [true, chainId]);
    assert.ok(!disagree(evaluate(right)));
    assert.deepEqual(evaluate(right).summary.dapi, { ok: 1, total: 1 });
  }
});
