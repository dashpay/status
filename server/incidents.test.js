import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIssues, reconcile, publicIssues, apiAuthorized, signedHeaders, validateDestination, loadIncidentState, saveIncidentState } from './incidents.js';
import { cycle } from './incident-service.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
const now = Date.parse('2026-10-02T12:00:00Z'), at = new Date(now).toISOString();
const fault = { id: 'a'.repeat(24), domain: 'network', scope: 'testnet', target: 'private-host', code: 'host_health', severity: 'critical', sourceKey: 'test-source', observedAt: at, evidence: { secret: 'must-not-be-public' } };
const stamp = (ms) => new Date(ms).toISOString();
const positive = (id, ms, extras = {}) => ({ issues: [], sources: { proof: { fresh: true, complete: true, observedAt: stamp(ms) } },
  checks: { [id]: { clear: true, sourceKey: 'proof', observedAt: stamp(ms), ...extras } } });

test('stable event identity, restart persistence, recovery requires positive fresh complete evidence', () => {
  let s = reconcile(null, { issues: [fault], sources: {} }, now);
  assert.equal(s.outbox.length, 1); assert.equal(s.outbox[0].eventId, `${fault.id}:1`);
  s = reconcile(JSON.parse(JSON.stringify(s)), { issues: [fault], sources: {} }, now + 60_000);
  assert.equal(s.outbox.length, 1);
  for (const source of [undefined, { fresh: false, complete: true }, { fresh: true, complete: false }]) {
    s = reconcile(s, { issues: [], sources: { 'test-source': source } }, now + 90_000);
    assert.equal(s.issues[0].status, 'open');
  }
  s = reconcile(s, { issues: [], sources: { 'test-source': { fresh: true, complete: true } } }, now + 120_000);
  assert.equal(s.issues[0].status, 'open', 'fresh source alone is not positive recovery');
  s = reconcile(s, positive(fault.id, now + 120_000), now + 120_000);
  assert.equal(s.issues[0].status, 'resolved'); assert.equal(s.outbox.at(-1).eventId, `${fault.id}:2`);
  s = reconcile(s, { issues: [{ ...fault, observedAt: stamp(now + 180_000) }], sources: {} }, now + 180_000);
  assert.equal(s.outbox.at(-1).transition, 'reopened'); assert.equal(s.outbox.at(-1).eventId, `${fault.id}:3`);
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

test('receiver URL cannot redirect evidence to an external URL or gateway control endpoint', () => {
  const receiver = 'https://receiver.example-tailnet.ts.net';
  assert.equal(validateDestination(`${receiver}:8444/v1/events`), `${receiver}:8444/v1/events`);
  assert.equal(validateDestination(`${receiver}:443/v1/events`), `${receiver}/v1/events`);
  assert.equal(validateDestination(`${receiver}/v1/events`), `${receiver}/v1/events`);
  for (const url of ['https://example.org/v1/events', 'http://100.86.131.91:8789/v1/events', 'https://100.86.131.91/v1/events',
    'http://receiver.example-tailnet.ts.net:8444/v1/events', 'https://receiver.example-tailnet.ts.net:8789/v1/events',
    'https://receiver.ts.net:8444/v1/events', 'https://a.b.c.ts.net/v1/events', 'https://receiver.example-tailnet.ts.net.evil.org/v1/events',
    'https://a:b@receiver.example-tailnet.ts.net:8444/v1/events', `${receiver}/hooks/agent`, `${receiver}/v1/events/`,
    `${receiver}/v1/events?token=x`, `${receiver}/v1/events#fragment`, `${receiver}/v1/events?`, `${receiver}/v1/events#`,
    'https://@receiver.example-tailnet.ts.net/v1/events', `${receiver}/hooks/../v1/events`]) assert.throws(() => validateDestination(url), url);
  const a = signedHeaders('{}', 'secret', now), b = signedHeaders('{"a":1}', 'secret', now);
  assert.notEqual(a['X-Dash-Signature'], b['X-Dash-Signature']);
});

test('outbox survives lost acknowledgement and drains only exact accepted events', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'incidents-'));
  mkdirSync(join(dataDir, 'incidents'));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(DEFAULT_SETTINGS));
  const ci = { summary: () => ({ reporters: [], hosts: [], runners: [], recent: [] }) };
  const destination = 'https://receiver.example-tailnet.ts.net:8444/v1/events';
  let received;
  await cycle({ dataDir, ci, destination, secret: 'test-secret', now, fetcher: async (_, opts) => { received = JSON.parse(opts.body); throw new Error('connection lost after acceptance'); } });
  const previous = loadIncidentState(dataDir);
  assert.equal(previous.outbox.length, received.events.length); assert.ok(previous.outbox.length > 0);
  await cycle({ dataDir, ci, destination, secret: 'test-secret', now: now + 60_000, fetcher: async (_, opts) => {
    assert.equal(opts.redirect, 'error'); const next = JSON.parse(opts.body);
    assert.deepEqual(next.events, received.events);
    return Response.json({ accepted: next.events.map((e) => e.eventId), health: { status: 'ok' } });
  } });
  assert.equal(loadIncidentState(dataDir).outbox.length, 0);
});

