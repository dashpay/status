import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validateMainnetReport } from './mainnet.js';
import { evaluateNetwork } from './evaluate.js';
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
