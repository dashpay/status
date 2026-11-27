import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveIssues, reconcile, publicIssues, apiAuthorized, loadIncidentState, saveIncidentState } from './incidents.js';
import { cycle } from './incident-service.js';
import { recognizeActivity, SETTLE_MS } from './change-activity.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
const now = Date.parse('2026-10-02T12:00:00Z'), at = new Date(now).toISOString();
const fault = { id: 'a'.repeat(24), domain: 'network', scope: 'testnet', target: 'private-host', code: 'host_health', severity: 'critical', sourceKey: 'test-source', observedAt: at, evidence: { secret: 'must-not-be-public' } };
const stamp = (ms) => new Date(ms).toISOString();
const positive = (id, ms, extras = {}) => ({ issues: [], sources: { proof: { fresh: true, complete: true, observedAt: stamp(ms) } },
  checks: { [id]: { clear: true, sourceKey: 'proof', observedAt: stamp(ms), ...extras } } });

test('stable identity and revision, restart persistence, recovery requires positive fresh complete evidence', () => {
  let s = reconcile(null, { issues: [fault], sources: {} }, now);
  assert.deepEqual([s.issues[0].id, s.issues[0].revision, s.issues[0].lastEventAt], [fault.id, 1, at]);
  assert.deepEqual(s.outbox, [], 'nothing waits to be sent; the list itself stays for the release that reads it');
  s = reconcile(JSON.parse(JSON.stringify(s)), { issues: [fault], sources: {} }, now + 60_000);
  assert.equal(s.issues[0].revision, 1);
  // A fault that only lasts is not revised, however long.
  const lasting = reconcile(s, { issues: [fault], sources: {} }, now + 7 * 3600_000).issues[0];
  assert.deepEqual([lasting.revision, lasting.lastEventAt, lasting.lastSeen], [1, at, stamp(now + 7 * 3600_000)]);
  for (const source of [undefined, { fresh: false, complete: true }, { fresh: true, complete: false }]) {
    s = reconcile(s, { issues: [], sources: { 'test-source': source } }, now + 90_000);
    assert.equal(s.issues[0].status, 'open');
  }
  s = reconcile(s, { issues: [], sources: { 'test-source': { fresh: true, complete: true } } }, now + 120_000);
  assert.equal(s.issues[0].status, 'open', 'fresh source alone is not positive recovery');
  s = reconcile(s, positive(fault.id, now + 120_000), now + 120_000);
  assert.equal(s.issues[0].status, 'resolved'); assert.equal(s.issues[0].revision, 2);
  s = reconcile(s, { issues: [{ ...fault, observedAt: stamp(now + 180_000) }], sources: {} }, now + 180_000);
  assert.deepEqual([s.issues[0].status, s.issues[0].revision, s.issues[0].firstSeen], ['open', 3, at], 'reopened: the same case, one revision on');
});

test('public issues never expose evidence, targets, raw summaries or private networks', () => {
  const s = { generatedAt: at, issues: [{ ...fault, summary: 'injected secret' }, { ...fault, scope: 'private-net' }, { ...fault, domain: 'ci' }, { ...fault, domain: 'aws' }] };
  const body = JSON.stringify(publicIssues(s, ['testnet']));
  for (const text of ['must-not-be-public', 'injected', 'private-host', 'private-net', 'sourceKey', 'evidence']) assert.ok(!body.includes(text));
  assert.equal(JSON.parse(body).issues.length, 3);
  assert.equal(apiAuthorized('Bearer x', 'x'), true); assert.equal(apiAuthorized('Bearer x', ''), false);
});

test('missing sources and never-seen CI reporters are issues, not empty healthy fleets', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const d = deriveIssues({ settings, states: {}, ci: { reporters: [{ id: 'new-host' }], hosts: [], runners: [], recent: [] }, now });
  assert.equal(d.issues.filter((i) => i.code === 'collector_stale').length, settings.networks.length);
  for (const code of ['reporter_missing', 'queue_stale', 'aws_stale', 'aws_health_missing']) assert.ok(d.issues.some((i) => i.code === code), code);
});

test('partial AWS pagination errors prevent unsafe recovery and idle cleanup candidates', () => {
  const aws = { at, errors: [{ region: 'us-west-2', scope: 'ec2:DescribeVolumes', error: 'AccessDenied' }], volumes: [{ id: 'vol-1', state: 'available' }], health: { at, errors: [], instances: [{ id: 'i-1', region: 'us-west-2', systemStatus: 'impaired' }], alarms: [{ name: 'ALB', region: 'us-west-2', state: 'ALARM' }] } };
  const d = deriveIssues({ settings: { ...DEFAULT_SETTINGS, networks: [] }, states: {}, aws, now });
  assert.equal(d.sources['aws:inventory'].complete, false);
  for (const code of ['aws_collection_failed', 'aws_instance_impaired', 'aws_alarm']) assert.ok(d.issues.some((i) => i.code === code));
  assert.ok(!d.issues.some((i) => i.code === 'idle_volume'));
});

const emptyCi = { summary: () => ({ reporters: [], hosts: [], runners: [], recent: [] }) };
function dataDirFor(t, name) {
  const dataDir = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, 'incidents'));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(DEFAULT_SETTINGS));
  return dataDir;
}

test('a cycle derives and saves, and calls nobody', async (t) => {
  const dataDir = dataDirFor(t, 'incidents-');
  const called = t.mock.method(globalThis, 'fetch', async () => { throw new Error('the sidecar sends nothing'); });
  const result = await cycle({ dataDir, ci: emptyCi, now });
  const state = loadIncidentState(dataDir);
  assert.equal(called.mock.callCount(), 0);
  assert.ok(state.issues.length > 0 && state.issues.every((i) => i.status === 'open' && i.revision === 1));
  assert.deepEqual(result, { active: state.issues.length });
  assert.deepEqual([state.generatedAt, state.outbox, state.delivery, 'quarantined' in state], [at, [], { configured: false }, false]);
});

