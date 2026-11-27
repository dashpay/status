import test from 'node:test';
import assert from 'node:assert/strict';
import { remediationView } from './remediation.js';

const now = Date.now(), at = new Date(now).toISOString();
const issue = (id, extra = {}) => ({ id, domain: 'network', scope: 'testnet', target: 'PRIVATE-HOST', code: 'host_health', severity: 'critical', status: 'open', firstSeen: at, lastSeen: at, ...extra });
const state = (issues) => ({ generatedAt: at, issues, outbox: [] });
const options = { full: true, visibleNetworks: ['testnet'], now };
const stages = (view) => Object.fromEntries(view.cases.map((c) => [c.id, c.stage]));

test('a case is open, held, for review, recovered or closed, by what monitoring recorded', () => {
  const data = state([issue('a'), issue('b', { suppressed: true }), issue('c', { severity: 'info' }),
    issue('d', { status: 'resolved', resolvedAt: at }), issue('e', { status: 'resolved', resolvedAt: at, resolutionEvidence: { reason: 'target_removed' } }),
    issue('f', { status: 'resolved', resolvedAt: at, resolutionEvidence: { reason: 'quiet' } })]);
  const view = remediationView(data, options);
  assert.deepEqual(stages(view), { a: 'open', b: 'maintenance', c: 'review', d: 'recovered', e: 'closed', f: 'recovered' });
  assert.deepEqual(view.counts, { open: 1, maintenance: 1, unknown: 0, review: 1, recovered: 2, closed: 1, classified: 0 });
  assert.deepEqual([view.stale, view.producerFresh, view.public], [false, true, false]);
  const reason = (id) => view.cases.find((c) => c.id === id).reason;
  assert.equal(reason('a'), null, 'the case says what is wrong');
  assert.match(reason('c'), /no automatic cleanup/); assert.match(reason('d'), /no autonomous fix is claimed/);
  assert.match(reason('e'), /no longer exists/); assert.match(reason('f'), /consecutive healthy samples/);
});

test('public projection hides private targets and invisible networks including counts', () => {
  const data = state([issue('a', { evidence: { reasons: ['PRIVATE-REASON'] } }), issue('b', { scope: 'secret-network' })]);
  const view = remediationView(data, { ...options, full: false });
  assert.deepEqual([view.public, view.counts.open, view.faults.open, view.cases.map((c) => c.id)], [true, 1, 1, ['a']]);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|secret-network/);
  const full = remediationView(data, options).cases.find((c) => c.id === 'a');
  assert.deepEqual([full.target, full.detail], ['PRIVATE-HOST', 'PRIVATE-REASON']);
});

test('missing or stale monitoring remains visible, and cannot establish that a case is over', () => {
  const missing = remediationView(null, options);
  assert.deepEqual([missing.stale, missing.producerFresh, missing.cases, missing.control], [true, false, [], { requested: 'off', changedAt: null, changedBy: null }]);
  const old = state([issue('a'), issue('b', { status: 'resolved', resolvedAt: at })]); old.generatedAt = new Date(now - 200_000).toISOString();
  const view = remediationView(old, options);
  assert.deepEqual([view.stale, view.producerFresh, stages(view)], [true, false, { a: 'open', b: 'unknown' }]);
  assert.ok(view.cases.every((c) => c.stale));
  assert.match(view.cases.find((c) => c.id === 'b').reason, /not current/);
});

test('verified monitoring correction is not an outage recovery', () => {
  const data = state([issue('a', { domain: 'aws', status: 'resolved', resolvedAt: at, resolutionEvidence: { reason: 'verified_control_signal' } })]);
  const view = remediationView(data, options);
  assert.deepEqual([view.cases[0].stage, view.counts.recovered, view.faults.recovered, view.faults.closed], ['classified', 0, 0, 1]);
  assert.match(view.cases[0].reason, /not a service recovery/);
  data.generatedAt = new Date(now - 200_000).toISOString();
  assert.equal(remediationView(data, options).cases[0].stage, 'unknown');
});