test('oversized poison events cannot starve byte-bounded delivery and quarantine survives restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'incidents-size-'));
  mkdirSync(join(dataDir, 'incidents'));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(DEFAULT_SETTINGS));
  const queued = Array.from({ length: 40 }, (_, n) => ({ schemaVersion: 1, eventId: `${'b'.repeat(24)}:${n + 1}`, issue: { ...fault, evidence: { text: 'x'.repeat(n === 0 ? 500_000 : 20_000) } } }));
  saveIncidentState(dataDir, { schemaVersion: 1, issues: [], outbox: queued });
  const params = { dataDir, ci: { summary: () => ({}) }, destination: 'https://receiver.example-tailnet.ts.net/v1/events', secret: 'test' };
  const sent = [];
  const fetcher = async (_, opts) => {
    assert.ok(Buffer.byteLength(opts.body) < 512 * 1024);
    const batch = JSON.parse(opts.body).events;
    assert.ok(batch.length > 0);
    sent.push(...batch.map((e) => e.eventId));
    return Response.json({ accepted: batch.map((e) => e.eventId) });
  };
  for (let n = 0; n < 3; n++) await cycle({ ...params, now: now + n * 60_000, fetcher });
  const state = loadIncidentState(dataDir);
  assert.equal(state.quarantined.length, 1);
  assert.equal(state.quarantined[0].event.eventId, queued[0].eventId);
  assert.equal(state.outbox.length, 0);
  assert.ok(queued.slice(1).every((e) => sent.includes(e.eventId)));
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
  assert.equal(replayed.outbox.length, 2);
});

test('revisions survive issue display retention, drained outbox and process restart', () => {
  let s = reconcile(null, { issues: [fault] }, now);
  s = reconcile(s, positive(fault.id, now + 1000), now + 1000);
  s.outbox = [];
  s = reconcile(JSON.parse(JSON.stringify(s)), { issues: [] }, now + 31 * 86400_000);
  assert.equal(s.issues.length, 0);
  s = reconcile(s, { issues: [{ ...fault, observedAt: stamp(now + 32 * 86400_000) }] }, now + 32 * 86400_000);
  assert.equal(s.outbox[0].eventId, `${fault.id}:3`);
  const migrated = reconcile({ schemaVersion: 1, issues: [], outbox: [{ issue: { ...fault, revision: 9 } }] }, { issues: [fault] }, now);
  assert.equal(migrated.outbox.at(-1).eventId, `${fault.id}:10`);
});