test('the first cycle over a state of the release that still sent events sheds them; cases keep their ids, revisions and times', async (t) => {
  const dataDir = dataDirFor(t, 'incidents-shed-');
  await cycle({ dataDir, ci: emptyCi, now: now - 6 * 86400_000 });
  const before = loadIncidentState(dataDir);
  // Nine days without a receiver, as that release left it: every case reminded
  // every six hours, each reminder an event that waits; some events set aside;
  // the receiver's last answer; the record of it not answering.
  const waiting = (issue, revision) => ({ schemaVersion: 1, eventId: `${issue.id}:${revision}`, occurredAt: at, transition: 'reminder', issue: { ...issue, revision, evidence: { text: 'x'.repeat(1500) } } });
  const gone = { id: 'f'.repeat(24), domain: 'ci', scope: 'github', target: 'dashpay/platform/7', code: 'queue_wait' };
  const each = Math.ceil(4200 / before.issues.length);
  const old = { ...before,
    issues: before.issues.map((i) => ({ ...i, revision: each, lastEventAt: stamp(now - 3600_000) })),
    revisionCounters: Object.fromEntries(before.issues.map((i) => [i.id, each])),
    outbox: before.issues.flatMap((i) => Array.from({ length: each }, (_, n) => waiting(i, n + 1))),
    quarantined: [{ event: waiting(before.issues[0], 3), at, reason: 'event exceeds delivery byte budget' }, { event: waiting(gone, 12), at, reason: 'owner-configured remediation exclusion' }],
    delivery: { configured: true, attempts: 794, nextAttemptAt: stamp(now + 600_000), lastAttemptAt: at, lastAckAt: stamp(now - 9 * 86400_000), error: 'receiver HTTP 502',
      receiver: { workerAt: (now - 9 * 86400_000) / 1000, control: { seq: 9, dispatch: 'on', clearSeq: 2 }, releaseRepositories: ['dashpay/platform'], remediation: { schemaVersion: 1, cases: before.issues.map((i) => ({ issueId: i.id, workerState: 'queued', pendingEvents: each })) } } },
    stall: { since: stamp(now - 9 * 86400_000), notifiedAt: stamp(now - 9 * 86400_000), reasons: [{ code: 'receiver_unreachable', detail: 'x' }] } };
  assert.ok(old.outbox.length > 4000);
  saveIncidentState(dataDir, old);
  const file = join(dataDir, 'incidents', 'state.json'), size = statSync(file).size;
  await cycle({ dataDir, ci: emptyCi, now });
  const after = loadIncidentState(dataDir);
  assert.deepEqual([after.outbox, 'quarantined' in after, after.delivery, 'stall' in after], [[], false, { configured: false }, false]);
  assert.ok(statSync(file).size < size / 50, 'the file is a fraction of what it was');
  const kept = (s) => s.issues.map((i) => [i.id, i.revision, i.status, i.firstSeen, i.lastEventAt, i.resolvedAt]);
  assert.deepEqual(kept(after), kept(old), 'no case is renumbered, reopened, ended or dated anew');
  assert.ok(after.issues.every((i) => i.lastSeen === at && i.firstSeen === stamp(now - 6 * 86400_000)));
  assert.deepEqual(after.revisionCounters, { ...old.revisionCounters, [gone.id]: 12 }, 'a revision remembered only in an event that was set aside is still counted from');
  // The next change of a case is numbered from where it was.
  const id = after.issues[0].id, next = reconcile(after, positive(id, now + 60_000), now + 60_000).issues.find((i) => i.id === id);
  assert.deepEqual([next.status, next.revision], ['resolved', each + 1]);
});

test('the sidecar starts and keeps a state with the receiver\'s settings still in its environment', async (t) => {
  const dataDir = dataDirFor(t, 'incidents-start-');
  const index = fileURLToPath(new URL('./index.js', import.meta.url));
  const child = spawn(process.execPath, [index], { stdio: 'ignore', env: { ...process.env, STATUS_MODE: 'incidents', STATUS_DATA_DIR: dataDir,
    INCIDENT_WEBHOOK_URL: 'https://receiver.example-tailnet.ts.net:8444/v1/events', INCIDENT_HMAC_FILE: join(dataDir, 'absent-hmac'), INCIDENT_ALERT_WEBHOOK_FILE: join(dataDir, 'absent-alert') } });
  t.after(() => child.kill());
  const file = join(dataDir, 'incidents', 'state.json');
  for (let n = 0; n < 150 && !existsSync(file) && child.exitCode === null; n++) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(child.exitCode, null, 'still running');
  const state = loadIncidentState(dataDir);
  assert.ok(Number.isFinite(Date.parse(state.generatedAt)) && state.issues.length > 0);
  assert.deepEqual([state.outbox, state.delivery], [[], { configured: false }]);
});

const settingsFor = (overrides = {}) => ({ ...structuredClone(DEFAULT_SETTINGS), networks: [{
  name: 'testnet', chainType: 'testnet', coreNetwork: 'test', endpoints: [{ label: 'API', url: 'https://api.example.org/' }], ...overrides,
}] });
const host = (ms, data = {}, overrides = {}) => ({ name: 'explorer-1', instanceId: 'i-one', state: 'running', role: 'service',
  probe: { at: stamp(ms), ok: true, data }, ...overrides });
