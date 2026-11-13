import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeActivity, hostSignals, SETTLE_MS, HOST_HOLD_MAX_MS, NETWORK_HOLD_MAX_MS } from './change-activity.js';

const now = Date.parse('2026-11-13T12:00:00Z'), iso = (ms) => new Date(ms).toISOString();
const settings = { networks: [{ name: 'testnet', chainType: 'testnet' }, { name: 'mainnet', chainType: 'mainnet', kind: 'external' }] };
const container = (name, startedAgo, extra = {}, at = now) => ({ name, running: true, state: 'running', restarting: false, restarts: 0, startedAt: iso(at - startedAgo), ...extra });
const host = (name, containers = [], extra = {}, at = now) => ({ name, instanceId: `i-${name}`, state: 'running',
  probe: { ok: true, at: iso(at), data: { system: { uptime: 86_400 }, containers } }, ...extra });
const recognise = (hosts, previous, at = now, journal) => recognizeActivity({ settings, states: { testnet: { hosts, journal }, mainnet: { hosts } }, previous, now: at });

test('a recreated container or a reboot is a planned change; a crash loop, an old start or a failed probe is not', () => {
  const kinds = (h) => hostSignals(h, now).map((s) => s.kind);
  assert.deepEqual(kinds(host('a', [container('quorums', 120_000)])), ['container']);
  assert.deepEqual(kinds(host('a', [container('quorums', 120_000, { restarts: 3 })])), [], 'restart-policy restarts are a crash loop');
  assert.deepEqual(kinds(host('a', [container('quorums', 120_000, { restarting: true })])), []);
  assert.deepEqual(kinds(host('a', [container('quorums', 120_000, { running: false, state: 'exited' })])), [], 'started and died is not an upgrade');
  assert.deepEqual(kinds(host('a', [container('quorums', 120_000, { oneShot: true })])), []);
  assert.deepEqual(kinds(host('a', [container('quorums', SETTLE_MS)])), [], 'outside the settle window');
  const rebooted = host('a'); rebooted.probe.data.system.uptime = 300;
  assert.deepEqual(kinds(rebooted), ['reboot']);
  assert.deepEqual(kinds(host('a', [container('quorums', 120_000)], { probe: { ok: false, at: iso(now), error: 'timeout' } })), []);
  const stale = host('a', [container('quorums', 120_000)]); stale.probe.at = iso(now - 200_000);
  assert.deepEqual(kinds(stale), [], 'only a fresh observation recognises a change');
});

test('one upgraded host is held alone, Mainnet is never held, and the hold ends by itself', () => {
  const first = recognise([host('services', [container('quorums', 60_000)]), host('seed-1', [container('core', 86_400_000)])]);
  assert.deepEqual(Object.keys(first.hosts), ['testnet/i-services']);
  assert.equal(first.hosts['testnet/i-services'].held, true);
  assert.deepEqual(first.networks, {}, 'a single host does not hold the network');
  // A probe gap inside the window neither ends nor restarts the hold.
  const gap = recognise([host('services', [], { probe: { ok: false, at: iso(now + 60_000), error: 'timeout' } }, now + 60_000)], first, now + 60_000);
  assert.equal(gap.hosts['testnet/i-services'].held, true);
  assert.equal(gap.hosts['testnet/i-services'].since, first.hosts['testnet/i-services'].since);
  const after = recognise([host('services', [container('quorums', 60_000 + SETTLE_MS, {}, now + SETTLE_MS)], {}, now + SETTLE_MS)], gap, now + SETTLE_MS);
  assert.deepEqual(after.hosts, {});
});

test('a rolling change across hosts holds the whole network only while it lasts', () => {
  const rolling = recognise([host('mn-1', [container('core', 60_000)]), host('mn-2', [container('core', 30_000)]), host('mn-3')]);
  assert.equal(rolling.networks.testnet.held, true);
  assert.equal(rolling.networks.testnet.reason, 'rolling');
  const done = recognise([host('mn-1', [], {}, now + SETTLE_MS), host('mn-2', [], {}, now + SETTLE_MS)], rolling, now + SETTLE_MS);
  assert.notEqual(done.networks.testnet?.held, true);
});

test('a recreate loop cannot hold a host forever', () => {
  let state, at = now;
  for (; at - now <= HOST_HOLD_MAX_MS; at += 5 * 60_000) state = recognise([host('services', [container('quorums', 60_000, {}, at)], {}, at)], state, at);
  assert.equal(state.hosts['testnet/i-services'].held, false, 'the episode is capped although signals continue');
  assert.equal(recognise([host('services', [container('quorums', 60_000)])]).hosts['testnet/i-services'].held, true);
});

test('an external operation holds the network, settles after it releases the journal, and a failure is actionable at once', () => {
  const claimed = recognise([host('mn-1')], undefined, now, { owner: 'dashnet-runner' });
  assert.equal(claimed.networks.testnet.reason, 'journal');
  const released = recognise([host('mn-1', [], {}, now + 60_000)], claimed, now + 60_000, { owner: null });
  assert.equal(released.networks.testnet.held, true);
  assert.equal(released.networks.testnet.reason, 'settling');
  const settled = recognise([host('mn-1', [], {}, now + 60_000 + SETTLE_MS)], released, now + 60_000 + SETTLE_MS, { owner: null });
  assert.notEqual(settled.networks.testnet?.held, true);
  const failed = recognise([host('mn-1', [], {}, now + 60_000)], claimed, now + 60_000, { owner: null, lastError: 'stage failed' });
  assert.equal(failed.networks.testnet.held, false);
  // The failed operation recreated two hosts: they settle individually, but
  // they must not keep every other host's faults held through rolling inference.
  const recreated = (at) => [host('mn-1', [container('core', 30_000, {}, at)], {}, at), host('mn-2', [container('core', 30_000, {}, at)], {}, at), host('mn-3', [], {}, at)];
  const failedRolling = recognise(recreated(now + 60_000), claimed, now + 60_000, { owner: null, lastError: 'stage failed' });
  assert.deepEqual([failedRolling.networks.testnet.held, failedRolling.networks.testnet.reason], [false, 'failed']);
  assert.equal(failedRolling.hosts['testnet/i-mn-1'].held, true);
  assert.equal(recognise(recreated(now + 120_000), failedRolling, now + 120_000, { owner: null, lastError: 'stage failed' }).networks.testnet.held, false);
  let state, at = now;
  for (; at - now <= NETWORK_HOLD_MAX_MS; at += 10 * 60_000) state = recognise([host('mn-1', [], {}, at)], state, at, { owner: 'dashnet-runner' });
  assert.equal(state.networks.testnet.held, false, 'inference is bounded even while the claim remains');
});