test('maintenance suppresses events, retains active incidents, and requires post-maintenance proof', () => {
  const failing = network(now, [host(now, { services: [{ service: 'indexer', ok: false }] })]);
  let s = reconcile(null, deriveNetwork(now, failing), now);
  const id = byCode(s, 'host_health')[0].id;
  const count = s.outbox.length;
  const paused = network(now + 60_000, [host(now + 60_000, { services: [{ service: 'indexer', ok: true }] })]);
  s = reconcile(s, deriveNetwork(now + 60_000, paused, { lifecycle: { status: 'services' } }), now + 60_000);
  assert.equal(s.issues.find((i) => i.id === id).status, 'open');
  assert.equal(s.issues.find((i) => i.id === id).suppressed, true);
  assert.equal(s.outbox.length, count);
  s = reconcile(s, deriveNetwork(now + 90_000, paused), now + 90_000);
  assert.equal(s.issues.find((i) => i.id === id).status, 'open', 'a sample measured during maintenance is not recovery');
  const after = network(now + 120_000, [host(now + 120_000, { services: [{ service: 'indexer', ok: true }] })]);
  s = reconcile(s, deriveNetwork(now + 120_000, after), now + 120_000);
  assert.equal(s.issues.find((i) => i.id === id).status, 'resolved');
  const muted = reconcile(null, deriveNetwork(now, failing, { lifecycle: { status: 'creating' } }), now);
  assert.equal(byCode(muted, 'host_health')[0].status, 'open');
  assert.equal(muted.outbox.filter((e) => e.issue.domain === 'network').length, 0);
  const active = reconcile(muted, deriveNetwork(now + 60_000, network(now + 60_000, [host(now + 60_000, failing.hosts[0].probe.data)])), now + 60_000);
  assert.equal(active.outbox.filter((e) => e.issue.code === 'host_health').length, 1);
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

test('changed fault set notifies immediately, numeric prose does not; omitted old rule persists', () => {
  const data = (used, extra = []) => ({ system: { disks: [{ mount: '/', size: 100, used }] }, services: extra });
  let s = reconcile(null, deriveNetwork(now, network(now, [host(now, data(90))])), now);
  const id = byCode(s, 'host_health')[0].id;
  const events = () => s.outbox.filter((e) => e.issue.id === id);
  s = reconcile(s, deriveNetwork(now + 30_000, network(now + 30_000, [host(now + 30_000, data(91))])), now + 30_000);
  assert.equal(events().length, 1);
  s = reconcile(s, deriveNetwork(now + 60_000, network(now + 60_000, [host(now + 60_000, data(91, [{ service: 'api', ok: false }]))])), now + 60_000);
  assert.equal(events().at(-1).transition, 'changed');
  assert.equal(events().length, 2);
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

test('queue disappearance from a bounded snapshot and old failed jobs are not recovery', () => {
  const ci = { ...ciHost(now), queue: { at, error: null, jobs: [{ repo: 'dashpay/status', id: 3, createdAt: stamp(now - 3600_000) }] },
    recent: [{ host: 'shared', repo: 'dashpay/status', runId: 9, attempt: 1, name: 'build', runnerName: 'runner', start: stamp(now - 60_000), end: at, result: 'Failed' }] };
  const initial = reconcile(null, deriveCi(now, ci), now);
  const omitted = { ...ciHost(now + 25 * 3600_000), queue: { at: stamp(now + 25 * 3600_000), error: null, jobs: [] }, recent: ci.recent };
  const s = reconcile(initial, deriveCi(now + 25 * 3600_000, omitted), now + 25 * 3600_000);
  assert.equal(byCode(s, 'queue_wait')[0].status, 'open');
  assert.equal(byCode(s, 'job_failed')[0].status, 'open');
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
  assert.equal(s.outbox.at(-1).schemaVersion, 1);
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

test('new fault during maintenance gets a post-maintenance notification, not a historical replay', () => {
  const data = (service) => ({ services: [{ service, ok: false }] });
  let s = reconcile(null, deriveNetwork(now, network(now, [host(now, data('api'))])), now);
  const count = s.outbox.filter((e) => e.issue.code === 'host_health').length;
  s = reconcile(s, deriveNetwork(now + 30_000, network(now + 30_000, [host(now + 30_000, data('indexer'))]), { lifecycle: { status: 'services' } }), now + 30_000);
  const replay = network(now + 30_000, [host(now + 30_000, data('indexer'))]);
  s = reconcile(s, deriveNetwork(now + 60_000, replay), now + 60_000);
  assert.equal(s.outbox.filter((e) => e.issue.code === 'host_health').length, count);
  assert.equal(byCode(s, 'host_health')[0].suppressed, true);
  s = reconcile(s, deriveNetwork(now + 90_000, network(now + 90_000, [host(now + 90_000, data('indexer'))])), now + 90_000);
  assert.equal(s.outbox.filter((e) => e.issue.code === 'host_health').length, count + 1);
  assert.equal(s.outbox.at(-1).transition, 'changed');
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