const network = (ms, hosts = [], endpoints = []) => ({ generatedAt: stamp(ms), discovery: { at: stamp(ms), error: null }, hosts, endpoints });
const deriveNetwork = (ms, state, options = {}) => deriveIssues({ settings: settingsFor(options), states: { testnet: state }, now: ms });
const byCode = (s, code) => s.issues.filter((i) => i.code === code);
const ciHost = (ms, overrides = {}) => ({ reporters: [{ id: 'shared' }], hosts: [{ id: 'shared', receivedAt: stamp(ms), measuredAt: stamp(ms),
  disks: [{ path: '/', total: 100, free: 5 }], memTotal: 100, memUsed: 30, ...overrides }],
  runners: [{ host: 'shared', name: 'runner', receivedAt: stamp(ms), status: 'idle' }], recent: [] });
const deriveCi = (ms, ci) => deriveIssues({ settings: { ...DEFAULT_SETTINGS, networks: [] }, states: {}, ci, now: ms });

test('same or older positive measurement cannot recover or reopen; future clocks fail closed', () => {
  const initial = reconcile(null, { issues: [fault] }, now);
  for (const ms of [now - 1, now, now + 120_000]) {
    const next = reconcile(initial, positive(fault.id, ms), now + 30_000);
    assert.equal(next.issues[0].status, 'open', stamp(ms));
  }
  const recovered = reconcile(initial, positive(fault.id, now + 30_000), now + 30_000);
  const replayed = reconcile(recovered, { issues: [fault] }, now + 60_000);
  assert.equal(replayed.issues[0].status, 'resolved');
  assert.equal(replayed.issues[0].revision, 2);
});

test('revisions survive issue display retention and process restart, and go on from an event an earlier release left waiting', () => {
  let s = reconcile(null, { issues: [fault] }, now);
  s = reconcile(s, positive(fault.id, now + 1000), now + 1000);
  s = reconcile(JSON.parse(JSON.stringify(s)), { issues: [] }, now + 31 * 86400_000);
  assert.equal(s.issues.length, 0);
  s = reconcile(s, { issues: [{ ...fault, observedAt: stamp(now + 32 * 86400_000) }] }, now + 32 * 86400_000);
  assert.equal(s.issues[0].revision, 3);
  for (const left of [{ outbox: [{ issue: { ...fault, revision: 9 } }] }, { outbox: [], quarantined: [{ event: { issue: { ...fault, revision: 9 } } }] }]) {
    const migrated = reconcile({ schemaVersion: 1, issues: [], ...left }, { issues: [fault] }, now);
    assert.deepEqual([migrated.issues[0].revision, migrated.outbox, migrated.quarantined], [10, [], undefined]);
  }
});

test('maintenance holds a case unrevised, retains active incidents, and requires post-maintenance proof', () => {
  const failing = network(now, [host(now, { services: [{ service: 'indexer', ok: false }] })]);
  let s = reconcile(null, deriveNetwork(now, failing), now);
  const id = byCode(s, 'host_health')[0].id;
  const count = s.issues.find((i) => i.id === id).revision;
  const paused = network(now + 60_000, [host(now + 60_000, { services: [{ service: 'indexer', ok: true }] })]);
  s = reconcile(s, deriveNetwork(now + 60_000, paused, { lifecycle: { status: 'services' } }), now + 60_000);
  assert.equal(s.issues.find((i) => i.id === id).status, 'open');
  assert.equal(s.issues.find((i) => i.id === id).suppressed, true);
  assert.equal(s.issues.find((i) => i.id === id).revision, count);
  s = reconcile(s, deriveNetwork(now + 90_000, paused), now + 90_000);
  assert.equal(s.issues.find((i) => i.id === id).status, 'open', 'a sample measured during maintenance is not recovery');
  const after = network(now + 120_000, [host(now + 120_000, { services: [{ service: 'indexer', ok: true }] })]);
  s = reconcile(s, deriveNetwork(now + 120_000, after), now + 120_000);
  assert.equal(s.issues.find((i) => i.id === id).status, 'resolved');
  const muted = reconcile(null, deriveNetwork(now, failing, { lifecycle: { status: 'creating' } }), now);
  assert.equal(byCode(muted, 'host_health')[0].status, 'open');
  assert.ok(muted.issues.filter((i) => i.domain === 'network').every((i) => i.revision === undefined), 'a case held from its first sight has no revision yet');
  const active = reconcile(muted, deriveNetwork(now + 60_000, network(now + 60_000, [host(now + 60_000, failing.hosts[0].probe.data)])), now + 60_000);
  assert.equal(byCode(active, 'host_health')[0].revision, 1);
});

