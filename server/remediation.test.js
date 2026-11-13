import test from 'node:test';
import assert from 'node:assert/strict';
import { remediationView } from './remediation.js';

const now = Date.now(), at = new Date(now).toISOString();
const issue = (id, extra = {}) => ({ id, domain: 'network', scope: 'testnet', target: 'PRIVATE-HOST', code: 'host_health', severity: 'critical', status: 'open', firstSeen: at, lastSeen: at, ...extra });
const state = (issues, cases) => ({ generatedAt: at, issues, outbox: [], delivery: { lastAckAt: at, receiver: {
  workerAt: now / 1000,
  remediation: { schemaVersion: 1, generatedAt: at, enabled: true, maxActive: 2, cases },
} } });
const options = { full: true, visibleNetworks: ['testnet'], now };

test('remediation separates completed response from verified repair and preserves root-cause blockers', () => {
  const data = state([issue('a'), issue('b', { status: 'resolved' }), issue('c', { status: 'resolved' }), issue('d', { status: 'resolved' })], [
    { issueId: 'a', workerState: 'completed', lastResponse: { outcome: 'resolved' } },
    { issueId: 'b', workerState: 'completed', lastResponse: { outcome: 'blocked', blocker: 'root cause remains' } },
    { issueId: 'c', workerState: 'completed', lastResponse: { outcome: 'resolved' } },
    { issueId: 'd', workerState: 'completed', lastResponse: { outcome: 'no_change' } },
  ]);
  const view = remediationView(data, options);
  assert.equal(view.dispatch, 'enabled'); assert.equal(view.stale, false);
  assert.deepEqual(Object.fromEntries(view.cases.map((c) => [c.id, c.stage])), { a: 'verifying', b: 'followup', c: 'fixed', d: 'recovered' });
  assert.equal(view.cases.find((c) => c.id === 'b').blocker, 'root cause remains');
  data.generatedAt = new Date(now - 200_000).toISOString();
  assert.equal(remediationView(data, options).cases.find((c) => c.id === 'b').stage, 'blocked', 'stale monitoring cannot establish recovery');
});

test('active predecessor owns issue despite newer queued revision; repeated updates count once', () => {
  const view = remediationView(state([issue('a')], [{ issueId: 'a', active: true, workerState: 'uncertain', pendingEvents: 3, lastResponse: { outcome: 'blocked' } }]), options);
  assert.equal(view.counts.working, 1); assert.equal(view.counts.queued, 0); assert.equal(view.queuedEvents, 3);
  assert.match(view.cases[0].reason, /retains ownership/);
});

test('public projection hides private targets, notes, sessions, locks and invisible networks including counts', () => {
  const data = state([issue('a'), issue('b', { scope: 'secret-network' })], [
    { issueId: 'a', workerState: 'completed', sessionKey: 'PRIVATE-SESSION', heldBy: ['PRIVATE-LOCK'], lifecycle: 'PRIVATE-STATE', lastResponse: {
      outcome: 'blocked', summary: 'PRIVATE-SUMMARY', blocker: 'PRIVATE-BLOCKER', nextAction: 'PRIVATE-NEXT', changes: ['PRIVATE-CHANGE'] } },
    { issueId: 'b', active: true, workerState: 'running' },
  ]);
  const view = remediationView(data, { ...options, full: false });
  assert.equal(view.counts.blocked, 1); assert.equal(view.counts.working, 0);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|secret-network/);
  assert.equal(remediationView(data, options).cases.find((c) => c.id === 'a').blocker, 'PRIVATE-BLOCKER');
});

test('missing or stale feed remains visible, never presented as a healthy empty queue', () => {
  const data = state([issue('a')], []); delete data.delivery.receiver.remediation;
  const view = remediationView(data, options);
  assert.equal(view.stale, true); assert.equal(view.dispatch, 'unknown'); assert.equal(view.cases.length, 1);
  const missing = remediationView(null, options); assert.equal(missing.stale, true);
  const old = state([issue('a')], []); old.generatedAt = '2020-01-01T00:00:00Z';
  assert.equal(remediationView(old, options).producerFresh, false);
  const stalled = state([issue('a')], []); stalled.delivery.receiver.workerAt = (now - 200_000) / 1000;
  assert.equal(remediationView(stalled, options).dispatch, 'unknown', 'fresh ACK does not conceal stale worker heartbeat');
});

test('waiting reasons and no-cleanup informational findings survive presentation', () => {
  const view = remediationView(state([issue('a'), issue('b', { severity: 'info' })], [{ issueId: 'a', workerState: 'queued', waitReason: 'resource_conflict', pendingEvents: 1 }]), options);
  assert.match(view.cases.find((c) => c.id === 'a').reason, /resource owner/);
  assert.equal(view.counts.review, 1);
});