test('recognised upgrades and settling operations are explained', () => {
  const data = state([issue('a', { suppressed: true, evidence: { instanceId: 'i-one' } }), issue('b', { suppressed: true, scope: 'other' }), issue('d', { suppressed: true, scope: 'third' })]);
  data.activity = { hosts: { 'testnet/i-one': { held: true } }, networks: { other: { held: true } } };
  data.maintenance = { third: { active: true, operations: [{ id: 'op', action: 'upgrade', status: 'settling' }] } };
  const view = remediationView(data, { ...options, visibleNetworks: ['testnet', 'other', 'third'] });
  const reason = (id) => view.cases.find((c) => c.id === id).reason;
  assert.match(reason('a'), /recognised on this host/); assert.match(reason('b'), /recognised on this network/);
  const endpoint = state([issue('e', { suppressed: true, code: 'endpoint_failed', target: 'API' })]);
  endpoint.activity = { hosts: { 'testnet/i-one': { held: true, network: 'testnet' } }, networks: {} };
  assert.match(remediationView(endpoint, options).cases[0].reason, /on a host of this network/);
  assert.match(reason('d'), /just finished/);
});

test('the switch is shown as it is in its own file; who changed it stays with administrators', () => {
  const data = state([issue('a')]);
  assert.deepEqual(remediationView(data, options).control, { requested: 'off', changedAt: null, changedBy: null });
  data.control = { schemaVersion: 1, seq: 4, dispatch: 'on', clearSeq: 3, updatedAt: at, updatedBy: 'PRIVATE-ADMIN' };
  assert.deepEqual(remediationView(data, options).control, { requested: 'on', changedAt: at, changedBy: 'PRIVATE-ADMIN' });
  const publicView = remediationView(data, { ...options, full: false });
  assert.deepEqual(publicView.control, { requested: 'on' }); assert.doesNotMatch(JSON.stringify(publicView), /PRIVATE/);
});

test('what the retired receiver last said, left in a state by an earlier release, changes nothing', () => {
  const issues = [issue('a'), issue('b'), issue('c', { status: 'resolved', resolvedAt: at })];
  const plain = { ...state(issues), control: { seq: 9, dispatch: 'on', clearSeq: 0 } };
  const left = { ...plain, outbox: [{ eventId: 'b:1', issue: { id: 'b' } }],
    delivery: { configured: true, error: 'receiver HTTP 502', lastAckAt: at, receiver: { workerAt: now / 1000, counts: { queued: 7 }, control: { seq: 12, dispatch: 'off', clearSeq: 4, localEnabled: true },
      attention: [{ code: 'route_unavailable', detail: 'PRIVATE route detail' }],
      remediation: { schemaVersion: 1, generatedAt: at, enabled: true, maxActive: 2, truncated: true, progress: { attentionRequired: true, stalledRuns: 1 }, cases: [
        { issueId: 'a', active: true, workerState: 'uncertain', attentionRequired: true, pendingEvents: 2, lastResponse: { outcome: 'blocked', summary: 'PRIVATE-NOTE', blocker: 'PRIVATE-BLOCKER' } },
        { issueId: 'c', workerState: 'completed', lastResponse: { outcome: 'resolved' } }] } } },
    stall: { since: at, notifiedAt: at, reasons: [{ code: 'receiver_unreachable', detail: 'x' }] } };
  for (const full of [true, false]) assert.deepEqual(remediationView(left, { ...options, full }), remediationView(plain, { ...options, full }));
  const view = remediationView(left, options);
  assert.deepEqual([stages(view), view.control.requested], [{ a: 'open', b: 'open', c: 'recovered' }, 'on']);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE-NOTE|PRIVATE-BLOCKER|route/);
});

test('maintenance is visible without claiming recovery',()=>{
  const data=state([issue('a'),issue('b',{scope:'other'})]);
  data.maintenance={testnet:{active:true,operations:[{id:'op',action:'platform-reset'}]},secret:{active:true,operations:[{id:'private'}]}};
  const view=remediationView(data,{...options,visibleNetworks:['testnet','other']});
  assert.equal(view.cases.find(c=>c.id==='a').stage,'maintenance');
  assert.equal(view.cases.find(c=>c.id==='b').stage,'open');
  assert.equal(view.counts.maintenance,1);
  const publicView=remediationView(data,{...options,full:false});
  assert.deepEqual(publicView.maintenance,[{network:'testnet',operations:undefined}]);
  assert.ok(!JSON.stringify(publicView).includes('private'));
});

test('excluded CI hosts stay out of public and administrator remediation views', () => {
  const data = state([issue('excluded', { domain: 'ci', scope: 'strix-pasta', remediationExcluded: true }), issue('retained')]);
  for (const full of [true, false]) assert.deepEqual(remediationView(data, { ...options, full }).cases.map((c) => c.id), ['retained']);
  assert.equal(data.issues.length, 2);
});