test('a recognised reboot holds the host, its endpoint and its instance; a fault that outlives the settle window is released', () => {
  const settings = settingsFor();
  const step = (ms, bootedAt, previous) => {
    const state = network(ms, [host(ms, { services: [{ service: 'indexer', ok: false }], system: { uptime: (ms - bootedAt) / 1000 } })], [{ label: 'API', kind: 'http', ok: false }]);
    const activity = recognizeActivity({ settings, states: { testnet: state }, previous, now: ms });
    const impaired = (id) => ({ id, region: 'us-west-2', state: 'running', instanceStatus: 'impaired', systemStatus: 'ok' });
    const aws = { at: stamp(ms), errors: [], volumes: [], addresses: [], health: { at: stamp(ms), errors: [], alarms: [], instances: [impaired('i-one'), impaired('i-other')] } };
    return { activity, derived: deriveIssues({ settings, states: { testnet: state }, activity, aws, now: ms }) };
  };
  const first = step(now, now - 120_000);
  assert.equal(first.activity.hosts['testnet/i-one'].held, true);
  let s = reconcile(null, first.derived, now);
  // Released from every hold at least once: such a case has a revision.
  const emitted = (code, target) => s.issues.filter((i) => i.revision && i.code === code && (!target || i.target === target)).length;
  assert.equal(emitted('host_health'), 0); assert.equal(emitted('endpoint_failed'), 0);
  assert.equal(emitted('aws_instance_impaired', 'i-one'), 0);
  assert.equal(emitted('aws_instance_impaired', 'i-other'), 1, 'an unrelated instance stays actionable');
  assert.equal(byCode(s, 'host_health')[0].suppressed, true);
  assert.equal(byCode(s, 'host_health')[0].status, 'open', 'a held fault is never treated as recovered');
  const later = step(now + SETTLE_MS, now - 120_000, first.activity);
  assert.deepEqual(later.activity.hosts, {});
  s = reconcile(s, later.derived, now + SETTLE_MS);
  assert.equal(emitted('host_health'), 1); assert.equal(emitted('endpoint_failed'), 1);
  assert.equal(emitted('aws_instance_impaired', 'i-one'), 1);
});

test('a journal claim is held only through the bounded activity result, and a collector gap keeps a held instance held', () => {
  const settings = settingsFor();
  const claimed = { ...network(now, [host(now, {})]), journal: { owner: 'dashnet-runner' } };
  const suppressedWith = (activity) => deriveIssues({ settings, states: { testnet: claimed }, activity, now }).suppressions.testnet;
  assert.equal(suppressedWith(undefined), true, 'callers without recognition keep the plain claim');
  assert.equal(suppressedWith(recognizeActivity({ settings, states: { testnet: claimed }, now })), true);
  assert.equal(suppressedWith({ networks: { testnet: { held: false } }, hosts: {} }), false, 'a claim older than the cap no longer silences the network');
  // The network snapshot is stale, but the host hold from the previous cycle continues.
  const stale = network(now - 600_000, [host(now - 600_000, {})]);
  const activity = { networks: {}, hosts: { 'testnet/i-one': { held: true, network: 'testnet', instanceId: 'i-one' } } };
  const impaired = (id) => ({ id, region: 'us-west-2', state: 'running', instanceStatus: 'impaired', systemStatus: 'ok' });
  const aws = { at, errors: [], volumes: [], addresses: [], health: { at, errors: [], alarms: [], instances: [impaired('i-one'), impaired('i-other')] } };
  const s = reconcile(null, deriveIssues({ settings, states: { testnet: stale }, activity, aws, now }), now);
  const emitted = s.issues.filter((i) => i.revision && i.code === 'aws_instance_impaired').map((i) => i.target);
  assert.deepEqual(emitted, ['i-other']);
  assert.ok(s.issues.some((i) => i.revision && !i.suppressed && i.code === 'collector_stale'), 'the collector gap itself is still reported');
});

test('a stale network snapshot retains individual host and endpoint holds without asserting recovery', () => {
  const settings = settingsFor();
  const state = network(now, [host(now, { services: [{ service: 'indexer', ok: false }] })], [{ label: 'API', kind: 'http', ok: false }]);
  let initial = reconcile(null, deriveIssues({ settings, states: { testnet: state }, now }), now);
  const activity = { networks: {}, hosts: { 'testnet/i-one': { held: true, network: 'testnet', instanceId: 'i-one' } } };
  initial = reconcile(initial, deriveIssues({ settings, states: { testnet: state }, activity, now: now + 60_000 }), now + 60_000);
  const stale = { ...state, generatedAt: stamp(now - 600_000) };
  const after = reconcile(initial, deriveIssues({ settings, states: { testnet: stale }, activity, now: now + 120_000 }), now + 120_000);
  for (const code of ['host_health', 'endpoint_failed']) {
    assert.equal(byCode(after, code)[0].suppressed, true, code);
    assert.equal(byCode(after, code)[0].status, 'open', code);
  }
  const ended = reconcile(after, deriveIssues({ settings, states: { testnet: stale }, activity: { networks: {}, hosts: {} }, now: now + 180_000 }), now + 180_000);
  for (const code of ['host_health', 'endpoint_failed']) assert.equal(byCode(ended, code)[0].suppressed, false, code);
});

test('omitted endpoint, skipped/stopped host, or malformed nested report cannot recover', () => {
  const state = network(now, [host(now, { services: [{ service: 'indexer', ok: false }] })], [{ label: 'API', kind: 'http', ok: false }]);
  const initial = reconcile(null, deriveNetwork(now, state), now);
  for (const h of [host(now + 60_000, {}), host(now + 60_000, {}, { state: 'stopped' }),
    host(now + 60_000, {}, { probe: { ok: true, skipped: true, at: stamp(now + 60_000), data: {} } }), host(now + 60_000, { services: {} })]) {
    const s = reconcile(initial, deriveNetwork(now + 60_000, network(now + 60_000, [h])), now + 60_000);
    assert.ok(byCode(s, 'host_health').every((i) => i.status === 'open'));
    assert.ok(byCode(s, 'endpoint_failed').every((i) => i.status === 'open'));
  }
  const healthy = network(now + 60_000, [host(now + 60_000, { services: [{ service: 'indexer', ok: true }] })], [{ label: 'API', kind: 'http', ok: true }]);
  const recovered = reconcile(initial, deriveNetwork(now + 60_000, healthy), now + 60_000);
  assert.ok(byCode(recovered, 'host_health').every((i) => i.status === 'resolved'));
  assert.ok(byCode(recovered, 'endpoint_failed').every((i) => i.status === 'resolved'));
});