test('verified monitoring correction is not an outage recovery or stale batch blocker', () => {
  const data = state([issue('a', { domain: 'aws', status: 'resolved', resolutionEvidence: { reason: 'verified_control_signal' } })],
    [{ issueId: 'a', workerState: 'completed', lastResponse: { outcome: 'blocked', blocker: 'Classifier requires correction' } }]);
  const view = remediationView(data, options);
  assert.equal(view.cases[0].stage, 'classified'); assert.equal(view.cases[0].blocker, null);
  assert.equal(view.counts.blocked, 0); assert.equal(view.counts.fixed, 0);
  data.generatedAt = new Date(now - 200_000).toISOString();
  assert.equal(remediationView(data, options).cases[0].stage, 'blocked');
});

test('recognised upgrades, settling operations and stalls are explained, with details for administrators only', () => {
  const data = state([issue('a', { suppressed: true, evidence: { instanceId: 'i-one' } }), issue('b', { suppressed: true, scope: 'other' }), issue('d', { suppressed: true, scope: 'third' })], []);
  data.activity = { hosts: { 'testnet/i-one': { held: true } }, networks: { other: { held: true } } };
  data.maintenance = { third: { active: true, operations: [{ id: 'op', action: 'upgrade', status: 'settling' }] } };
  data.delivery.receiver.counts = { queued: 2 };
  data.delivery.receiver.attention = [{ code: 'route_unavailable', detail: 'PRIVATE route detail' }];
  const view = remediationView(data, { ...options, visibleNetworks: ['testnet', 'other', 'third'] });
  const reason = (id) => view.cases.find((c) => c.id === id).reason;
  assert.match(reason('a'), /recognised on this host/); assert.match(reason('b'), /recognised on this network/);
  const endpoint = state([issue('e', { suppressed: true, code: 'endpoint_failed', target: 'API' })], []);
  endpoint.activity = { hosts: { 'testnet/i-one': { held: true, network: 'testnet' } }, networks: {} };
  assert.match(remediationView(endpoint, options).cases[0].reason, /on a host of this network/);
  assert.match(reason('d'), /just finished/);
  assert.equal(view.stalled, true); assert.equal(view.attention[0].code, 'route_unavailable');
  const publicView = remediationView(data, { ...options, full: false, visibleNetworks: ['testnet', 'other', 'third'] });
  assert.equal(publicView.stalled, true); assert.equal(publicView.attention, undefined);
  assert.doesNotMatch(JSON.stringify(publicView), /PRIVATE/);
});

test('the switch shows what was requested and what the worker acknowledged; cleared issues say so', () => {
  const data = state([issue('a')], [{ issueId: 'a', workerState: 'cleared' }]);
  data.delivery.receiver.remediation.enabled = false;
  data.control = { seq: 4, dispatch: 'on', clearSeq: 3, updatedAt: at, updatedBy: 'PRIVATE-ADMIN', clearedAt: at, clearedBy: 'PRIVATE-ADMIN' };
  data.delivery.receiver.control = { seq: 3, dispatch: 'off', clearSeq: 3, localEnabled: true, lastClear: { at: now / 1000, count: 250 } };
  const view = remediationView(data, options);
  assert.deepEqual([view.dispatch, view.control.requested, view.control.applied, view.control.pending, view.control.supported], ['paused', 'on', 'off', true, true]);
  assert.deepEqual([view.control.lastClear.count, view.control.localEnabled, view.control.changedBy], [250, true, 'PRIVATE-ADMIN']);
  assert.match(view.cases[0].reason, /Removed from the queue/);
  data.delivery.receiver.control.seq = 4; data.delivery.receiver.control.dispatch = 'on';
  assert.equal(remediationView(data, options).control.pending, false);
  const publicView = remediationView(data, { ...options, full: false });
  assert.equal(publicView.control.applied, 'on'); assert.doesNotMatch(JSON.stringify(publicView), /PRIVATE/);
  const older = state([issue('a')], []);
  assert.deepEqual([remediationView(older, options).control.supported, remediationView(older, options).control.requested, remediationView(older, options).control.applied], [false, 'off', null]);
});

test('maintenance is visible without claiming recovery or hiding already-running repair ownership',()=>{
  const data=state([issue('a'),issue('b')],[{issueId:'b',active:true,workerState:'running'}]);
  data.maintenance={testnet:{active:true,operations:[{id:'op',action:'platform-reset'}]},secret:{active:true,operations:[{id:'private'}]}};
  const view=remediationView(data,options);
  assert.equal(view.cases.find(c=>c.id==='a').stage,'maintenance');
  assert.equal(view.cases.find(c=>c.id==='b').stage,'working');
  assert.equal(view.counts.maintenance,1);
  const publicView=remediationView(data,{...options,full:false});
  assert.deepEqual(publicView.maintenance,[{network:'testnet',operations:undefined}]);
  assert.ok(!JSON.stringify(publicView).includes('private'));
});
