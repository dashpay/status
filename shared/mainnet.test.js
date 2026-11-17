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
    { id: 'quorums', ok: false, reason: 'stale-data', url: 'https://SECRET' }, { id: 'observer', ok: null, reason: 'SECRET' }] };
  let endpoints = validateMainnetReport(r,now).endpoints;
  assert.equal(endpoints.find(e=>e.label.startsWith('Insight ·')).ok,true);
  assert.equal(endpoints.find(e=>e.label.startsWith('Quorums ·')).ok,false);
  assert.equal(endpoints.find(e=>e.label.startsWith('Independent')).ok,null);
  assert.equal(endpoints.find(e=>e.label.startsWith('Platform seed 1')).ok,false);
  assert.doesNotMatch(JSON.stringify(endpoints),/SECRET/);
  assert.ok(endpoints.every(e=>typeof e.url==='string' && e.url.startsWith('https://')));
  assert.equal(endpoints.find(e=>e.label.startsWith('Insight ·')).status,'OK');
  r.serviceChecks.at -= 241;
  endpoints = validateMainnetReport(r,now).endpoints;
  assert.ok(endpoints.every(e=>e.ok===false));
});