test('changed fault set revises the case at once, numeric prose does not; omitted old rule persists', () => {
  const data = (used, extra = []) => ({ system: { disks: [{ mount: '/', size: 100, used }] }, services: extra });
  let s = reconcile(null, deriveNetwork(now, network(now, [host(now, data(90))])), now);
  const id = byCode(s, 'host_health')[0].id;
  const revision = () => s.issues.find((i) => i.id === id).revision;
  s = reconcile(s, deriveNetwork(now + 30_000, network(now + 30_000, [host(now + 30_000, data(91))])), now + 30_000);
  assert.equal(revision(), 1);
  s = reconcile(s, deriveNetwork(now + 60_000, network(now + 60_000, [host(now + 60_000, data(91, [{ service: 'api', ok: false }]))])), now + 60_000);
  assert.deepEqual([revision(), byCode(s, 'host_health')[0].status, byCode(s, 'host_health')[0].lastEventAt], [2, 'open', stamp(now + 60_000)]);
  s = reconcile(s, deriveNetwork(now + 90_000, network(now + 90_000, [host(now + 90_000, { services: [{ service: 'api', ok: false }] })])), now + 90_000);
  assert.equal(byCode(s, 'host_health')[0].evidence.faults.length, 2, 'omitting disk must not erase the disk fault');
  s = reconcile(s, deriveNetwork(now + 120_000, network(now + 120_000, [host(now + 120_000, { services: [{ service: 'api', ok: true }] })])), now + 120_000);
  assert.equal(byCode(s, 'host_health')[0].status, 'open');
  s = reconcile(s, deriveNetwork(now + 150_000, network(now + 150_000, [host(now + 150_000, data(20, [{ service: 'api', ok: true }]))])), now + 150_000);
  assert.equal(byCode(s, 'host_health')[0].status, 'resolved');
});

test('instance, generation and endpoint resource changes cannot clear predecessor incidents', () => {
  const bad = (ms, instanceId) => network(ms, [host(ms, { services: [{ service: 'api', ok: false }] }, { instanceId })], [{ label: 'API', kind: 'http', ok: false }]);
  const initial = deriveNetwork(now, bad(now, 'i-one'), { generation: 1 });
  for (const [generation, instanceId] of [[2, 'i-one'], [1, 'i-two']]) {
    const next = deriveNetwork(now + 30_000, bad(now + 30_000, instanceId), { generation });
    assert.notEqual(byCode(initial, 'host_health')[0].id, byCode(next, 'host_health')[0].id);
  }
  const old = reconcile(null, initial, now);
  const healthy = network(now + 30_000, [host(now + 30_000, { services: [{ service: 'api', ok: true }] }, { instanceId: 'i-two' })], [{ label: 'API', kind: 'http', ok: true }]);
  const next = reconcile(old, deriveNetwork(now + 30_000, healthy, { generation: 1, endpoints: [{ label: 'API', url: 'https://new.example.org' }] }), now + 30_000);
  assert.ok(byCode(next, 'host_health').every((i) => i.status === 'open'));
  assert.ok(byCode(next, 'endpoint_failed').every((i) => i.status === 'open'));
});

test('CI omitted disks/runners and re-received old or future measurements never clear faults', () => {
  const failing = ciHost(now); failing.runners[0].status = 'offline';
  const initial = reconcile(null, deriveCi(now, failing), now);
  for (const overrides of [{ disks: [] }, { disks: [{ path: '/', total: 100, free: null }] },
    { disks: [{ path: '/', total: 100, free: 101 }] }, { measuredAt: at, disks: [{ path: '/', total: 100, free: 90 }] },
    { measuredAt: stamp(now - 600_000), disks: [{ path: '/', total: 100, free: 90 }] },
    { measuredAt: stamp(now + 180_000), disks: [{ path: '/', total: 100, free: 90 }] }]) {
    const ci = ciHost(now + 60_000, overrides); ci.runners = [];
    const s = reconcile(initial, deriveCi(now + 60_000, ci), now + 60_000);
    assert.equal(byCode(s, 'disk_pressure')[0].status, 'open', JSON.stringify(overrides));
    assert.equal(byCode(s, 'runner_offline')[0].status, 'open');
  }
  const good = ciHost(now + 60_000, { disks: [{ path: '/', total: 100, free: 90 }] });
  const s = reconcile(initial, deriveCi(now + 60_000, good), now + 60_000);
  assert.equal(byCode(s, 'disk_pressure')[0].status, 'resolved');
  assert.equal(byCode(s, 'runner_offline')[0].status, 'resolved');
});

test('CI reporter delivery freshness alone and stale per-host probe clocks are insufficient', () => {
  for (const measuredAt of [undefined, 'bad date', stamp(now + 120_000), stamp(now - 600_000)]) {
    const ci = ciHost(now, { measuredAt });
    assert.ok(byCode(deriveCi(now, ci), 'reporter_stale').length, String(measuredAt));
  }
  const d = deriveNetwork(now, network(now, [host(now - 600_000, { services: [{ service: 'api', ok: true }] })]));
  assert.equal(byCode(d, 'host_health')[0].severity, 'critical');
  assert.equal(d.sources['network:testnet:host:i-one'].fresh, false);
});

test('a job missing from a cut or partial queue listing is still waiting; an omitted failed job has not passed', () => {
  const ci = { ...ciHost(now), queue: { at, error: null, covered: ['dashpay/status'], windowMs: 86400_000, total: 1,
    jobs: [{ repo: 'dashpay/status', id: 3, createdAt: stamp(now - 3600_000), runCreatedAt: stamp(now - 3700_000) }] },
    recent: [{ host: 'shared', repo: 'dashpay/status', runId: 9, attempt: 1, name: 'build', runnerName: 'runner', start: stamp(now - 60_000), end: at, result: 'Failed' }] };
  const initial = reconcile(null, deriveCi(now, ci), now);
  const later = now + 120_000;
  // Not listed as waiting, but the listing cannot say it left: no repository
  // listed in full, another repository only, cut for display, failed, still
  // queued under labels we no longer serve, or from an older poller.
  const whole = { covered: ['dashpay/status'], total: 0, queued: [] };
  for (const queue of [{ ...whole, covered: [] }, { ...whole, covered: ['dashpay/other'] }, { ...whole, total: 60 }, { ...whole, error: 'GitHub 502' },
    { ...whole, queued: [3] }, { ...whole, queued: undefined }, { ...whole, windowMs: undefined }, { ...whole, covered: undefined }]) {
    const omitted = { ...ciHost(later), queue: { at: stamp(later), error: null, windowMs: 86400_000, jobs: [], ...queue }, recent: [] };
    const s = reconcile(initial, deriveCi(later, omitted), later);
    assert.equal(byCode(s, 'queue_wait')[0].status, 'open', JSON.stringify(queue));
    assert.equal(byCode(s, 'job_failed')[0].status, 'open', JSON.stringify(queue));
  }
  // Two whole listings in a row without it: it left.
  const absent = (ms) => deriveCi(ms, { ...ciHost(ms), queue: { at: stamp(ms), error: null, windowMs: 86400_000, jobs: [], ...whole }, recent: [] });
  const once = reconcile(initial, absent(later), later);
  assert.equal(byCode(once, 'queue_wait')[0].status, 'open');
  assert.equal(byCode(reconcile(once, absent(later + 120_000), later + 120_000), 'queue_wait')[0].resolutionEvidence.reason, 'left_queue');
  const moved = { ...ci, queue: { ...ci.queue, at: stamp(now + 60_000), jobs: [{ ...ci.queue.jobs[0], status: 'in_progress' }] } };
  const recovered = reconcile(initial, deriveCi(now + 60_000, moved), now + 60_000);
  assert.equal(byCode(recovered, 'queue_wait')[0].status, 'resolved');
});

test('only successful later attempt of same exact CI job resolves a failure even when both attempts are retained', () => {
  const failed = { host: 'shared', repo: 'dashpay/status', runId: 9, attempt: 1, name: 'build', runnerName: 'runner', start: stamp(now - 60_000), end: at, result: 'Failed' };
  const initial = reconcile(null, deriveCi(now, { ...ciHost(now), recent: [failed] }), now);
  for (const overrides of [{ name: 'other' }, { runId: 10 }, { attempt: 1 }, { result: 'Canceled' }]) {
    const success = { ...failed, result: 'Succeeded', attempt: 2, start: stamp(now + 20_000), end: stamp(now + 40_000), ...overrides };
    const s = reconcile(initial, deriveCi(now + 60_000, { ...ciHost(now + 60_000), recent: [failed, success] }), now + 60_000);
    assert.equal(byCode(s, 'job_failed')[0].status, 'open', JSON.stringify(overrides));
  }
  const success = { ...failed, result: 'Succeeded', attempt: 2, start: stamp(now + 20_000), end: stamp(now + 40_000) };
  const s = reconcile(initial, deriveCi(now + 60_000, { ...ciHost(now + 60_000), recent: [failed, success] }), now + 60_000);
  assert.equal(byCode(s, 'job_failed')[0].status, 'resolved');
  assert.equal(byCode(s, 'job_failed')[0].observedAt, success.end);
});

const explorer = (indexedHeight, chainHeight, overrides = {}) => ({ status: 200, indexerRunning: true, indexerState: 'running', indexerRestarting: false,
  indexerHealth: 'healthy', indexerId: 'container-one', indexerRestarts: 0, network: 'platform-test', indexedHeight, chainHeight, ...overrides });
const explorerState = (ms, e) => network(ms, [host(ms, { explorer: e })]);

test('explorer HTTP200 is not recovery: two independent healthy, progressing, bounded-lag samples survive restart', () => {
  let s = reconcile(null, deriveNetwork(now, explorerState(now, explorer(324, 350, { indexerRunning: false, indexerState: 'restarting', indexerRestarting: true }))), now);
  s = reconcile(s, deriveNetwork(now + 30_000, explorerState(now + 30_000, explorer(350, 352))), now + 30_000);
  assert.equal(byCode(s, 'host_health')[0].status, 'open');
  s = JSON.parse(JSON.stringify(s));
  s = reconcile(s, deriveNetwork(now + 60_000, explorerState(now + 60_000, explorer(350, 353))), now + 60_000);
  assert.equal(byCode(s, 'host_health')[0].status, 'open', 'constant indexed height is not readiness');
  s = reconcile(s, deriveNetwork(now + 90_000, explorerState(now + 90_000, explorer(352, 354))), now + 90_000);
  assert.equal(byCode(s, 'host_health')[0].status, 'resolved');
  assert.equal(Object.keys(s.explorerSamples).length, 1);
});

test('explorer replacement, restart, stale/replayed sample, regression, or chain lag prevents readiness', () => {
  let s = reconcile(null, deriveNetwork(now, explorerState(now, explorer(100, 130, { indexerRunning: false }))), now);
  s = reconcile(s, deriveNetwork(now + 30_000, explorerState(now + 30_000, explorer(130, 132))), now + 30_000);
  for (const [ms, e] of [[now + 60_000, explorer(132, 134, { indexerId: 'new' })], [now + 60_000, explorer(132, 134, { indexerRestarts: 1 })],
    [now + 30_000, explorer(132, 134)], [now + 60_000, explorer(129, 131)], [now + 60_000, explorer(132, 160)],
    [now + 240_000, explorer(132, 134)]]) {
    const next = reconcile(s, deriveNetwork(ms, explorerState(ms, e)), ms);
    assert.equal(byCode(next, 'host_health')[0].status, 'open', JSON.stringify([ms, e]));
  }
});

test('AWS absence, INSUFFICIENT_DATA, initializing checks and partial collection cannot resolve', () => {
  const make = (ms, instances, alarms, errors = []) => ({ at: stamp(ms), errors: [], regions: ['us-west-2'], volumes: [], addresses: [],
    health: { at: stamp(ms), errors, instances, alarms } });
  const deriveAws = (ms, aws) => deriveIssues({ settings: { ...DEFAULT_SETTINGS, networks: [] }, states: {}, aws, now: ms });
  const impaired = { region: 'us-west-2', id: 'i-one', state: 'running', instanceStatus: 'impaired', systemStatus: 'ok', events: [{ code: 'reboot', notBefore: at }] };
  const alarm = { region: 'us-west-2', name: 'api', state: 'ALARM' };
  const initial = reconcile(null, deriveAws(now, make(now, [impaired], [alarm])), now);
  for (const snapshot of [make(now + 60_000, [], []), make(now + 60_000, [{ ...impaired, instanceStatus: 'initializing', events: undefined }], [{ ...alarm, state: 'INSUFFICIENT_DATA' }]),
    make(now + 60_000, [{ ...impaired, instanceStatus: 'ok', events: [] }], [{ ...alarm, state: 'OK' }], [{ region: 'us-west-2', scope: 'ec2:DescribeInstanceStatus', error: 'pagination failed' }])]) {
    const next = reconcile(initial, deriveAws(now + 60_000, snapshot), now + 60_000);
    for (const code of ['aws_instance_impaired', 'aws_alarm', 'aws_scheduled_event']) assert.equal(byCode(next, code)[0].status, 'open');
  }
  const healthy = make(now + 60_000, [{ ...impaired, instanceStatus: 'ok', events: [] }], [{ ...alarm, state: 'OK' }]);
  const recovered = reconcile(initial, deriveAws(now + 60_000, healthy), now + 60_000);
  for (const code of ['aws_instance_impaired', 'aws_alarm', 'aws_scheduled_event']) assert.equal(byCode(recovered, code)[0].status, 'resolved');
});

test('new fault during maintenance revises the case after the maintenance, not on a replayed sample from it', () => {
  const data = (service) => ({ services: [{ service, ok: false }] });
  let s = reconcile(null, deriveNetwork(now, network(now, [host(now, data('api'))])), now);
  const count = byCode(s, 'host_health')[0].revision;
  s = reconcile(s, deriveNetwork(now + 30_000, network(now + 30_000, [host(now + 30_000, data('indexer'))]), { lifecycle: { status: 'services' } }), now + 30_000);
  const replay = network(now + 30_000, [host(now + 30_000, data('indexer'))]);
  s = reconcile(s, deriveNetwork(now + 60_000, replay), now + 60_000);
  assert.equal(byCode(s, 'host_health')[0].revision, count);
  assert.equal(byCode(s, 'host_health')[0].suppressed, true);
  s = reconcile(s, deriveNetwork(now + 90_000, network(now + 90_000, [host(now + 90_000, data('indexer'))])), now + 90_000);
  assert.deepEqual([byCode(s, 'host_health')[0].revision, byCode(s, 'host_health')[0].status], [count + 1, 'open']);
  assert.equal(byCode(s, 'host_health')[0].suppressed, false);
});

test('explorer maintenance invalidates pre-deployment baselines even when collector is stale', () => {
  let s = reconcile(null, deriveNetwork(now, explorerState(now, explorer(100, 130, { indexerRunning: false }))), now);
  s = reconcile(s, deriveNetwork(now + 30_000, explorerState(now + 30_000, explorer(130, 132))), now + 30_000);
  const stale = { ...explorerState(now + 30_000, explorer(130, 132)), generatedAt: stamp(now - 600_000) };
  s = reconcile(s, deriveNetwork(now + 60_000, stale, { lifecycle: { status: 'services' } }), now + 60_000);
  assert.equal(Object.keys(s.explorerSamples).length, 0);
  s = reconcile(s, deriveNetwork(now + 90_000, explorerState(now + 90_000, explorer(134, 136))), now + 90_000);
  assert.equal(byCode(s, 'host_health')[0].status, 'open');
  s = reconcile(s, deriveNetwork(now + 120_000, explorerState(now + 120_000, explorer(136, 138))), now + 120_000);
  assert.equal(byCode(s, 'host_health')[0].status, 'resolved');
});

test('malformed numeric host metrics cannot positively clear a grouped memory fault', () => {
  const bad = network(now, [host(now, { system: { memTotal: 100, memAvailable: 1 } })]);
  const initial = reconcile(null, deriveNetwork(now, bad), now);
  const invalid = network(now + 30_000, [host(now + 30_000, { system: { memTotal: 100, memAvailable: '90' } })]);
  const s = reconcile(initial, deriveNetwork(now + 30_000, invalid), now + 30_000);
  assert.equal(byCode(s, 'host_health')[0].status, 'open');
});

test('a crash loop stays actionable while a rolling change on other hosts holds the rest of the network', () => {
  const settings = settingsFor();
  const container = (startedAgo, extra = {}) => ({ name: 'core', running: true, state: 'running', restarting: false, restarts: 0, startedAt: stamp(now - startedAgo), ...extra });
  const node = (name, containers) => host(now, { services: [{ service: 'indexer', ok: false }], system: { uptime: 86_400 }, containers }, { name, instanceId: `i-${name}` });
  // mn-1 and mn-2 were recreated cleanly, mn-3 is in a restart loop, mn-4 was not touched.
  const state = network(now, [node('mn-1', [container(60_000)]), node('mn-2', [container(30_000)]), node('mn-3', [container(5_000, { restarts: 4 })]), node('mn-4', [container(86_400_000)])]);
  const activity = recognizeActivity({ settings, states: { testnet: state }, now });
  assert.deepEqual([activity.networks.testnet.held, activity.networks.testnet.reason], [true, 'rolling']);
  const impaired = (id) => ({ id, region: 'us-west-2', state: 'running', instanceStatus: 'impaired', systemStatus: 'ok' });
  const aws = { at, errors: [], volumes: [], addresses: [], health: { at, errors: [], alarms: [], instances: ['i-mn-1', 'i-mn-3', 'i-mn-4'].map(impaired) } };
  // Not held: such a case has a revision, and triage takes it as new.
  const emitted = (s, code) => s.issues.filter((i) => i.revision && !i.suppressed && i.code === code).map((i) => i.target).sort();
  const held = (s) => byCode(s, 'host_health').filter((i) => i.suppressed).map((i) => i.target).sort();
  const s = reconcile(null, deriveIssues({ settings, states: { testnet: state }, activity, aws, now }), now);
  assert.deepEqual(emitted(s, 'host_health'), ['mn-3'], 'only the crashing host is left actionable');
  assert.deepEqual(emitted(s, 'aws_instance_impaired'), ['i-mn-3'], 'and its instance check with it');
  assert.deepEqual(held(s), ['mn-1', 'mn-2', 'mn-4'], 'the rest of the network stays held, as an open issue');
  // The host was held with the others a minute ago; the crash loop releases it alone.
  const before = network(now - 60_000, state.hosts.map((h) => ({ ...h, probe: { ...h.probe, at: stamp(now - 60_000), data: { ...h.probe.data, containers: [container(h.name === 'mn-4' ? 86_400_000 : 90_000)] } } })));
  const earlier = recognizeActivity({ settings, states: { testnet: before }, now: now - 60_000 });
  assert.deepEqual(earlier.crashing, []);
  let rolling = reconcile(null, deriveIssues({ settings, states: { testnet: before }, activity: earlier, now: now - 60_000 }), now - 60_000);
  assert.deepEqual([emitted(rolling, 'host_health'), held(rolling)], [[], ['mn-1', 'mn-2', 'mn-3', 'mn-4']]);
  rolling = reconcile(rolling, deriveIssues({ settings, states: { testnet: state }, activity: recognizeActivity({ settings, states: { testnet: state }, previous: earlier, now }), now }), now);
  assert.deepEqual([emitted(rolling, 'host_health'), held(rolling)], [['mn-3'], ['mn-1', 'mn-2', 'mn-4']]);
  // A declared operation owns every host: restarts are part of it.
  const declared = reconcile(null, deriveIssues({ settings: settingsFor({ maintenance: { active: true } }), states: { testnet: state }, activity, aws, now }), now);
  assert.deepEqual([emitted(declared, 'host_health'), emitted(declared, 'aws_instance_impaired')], [[], []]);
  const claimed = { ...state, journal: { owner: 'dashnet-runner' } };
  const journal = recognizeActivity({ settings, states: { testnet: claimed }, now });
  assert.equal(journal.networks.testnet.reason, 'journal');
  assert.deepEqual(emitted(reconcile(null, deriveIssues({ settings, states: { testnet: claimed }, activity: journal, now }), now), 'host_health'), []);
});

test('CI remediation exclusions retain observations, leave the case unrevised, and are reversible', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const ci = { reporters: [{ id: 'strix-pasta' }, { id: 'other' }], hosts: [], runners: [], recent: [] };
  let d = deriveIssues({ settings, states: {}, ci, now });
  let s = reconcile(null, d, now);
  const id = s.issues.find((i) => i.scope === 'strix-pasta').id;
  const revision = () => s.issues.find((i) => i.id === id).revision;
  assert.equal(revision(), 1);
  settings.remediation = { excludedCiHosts: ['strix-pasta'] };
  d = deriveIssues({ settings, states: {}, ci, now: now + 60_000 });
  assert.ok(d.issues.some((i) => i.id === id), 'observations retained');
  s = reconcile(s, d, now + 60_000);
  assert.equal(s.issues.find((i) => i.id === id).status, 'open');
  assert.equal(s.issues.find((i) => i.id === id).suppressed, true);
  assert.equal(s.issues.find((i) => i.id === id).remediationExcluded, true);
  assert.deepEqual([revision(), s.quarantined], [1, undefined], 'nothing is set aside for it');
  assert.deepEqual(s.issues.filter((i) => i.scope === 'other').map((i) => [i.suppressed, i.remediationExcluded, i.revision]), [[false, false, 1]]);
  s = reconcile(JSON.parse(JSON.stringify(s)), d, now + 120_000);
  assert.equal(revision(), 1);
  settings.remediation.excludedCiHosts = [];
  d = deriveIssues({ settings, states: {}, ci, now: now + 180_000 });
  s = reconcile(s, d, now + 180_000);
  assert.deepEqual([s.issues.find((i) => i.id === id).remediationExcluded, s.issues.find((i) => i.id === id).suppressed, revision()], [false, false, 2]);
});
