// How cases end: recovery that monitoring can see, and closures that are not
// recoveries (the target is gone, the case aged out, a release was superseded).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKLOG_EVENTS, GONE_AFTER_MS, JOB_FAILED_MAX_AGE_MS, QUEUE_WAIT_UNSEEN_MS, QUIET_SAMPLES,
  ciJobIgnored, compactBacklog, deriveIssues, loadIncidentState, reconcile, saveIncidentState, validIgnoredCiJobs, wildcard } from './incidents.js';
import { cycle } from './incident-service.js';
import { reconcileReleaseTasks, supersededBy } from './release-webhook.js';
import { remediationView, HISTORY_MAX, HISTORY_MS } from './remediation.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

const now = Date.parse('2026-11-22T12:00:00Z');
const stamp = (ms) => new Date(ms).toISOString();
const byCode = (s, code) => s.issues.filter((i) => i.code === code);
const only = (s, code) => { const found = byCode(s, code); assert.equal(found.length, 1, code); return found[0]; };
const reason = (issue) => issue.resolutionEvidence?.reason;
const MIN = 60_000, HOUR = 3600_000;

// ---- CI ------------------------------------------------------------------
const ciHost = (ms, overrides = {}) => ({ reporters: [{ id: 'shared' }], hosts: [{ id: 'shared', receivedAt: stamp(ms), measuredAt: stamp(ms),
  disks: [{ path: '/', total: 100, free: 50 }], memTotal: 100, memUsed: 30, ...overrides }],
  runners: [{ host: 'shared', name: 'runner', receivedAt: stamp(ms), status: 'idle' }], recent: [] });
const deriveCi = (ms, ci, remediation) => deriveIssues({ settings: { ...DEFAULT_SETTINGS, networks: [], ...(remediation ? { remediation } : {}) }, states: {}, ci, now: ms });
const waiting = (ms, overrides = {}) => ({ repo: 'dashpay/platform', id: 7, name: 'Swift SDK build', workflow: 'Tests', branch: 'feat/x',
  url: 'https://github.com/dashpay/platform/actions/runs/5/job/7', createdAt: stamp(ms - 20 * MIN), runCreatedAt: stamp(ms - 30 * MIN), ...overrides });
const queueOf = (ms, jobs, overrides = {}) => ({ at: stamp(ms), error: null, repos: ['dashpay/platform'], covered: ['dashpay/platform'], queued: jobs.map((j) => j.id), windowMs: 24 * HOUR, total: jobs.length, jobs, ...overrides });

test('a waiting job that leaves a whole listing of its repository is recovered, and says how', () => {
  let s = reconcile(null, deriveCi(now, { ...ciHost(now), queue: queueOf(now, [waiting(now)]) }), now);
  const opened = only(s, 'queue_wait');
  assert.deepEqual([opened.status, opened.evidence.name, opened.evidence.branch, opened.evidence.url], ['open', 'Swift SDK build', 'feat/x', 'https://github.com/dashpay/platform/actions/runs/5/job/7']);
  // Still listed: still open, however often it is seen.
  s = reconcile(s, deriveCi(now + 2 * MIN, { ...ciHost(now + 2 * MIN), queue: queueOf(now + 2 * MIN, [waiting(now)]) }), now + 2 * MIN);
  assert.equal(only(s, 'queue_wait').status, 'open');
  // Still queued, but no longer shown as ours (the runner that served its labels
  // stopped reporting): GitHub lists it as queued, so it has not left.
  const hidden = reconcile(s, deriveCi(now + 4 * MIN, { ...ciHost(now + 4 * MIN), queue: queueOf(now + 4 * MIN, [], { queued: [7] }) }), now + 4 * MIN);
  assert.equal(only(hidden, 'queue_wait').status, 'open');
  // One listing without it is not enough: a run that changes status between the
  // listing's two requests is in neither. The same listing read again is still one.
  s = reconcile(s, deriveCi(now + 4 * MIN, { ...ciHost(now + 4 * MIN), queue: queueOf(now + 4 * MIN, []) }), now + 4 * MIN);
  assert.deepEqual([only(s, 'queue_wait').status, only(s, 'queue_wait').absentAt], ['open', stamp(now + 4 * MIN)]);
  s = reconcile(s, deriveCi(now + 5 * MIN, { ...ciHost(now + 5 * MIN), queue: queueOf(now + 4 * MIN, []) }), now + 5 * MIN);
  assert.equal(only(s, 'queue_wait').status, 'open');
  // Back in the next listing: it never left, and the count starts over.
  const back = reconcile(s, deriveCi(now + 6 * MIN, { ...ciHost(now + 6 * MIN), queue: queueOf(now + 6 * MIN, [waiting(now)]) }), now + 6 * MIN);
  assert.deepEqual([only(back, 'queue_wait').status, only(back, 'queue_wait').absentAt, back.outbox.length], ['open', undefined, s.outbox.length]);
  s = reconcile(s, deriveCi(now + 6 * MIN, { ...ciHost(now + 6 * MIN), queue: queueOf(now + 6 * MIN, []) }), now + 6 * MIN);
  const left = only(s, 'queue_wait');
  assert.deepEqual([left.status, reason(left), left.resolutionEvidence.how, left.observedAt, left.absentAt], ['resolved', 'left_queue', 'no longer queued', stamp(now + 6 * MIN), undefined]);
  assert.equal(s.outbox.at(-1).transition, 'resolved');
});

test('a run the poller no longer follows cannot prove its job left; the case ends by age instead, once the queue is being observed', () => {
  // The run is 23 h 55 min old when the job is first seen waiting.
  const old = waiting(now, { runCreatedAt: stamp(now - 24 * HOUR + 5 * MIN) });
  const initial = reconcile(null, deriveCi(now, { ...ciHost(now), queue: queueOf(now, [old]) }), now);
  const gone = (ms, overrides) => reconcile(initial, deriveCi(ms, { ...ciHost(ms), queue: queueOf(ms, [], overrides) }), ms);
  assert.equal(only(gone(now + 10 * MIN), 'queue_wait').status, 'open', 'the run has left the window the poller lists');
  // A case filed before the run's start was recorded cannot use the listing at
  // all, however recently its job was created: a job is younger than its run.
  const legacy = (ci) => {
    const state = structuredClone(initial), evidence = state.issues.find((i) => i.code === 'queue_wait').evidence;
    delete evidence.runCreatedAt; evidence.createdAt = stamp(now - 20 * MIN);
    return only(reconcile(state, deriveCi(now + 10 * MIN, { ...ciHost(now + 10 * MIN), queue: queueOf(now + 10 * MIN, []), ...ci }), now + 10 * MIN), 'queue_wait');
  };
  assert.equal(legacy({}).status, 'open');
  // What does end it: GitHub recorded the job starting on one of our runners.
  // That is a fact about the job, and needs neither window nor a current listing.
  assert.equal(legacy({ startedJobs: [8, 9] }).status, 'open');
  const started = legacy({ startedJobs: [7] });
  assert.deepEqual([started.status, reason(started), started.resolutionEvidence.how], ['resolved', 'left_queue', 'started on a runner']);
  assert.equal(reason(legacy({ startedJobs: [7], queue: queueOf(now + 10 * MIN, [], { error: 'GitHub 502' }) })), 'left_queue');
  assert.equal(only(gone(now + QUEUE_WAIT_UNSEEN_MS - MIN), 'queue_wait').status, 'open');
  const expired = only(gone(now + QUEUE_WAIT_UNSEEN_MS), 'queue_wait');
  assert.deepEqual([expired.status, reason(expired)], ['resolved', 'expired']);
  // A queue that cannot be read says nothing about how long a job went unseen.
  assert.equal(only(gone(now + 3 * QUEUE_WAIT_UNSEEN_MS, { error: 'GitHub 502' }), 'queue_wait').status, 'open');
});

const failed = (ms, overrides = {}) => ({ host: 'shared', repo: 'dashpay/platform', runId: 9, attempt: 1, name: 'Tests', workflow: 'CI', event: 'pull_request', headRef: 'feat/x', ref: 'refs/pull/77/merge',
  runnerName: 'runner', start: stamp(ms - 10 * MIN), end: stamp(ms), result: 'Failed', ...overrides });

test('a failed job is recovered by a later attempt or a later run on its branch, never by an earlier, other or failed one', () => {
  const failure = failed(now);
  const initial = reconcile(null, deriveCi(now, { ...ciHost(now), recent: [failure] }), now);
  assert.deepEqual([only(initial, 'job_failed').evidence.workflow, only(initial, 'job_failed').evidence.branch, only(initial, 'job_failed').evidence.event], ['CI', 'feat/x', 'pull_request']);
  const after = (others) => byCode(reconcile(initial, deriveCi(now + 30 * MIN, { ...ciHost(now + 30 * MIN), recent: [failure, ...others] }), now + 30 * MIN), 'job_failed').find((i) => i.evidence.runId === 9 && i.evidence.attempt === 1);
  const pass = (overrides) => failed(now + 20 * MIN, { result: 'Succeeded', runId: 10, ...overrides });
  for (const other of [pass({ headRef: 'feat/y' }), pass({ workflow: 'Nightly' }), pass({ name: 'Lint' }), pass({ repo: 'dashpay/grovedb' }),
    pass({ result: 'Failed' }), pass({ result: 'Canceled' }), pass({ end: stamp(now - MIN), start: stamp(now - 5 * MIN) }), pass({ headRef: undefined, ref: undefined }),
    // An older run that was slow to pass says nothing about the newer run that failed.
    pass({ runId: 8 }),
    // Another fork's pull request with a branch of the same name: its own refs/pull/<n>/merge keeps it apart.
    pass({ ref: 'refs/pull/78/merge' })])
    assert.equal(after([other]).status, 'open', JSON.stringify(other));
  const rerun = after([pass({ runId: 9, attempt: 2 })]);
  assert.deepEqual([rerun.status, reason(rerun), rerun.observedAt], ['resolved', 'later_attempt_passed', stamp(now + 20 * MIN)]);
  const next = after([pass()]);
  assert.deepEqual([next.status, reason(next), next.resolutionEvidence.runId, next.observedAt], ['resolved', 'later_run_passed', 10, stamp(now + 20 * MIN)]);
  // The newest run passed before the failure finished; the one before it passed after. That one counts.
  const outOfOrder = after([pass({ runId: 12, start: stamp(now - 20 * MIN), end: stamp(now - 5 * MIN) }), pass({ runId: 11 })]);
  assert.deepEqual([reason(outOfOrder), outOfOrder.resolutionEvidence.runId], ['later_run_passed', 11]);
  // A case filed before workflow and branch were kept in its evidence: the ledger still knows them.
  const stripped = structuredClone(initial);
  for (const key of ['workflow', 'branch', 'event', 'headRef', 'ref']) delete only(stripped, 'job_failed').evidence[key];
  assert.equal(reason(only(reconcile(stripped, deriveCi(now + 30 * MIN, { ...ciHost(now + 30 * MIN), recent: [failure, pass()] }), now + 30 * MIN), 'job_failed')), 'later_run_passed');
  assert.equal(only(reconcile(stripped, deriveCi(now + 30 * MIN, { ...ciHost(now + 30 * MIN), recent: [pass()] }), now + 30 * MIN), 'job_failed').status, 'open', 'without the ledger entry or the evidence, nothing ties the pass to it');
  // A pass already on record when the failure is first seen: no case at all.
  assert.equal(byCode(reconcile(null, deriveCi(now + 30 * MIN, { ...ciHost(now + 30 * MIN), recent: [failure, pass()] }), now + 30 * MIN), 'job_failed').length, 0);
  // A push to a branch without a pull request is matched by its ref.
  const pushed = failed(now, { headRef: null, ref: 'refs/heads/master', event: 'push' });
  const onMaster = reconcile(reconcile(null, deriveCi(now, { ...ciHost(now), recent: [pushed] }), now),
    deriveCi(now + 30 * MIN, { ...ciHost(now + 30 * MIN), recent: [pushed, failed(now + 20 * MIN, { ...pushed, result: 'Succeeded', runId: 11, start: stamp(now + 10 * MIN), end: stamp(now + 20 * MIN) })] }), now + 30 * MIN);
  assert.equal(reason(only(onMaster, 'job_failed')), 'later_run_passed');
});

test('a failed job with no later pass is closed after a day, as expired and not as recovered', () => {
  const failure = failed(now);
  let s = reconcile(null, deriveCi(now, { ...ciHost(now), recent: [failure] }), now);
  const late = now + JOB_FAILED_MAX_AGE_MS - MIN;
  s = reconcile(s, deriveCi(late, { ...ciHost(late), recent: [failure] }), late);
  assert.equal(only(s, 'job_failed').status, 'open');
  // Dropped from the ledger early: omission alone is not an ending.
  assert.equal(only(reconcile(s, deriveCi(late, { ...ciHost(late), recent: [] }), late), 'job_failed').status, 'open');
  const end = now + JOB_FAILED_MAX_AGE_MS + MIN;
  s = reconcile(s, deriveCi(end, { ...ciHost(end), recent: [failure] }), end);
  assert.deepEqual([only(s, 'job_failed').status, reason(only(s, 'job_failed'))], ['resolved', 'expired']);
  // The same failure reported again later does not come back.
  const again = reconcile(s, deriveCi(end + MIN, { ...ciHost(end + MIN), recent: [failure] }), end + MIN);
  assert.equal(only(again, 'job_failed').status, 'resolved');
  // The failure has aged out of the ledger but a later pass is still in it:
  // that is a recovery, whichever is noticed first.
  const open = reconcile(null, deriveCi(now, { ...ciHost(now), recent: [failure] }), now);
  const pass = failed(now + 23 * HOUR, { result: 'Succeeded', runId: 10 });
  const noticed = reconcile(open, deriveCi(end, { ...ciHost(end), recent: [pass] }), end);
  assert.deepEqual([only(noticed, 'job_failed').status, reason(only(noticed, 'job_failed')), only(noticed, 'job_failed').resolutionEvidence.runId], ['resolved', 'later_run_passed', 10]);
});

test('policy checks listed in settings are never filed; cases already filed for them end; nothing else is hidden', () => {
  const remediation = { ignoredCiJobs: [{ workflow: 'Check PR milestone' }, { repo: 'dashpay/platform', job: 'policy / *' }, { repo: 'dashpay/dash-evo-tool', workflow: 'Tests', job: 'Platform pin guard' }] };
  const jobs = [failed(now, { repo: 'dashpay/dash', workflow: 'Check PR milestone', name: 'Require a milestone', runId: 1 }),
    failed(now, { workflow: 'PR Hygiene policy', name: 'policy / reconcile', runId: 2 }),
    failed(now, { repo: 'dashpay/dash-evo-tool', workflow: 'Tests', name: 'Platform pin guard', runId: 3 }),
    failed(now, { repo: 'dashpay/dash-evo-tool', workflow: 'Tests', name: 'Unit tests', runId: 4 }),
    failed(now, { repo: 'dashpay/grovedb', workflow: 'PR Hygiene policy', name: 'policy / reconcile', runId: 5 })];
  const all = reconcile(null, deriveCi(now, { ...ciHost(now), recent: jobs }), now);
  assert.equal(byCode(all, 'job_failed').length, 5);
  assert.deepEqual(byCode(reconcile(null, deriveCi(now, { ...ciHost(now), recent: jobs }, remediation), now), 'job_failed').map((i) => i.evidence.runId).sort(), [4, 5]);
  const next = reconcile(all, deriveCi(now + MIN, { ...ciHost(now + MIN), recent: jobs }, remediation), now + MIN);
  assert.deepEqual(byCode(next, 'job_failed').map((i) => [i.evidence.runId, i.status, reason(i) || null]).sort(),
    [[1, 'resolved', 'ignored_job'], [2, 'resolved', 'ignored_job'], [3, 'resolved', 'ignored_job'], [4, 'open', null], [5, 'open', null]]);
  // Cases filed before the workflow was kept in their evidence end the same way while the ledger has the job.
  const legacy = structuredClone(all);
  for (const issue of byCode(legacy, 'job_failed')) for (const key of ['workflow', 'branch', 'event']) delete issue.evidence[key];
  assert.deepEqual(byCode(reconcile(legacy, deriveCi(now + MIN, { ...ciHost(now + MIN), recent: jobs }, remediation), now + MIN), 'job_failed').filter((i) => reason(i) === 'ignored_job').map((i) => i.evidence.runId).sort(), [1, 2, 3]);
  // Without the ledger, a record that lacks the workflow is not matched by a rule that names one.
  assert.deepEqual(byCode(reconcile(legacy, deriveCi(now + MIN, { ...ciHost(now + MIN), recent: [] }, remediation), now + MIN), 'job_failed').filter((i) => reason(i) === 'ignored_job').map((i) => i.evidence.runId).sort(), [2]);
  const ignored = ciJobIgnored({ remediation });
  assert.equal(ignored({ repo: 'dashpay/dash', job: 'Require a milestone' }), false);
  assert.equal(ignored({ repo: 'dashpay/platform', job: 'POLICY / reconcile' }), true, 'case is ignored, * is a wildcard');
  assert.equal(ignored({ repo: 'dashpay/platform', job: 'xpolicy / reconcile' }), false, 'a pattern is anchored at both ends');
  assert.equal(ciJobIgnored({ remediation: { ignoredCiJobs: [{ job: 'a.b' }] } })({ job: 'aXb' }), false, 'only * is special');
  for (const [pattern, value, expected] of [['', '', true], ['*', '', true], ['*', 'anything', true], ['a*', 'a', true], ['*a', 'ba', true], ['a*c', 'abc', true], ['a*c', 'ac', true],
    ['a*c', 'abd', false], ['a**c', 'abbc', true], ['*a*b*', 'xaxbx', true], ['*a*b*', 'xbxax', false], ['abc', 'ABC', true], ['abc', 'abcd', false], [' abc ', 'abc', true],
    ['a(b)[c]+?', 'a(b)[c]+?', true], ['a(b)[c]+?', 'abc', false], ['Check PR title*', 'Check PR title and description', true]])
    assert.equal(wildcard(pattern, value), expected, JSON.stringify([pattern, value]));
  // A rule cannot make a cycle slow, whatever it looks like.
  const began = Date.now();
  assert.equal(wildcard('*a*a*a*a*a*a*a*a*a*a*z', 'a'.repeat(20_000)), false);
  assert.ok(Date.now() - began < 1000, 'matching is bounded by pattern times text');
  for (const bad of [{}, { repo: 'dashpay/dash' }, { job: '' }, { job: 5 }, { job: 'x', commands: 'y' }, 'Require a milestone'])
    assert.throws(() => validIgnoredCiJobs([bad]), /ignoredCiJobs/, JSON.stringify(bad));
  assert.throws(() => validIgnoredCiJobs('all'), /ignoredCiJobs/);
  assert.deepEqual(validIgnoredCiJobs(undefined), []);
  // A list damaged on disk ignores nothing: every failure stays visible.
  assert.equal(byCode(reconcile(null, deriveCi(now, { ...ciHost(now), recent: jobs }, { ignoredCiJobs: [{ workflow: 'Check PR milestone' }, { repo: 'only' }] }), now), 'job_failed').length, 5);
});

test('a disk or runner missing from a current report for ten minutes is gone; a deregistered reporter takes its cases with it', () => {
  const bad = ciHost(now, { disks: [{ path: '/', total: 100, free: 5 }, { path: '/data', total: 100, free: 5 }] }); bad.runners[0].status = 'offline';
  let s = reconcile(null, deriveCi(now, bad), now);
  const initial = s;
  assert.equal(byCode(s, 'disk_pressure').length, 2);
  const without = (ms, overrides = {}) => { const ci = ciHost(ms, { disks: [{ path: '/', total: 100, free: 5 }], ...overrides }); ci.runners = []; return ci; };
  for (const ms of [now + MIN, now + 5 * MIN, now + MIN + GONE_AFTER_MS - 1]) {
    s = reconcile(s, deriveCi(ms, without(ms)), ms);
    assert.deepEqual([byCode(s, 'disk_pressure').map((i) => i.status), only(s, 'runner_offline').status], [['open', 'open'], 'open'], stamp(ms));
  }
  // A stale report is not an inventory: it neither ends the case nor restarts the clock.
  const stale = reconcile(s, deriveCi(now + HOUR, without(now + 30 * MIN)), now + HOUR);
  assert.equal(byCode(stale, 'disk_pressure').filter((i) => i.status === 'open').length, 2);
  assert.equal(byCode(stale, 'disk_pressure').find((i) => i.target === '/data').missingSince, stamp(now + MIN));
  // The clock is read off the reports, not the cycles: the last report read again an hour on is still the last report.
  const reread = reconcile(s, deriveCi(now + MIN + GONE_AFTER_MS, { ...without(now + MIN + GONE_AFTER_MS - 1), hosts: [{ ...without(now + MIN + GONE_AFTER_MS - 1).hosts[0], receivedAt: stamp(now + MIN + GONE_AFTER_MS) }] }), now + MIN + GONE_AFTER_MS);
  assert.equal(byCode(reread, 'disk_pressure').filter((i) => i.status === 'open').length, 2);
  const ended = reconcile(s, deriveCi(now + MIN + GONE_AFTER_MS, without(now + MIN + GONE_AFTER_MS)), now + MIN + GONE_AFTER_MS);
  const disks = Object.fromEntries(byCode(ended, 'disk_pressure').map((i) => [i.target, [i.status, reason(i) || null]]));
  assert.deepEqual(disks, { '/': ['open', null], '/data': ['resolved', 'target_removed'] });
  assert.deepEqual([only(ended, 'runner_offline').status, reason(only(ended, 'runner_offline'))], ['resolved', 'target_removed']);
  // The reporter keeps six disks of a host that has more: one it does not list may still be mounted.
  const cut = reconcile(s, deriveCi(now + MIN + GONE_AFTER_MS, without(now + MIN + GONE_AFTER_MS, { disksCut: true })), now + MIN + GONE_AFTER_MS);
  assert.deepEqual([byCode(cut, 'disk_pressure').filter((i) => i.status === 'open').length, only(cut, 'runner_offline').status], [2, 'resolved']);
  // Seen again before the ten minutes are up: the clock starts over.
  let back = reconcile(s, deriveCi(now + 8 * MIN, bad.hosts[0] && { ...ciHost(now + 8 * MIN, { disks: bad.hosts[0].disks }), runners: [{ ...bad.runners[0], receivedAt: stamp(now + 8 * MIN) }] }), now + 8 * MIN);
  back = reconcile(back, deriveCi(now + 12 * MIN, without(now + 12 * MIN)), now + 12 * MIN);
  assert.equal(byCode(back, 'disk_pressure').filter((i) => i.status === 'open').length, 2);
  // The reporter itself removed from the console.
  const removed = (ms) => deriveCi(ms, { reporters: [], hosts: [], runners: [], recent: [] });
  let gone = reconcile(initial, removed(now + MIN), now + MIN);
  assert.ok([...byCode(gone, 'disk_pressure'), ...byCode(gone, 'runner_offline')].every((i) => i.status === 'open'));
  gone = reconcile(gone, removed(now + MIN + GONE_AFTER_MS), now + MIN + GONE_AFTER_MS);
  assert.ok([...byCode(gone, 'disk_pressure'), ...byCode(gone, 'runner_offline')].every((i) => i.status === 'resolved' && reason(i) === 'target_removed'));
});

test('cases of a host excluded from remediation are left as they are: nothing ends them, nothing is parked for them', () => {
  const remediation = { excludedCiHosts: ['shared'] };
  const bad = ciHost(now, { disks: [{ path: '/', total: 100, free: 5 }, { path: '/data', total: 100, free: 5 }] });
  const failure = failed(now);
  let s = reconcile(null, deriveCi(now, { ...bad, recent: [failure] }), now);
  const parked = () => (s.quarantined || []).length;
  // Excluded from then on; the disk goes, the reporter is deregistered, the failure ages out.
  s = reconcile(s, deriveCi(now + MIN, { ...ciHost(now + MIN, { disks: [{ path: '/', total: 100, free: 5 }] }), recent: [failure] }, remediation), now + MIN);
  const before = parked();
  for (const ms of [now + 20 * MIN, now + 40 * MIN, now + 25 * HOUR, now + 26 * HOUR]) s = reconcile(s, deriveCi(ms, { reporters: [], hosts: [], runners: [], recent: [] }, remediation), ms);
  assert.deepEqual(s.issues.filter((i) => i.scope === 'shared').map((i) => [i.code, i.status, i.remediationExcluded]).sort(),
    [['disk_pressure', 'open', true], ['disk_pressure', 'open', true], ['job_failed', 'open', true]]);
  assert.equal(parked(), before, 'no ending is emitted only to be quarantined');
  // The exclusion is lifted: the cases end by the ordinary rules, and their endings are sent.
  s = reconcile(s, deriveCi(now + 27 * HOUR, { reporters: [], hosts: [], runners: [], recent: [] }), now + 27 * HOUR);
  s = reconcile(s, deriveCi(now + 28 * HOUR, { reporters: [], hosts: [], runners: [], recent: [] }), now + 28 * HOUR);
  assert.deepEqual(s.issues.filter((i) => i.scope === 'shared').map((i) => [i.code, reason(i)]).sort(), [['disk_pressure', 'target_removed'], ['disk_pressure', 'target_removed'], ['job_failed', 'expired']]);
  assert.equal(s.outbox.filter((e) => e.issue.scope === 'shared' && e.transition === 'resolved').length, 3);
});

// ---- networks ------------------------------------------------------------
const settingsFor = (names = ['testnet'], overrides = {}) => ({ ...structuredClone(DEFAULT_SETTINGS), networks: names.map((name) => ({
  name, chainType: 'testnet', coreNetwork: 'test', endpoints: [{ label: 'API', url: 'https://api.example.org/' }], ...overrides })) });
const host = (ms, data = {}, overrides = {}) => ({ name: 'explorer-1', instanceId: 'i-one', state: 'running', role: 'service', probe: { at: stamp(ms), ok: true, data }, ...overrides });
const network = (ms, hosts = [], endpoints = [], discovery = {}) => ({ generatedAt: stamp(ms), discovery: { at: stamp(ms), error: null, ...discovery }, hosts, endpoints });
const deriveNet = (ms, states, settings = settingsFor(Object.keys(states))) => deriveIssues({ settings, states, now: ms });
const down = [{ service: 'api', ok: false }];

test('a deleted network, a replaced host and a removed endpoint end their cases as closed after ten minutes, never as recovered', () => {
  const states = (ms, instanceId = 'i-one', endpoints = [{ label: 'API', kind: 'http', ok: false }]) => ({
    testnet: network(ms, [host(ms, { services: down }, { instanceId })], endpoints),
    'devnet-drill': network(ms, [host(ms, { services: down }, { instanceId: 'i-drill' })], [{ label: 'API', kind: 'http', ok: false }]) });
  const both = settingsFor(['testnet', 'devnet-drill']);
  let s = reconcile(null, deriveNet(now, states(now), both), now);
  assert.deepEqual([byCode(s, 'host_health').length, byCode(s, 'endpoint_failed').length], [2, 2]);
  // devnet-drill is deleted; on testnet the instance is replaced by a healthy one and the endpoint is removed.
  const after = (ms) => deriveNet(ms, { testnet: network(ms, [host(ms, { services: [{ service: 'api', ok: true }] }, { instanceId: 'i-two' })], []) }, settingsFor(['testnet']));
  const cases = () => s.issues.filter((i) => i.domain === 'network');
  s = reconcile(s, after(now + MIN), now + MIN);
  assert.ok(cases().every((i) => i.status === 'open'), 'a predecessor is not cleared by its successor being healthy');
  s = reconcile(s, after(now + MIN + GONE_AFTER_MS - 1), now + MIN + GONE_AFTER_MS - 1);
  assert.ok(cases().every((i) => i.status === 'open'));
  s = reconcile(s, after(now + MIN + GONE_AFTER_MS), now + MIN + GONE_AFTER_MS);
  assert.deepEqual(cases().map((i) => [i.scope, i.code, i.status, reason(i)]).sort(), [
    ['devnet-drill', 'endpoint_failed', 'resolved', 'network_removed'], ['devnet-drill', 'host_health', 'resolved', 'network_removed'],
    ['testnet', 'endpoint_failed', 'resolved', 'target_removed'], ['testnet', 'host_health', 'resolved', 'target_removed']]);
  assert.ok(cases().every((i) => !('missingSince' in i)));
});

test('a host missing from a failed or stale discovery is not gone, and a hold does not keep a removed host open', () => {
  let s = reconcile(null, deriveNet(now, { testnet: network(now, [host(now, { services: down })]) }), now);
  // Discovery errors for an hour: the host is absent, the inventory is not complete.
  for (const ms of [now + MIN, now + 30 * MIN, now + HOUR]) {
    s = reconcile(s, deriveNet(ms, { testnet: network(ms, [], [], { error: 'AccessDenied' }) }), ms);
    assert.equal(only(s, 'host_health').status, 'open', stamp(ms));
    assert.equal(only(s, 'host_health').missingSince, undefined);
  }
  // No observation at all (collector down).
  assert.equal(only(reconcile(s, deriveNet(now + 2 * HOUR, { testnet: null }), now + 2 * HOUR), 'host_health').status, 'open');
  // Removed while the network is under an operation (a reset replaces every instance).
  const held = (ms) => deriveIssues({ settings: settingsFor(['testnet']), states: { testnet: network(ms, [host(ms, {}, { instanceId: 'i-new' })]) }, maintenance: { testnet: { active: true } }, now: ms });
  s = reconcile(s, held(now + 3 * HOUR), now + 3 * HOUR);
  assert.equal(only(s, 'host_health').status, 'open');
  s = reconcile(s, held(now + 3 * HOUR + GONE_AFTER_MS), now + 3 * HOUR + GONE_AFTER_MS);
  assert.deepEqual([only(s, 'host_health').status, reason(only(s, 'host_health'))], ['resolved', 'target_removed']);
});

test('after a reset, the collector and discovery cases of the old generation end once the new one is being observed', () => {
  const broken = (ms) => ({ testnet: network(ms, [], [], { error: 'AccessDenied' }) });
  let s = reconcile(null, deriveNet(now, broken(now), settingsFor(['testnet'], { generation: 1 })), now);
  assert.equal(only(s, 'discovery_failed').status, 'open');
  const reset = (ms) => deriveNet(ms, { testnet: network(ms, [host(ms, {})]) }, settingsFor(['testnet'], { generation: 2 }));
  s = reconcile(s, reset(now + MIN), now + MIN);
  assert.equal(only(s, 'discovery_failed').status, 'open');
  s = reconcile(s, reset(now + MIN + GONE_AFTER_MS), now + MIN + GONE_AFTER_MS);
  assert.deepEqual([only(s, 'discovery_failed').status, reason(only(s, 'discovery_failed'))], ['resolved', 'target_removed']);
});

test('AWS cases end when the resource is gone from a complete inventory, not from a partial one', () => {
  const make = (ms, { volumes = [], addresses = [], instances = [], alarms = [], errors = [], healthErrors = [] } = {}) => ({ at: stamp(ms), errors, regions: ['us-west-2'], volumes, addresses,
    health: { at: stamp(ms), errors: healthErrors, instances, alarms } });
  const derive = (ms, aws) => deriveIssues({ settings: { ...DEFAULT_SETTINGS, networks: [] }, states: {}, aws, now: ms });
  const all = { volumes: [{ region: 'us-west-2', id: 'vol-1', state: 'available', sizeGiB: 20 }], addresses: [{ region: 'us-west-2', allocationId: 'eipalloc-1', associated: false }],
    instances: [{ region: 'us-west-2', id: 'i-one', state: 'running', instanceStatus: 'impaired', systemStatus: 'ok', events: [] }], alarms: [{ region: 'us-west-2', name: 'api', state: 'ALARM' }] };
  const codes = ['idle_volume', 'idle_address', 'aws_instance_impaired', 'aws_alarm'];
  let s = reconcile(null, derive(now, make(now, all)), now);
  for (const code of codes) assert.equal(only(s, code).status, 'open');
  s = reconcile(s, derive(now + MIN, make(now + MIN)), now + MIN);
  const partial = [{ errors: [{ region: 'us-west-2', scope: 'ec2:DescribeVolumes', error: 'throttled' }] }, { healthErrors: [{ region: 'us-west-2', scope: 'cloudwatch:DescribeAlarms', error: 'denied' }] }];
  const first = reconcile(s, derive(now + HOUR, make(now + HOUR, partial[0])), now + HOUR);
  assert.deepEqual(['idle_volume', 'idle_address'].map((c) => only(first, c).status), ['open', 'open'], 'an inventory with errors does not say a volume is gone');
  assert.deepEqual(['aws_instance_impaired', 'aws_alarm'].map((c) => only(first, c).status), ['resolved', 'resolved']);
  const second = reconcile(s, derive(now + HOUR, make(now + HOUR, partial[1])), now + HOUR);
  assert.deepEqual(['aws_instance_impaired', 'aws_alarm'].map((c) => only(second, c).status), ['open', 'open']);
  assert.deepEqual(['idle_volume', 'idle_address'].map((c) => only(second, c).status), ['resolved', 'resolved']);
  const done = reconcile(s, derive(now + MIN + GONE_AFTER_MS, make(now + MIN + GONE_AFTER_MS)), now + MIN + GONE_AFTER_MS);
  for (const code of codes) assert.deepEqual([only(done, code).status, reason(only(done, code))], ['resolved', 'target_removed'], code);
});

test('a host fault that nothing can prove healthy is dropped after ten healthy samples in a row, and the host then recovers', () => {
  const POLL = 30_000;
  const bad = (ms) => ({ testnet: network(ms, [host(ms, { containers: [{ name: 'incident-4619-replay', state: 'exited', exitCode: 1, running: false }], services: down })]) });
  const fine = (ms, probeAt = ms) => ({ testnet: network(ms, [host(probeAt, { containers: [], services: [{ service: 'api', ok: true }] })]) });
  let s = reconcile(null, deriveNet(now, bad(now)), now);
  assert.deepEqual(only(s, 'host_health').evidence.faults, ['["container","incident-4619-replay"]', '["service","api"]']);
  // The task container is removed and the service recovers: the service fault
  // is proven healthy at once, the container can never be.
  let ms = now;
  for (let n = 1; n < QUIET_SAMPLES; n++) {
    ms += POLL; s = reconcile(s, deriveNet(ms, fine(ms)), ms);
    assert.equal(only(s, 'host_health').status, 'open', `sample ${n}`);
    assert.equal(only(s, 'host_health').quiet['["container","incident-4619-replay"]'].n, n);
  }
  // The same probe seen again, and a stale one, are not further samples.
  s = reconcile(s, deriveNet(ms + 1000, fine(ms + 1000, ms)), ms + 1000);
  assert.equal(only(s, 'host_health').status, 'open');
  assert.equal(only(reconcile(s, deriveNet(ms + HOUR, fine(ms + HOUR, ms + POLL)), ms + HOUR), 'host_health').status, 'open', 'a stale observation is not a healthy sample');
  ms += POLL; s = reconcile(s, deriveNet(ms, fine(ms)), ms);
  const recovered = only(s, 'host_health');
  assert.deepEqual([recovered.status, reason(recovered), recovered.resolutionEvidence.faults], ['resolved', 'quiet', ['["container","incident-4619-replay"]']]);
  assert.equal(recovered.quiet, undefined);
});

test('a fault that returns restarts its count; one that stays away is dropped from the evidence of a host that is still faulty', () => {
  const POLL = 30_000;
  const state = (ms, container, service) => ({ testnet: network(ms, [host(ms, { containers: container ? [{ name: 'task', state: 'exited', exitCode: 1, running: false }] : [], services: [{ service: 'api', ok: !service }] })]) });
  let s = reconcile(null, deriveNet(now, state(now, true, true)), now), ms = now;
  const step = (container, service) => { ms += POLL; s = reconcile(s, deriveNet(ms, state(ms, container, service)), ms); return only(s, 'host_health'); };
  for (let n = 0; n < 4; n++) step(false, true);
  assert.equal(only(s, 'host_health').quiet['["container","task"]'].n, 4);
  assert.equal(step(true, true).quiet, undefined, 'seen again: no fault is waiting to be dropped');
  for (let n = 1; n < QUIET_SAMPLES; n++) assert.equal(step(false, true).evidence.faults.length, 2, `sample ${n}`);
  const before = s.outbox.length;
  const trimmed = step(false, true);
  assert.deepEqual([trimmed.status, trimmed.evidence.faults, trimmed.evidence.reasons.length], ['open', ['["service","api"]'], 1]);
  assert.equal(s.outbox.at(-1).transition, 'changed'); assert.equal(s.outbox.length, before + 1);
});

// ---- release tasks -------------------------------------------------------
const release = (tag, releaseId, repository = 'dashpay/platform', repositoryId = 424232911) => ({ schemaVersion: 1, repository, repositoryId, releaseId, tag,
  prerelease: tag.includes('-'), publishedAt: stamp(now - releaseId * HOUR), receivedAt: stamp(now), deliveryId: 'f26d6500-c333-11f1-8d56-cc2ba732156b', url: `https://github.com/${repository}/releases/tag/${tag}` });

test('a release with a newer one in its line is superseded: its task closes, and it is never opened afresh', () => {
  const tags = ['v5.0.0-beta.3', 'v5.0.0-beta.10', 'v5.0.0-rc.1', 'v5.0.0', 'v5.0.9', 'v5.0.10', 'v5.1.0-dev.1'];
  const releases = tags.map((tag, i) => release(tag, 100 + i));
  const by = (tag) => supersededBy(releases.find((r) => r.tag === tag), releases)?.tag || null;
  assert.deepEqual(tags.map(by), ['v5.0.10', 'v5.0.10', 'v5.0.10', 'v5.0.10', 'v5.0.10', null, null]);
  assert.equal(supersededBy(release('v5.0.0-beta.3', 1), [release('v5.0.0-beta.3', 1), release('v5.0.0-beta.10', 2), release('v5.0.0-alpha.99', 3)]).tag, 'v5.0.0-beta.10', 'numeric identifiers compare as numbers');
  assert.equal(supersededBy(release('v5.0.0-rc.1', 1), [release('v5.0.0-rc.1.1', 2)]).tag, 'v5.0.0-rc.1.1');
  assert.equal(supersededBy(release('v5.0.0', 1), [release('v5.0.0-rc.9', 2), release('v6.0.0', 3), release('v5.0.1', 4, 'dashpay/dash', 19352450)]), null, 'a prerelease, another line and another repository do not supersede');
  // 5.0.3 stays in service while 5.0.4-rc.1 is tried: a prerelease supersedes prereleases only.
  const trial = [release('v5.0.3', 1), release('v5.0.4-rc.1', 2), release('v5.0.4-beta.2', 3)];
  assert.deepEqual(trial.map((r) => supersededBy(r, trial)?.tag || null), [null, null, 'v5.0.4-rc.1']);
  assert.equal(supersededBy(trial[1], [...trial, release('v5.0.4', 4)]).tag, 'v5.0.4');
  // Tasks filed one by one as the releases came out, none of them ever worked on.
  const state = { schemaVersion: 1, issues: [], outbox: [], revisionCounters: {}, delivery: { receiver: {} } };
  reconcileReleaseTasks(state, releases.slice(0, 1), now);
  assert.deepEqual(state.issues.map((i) => [i.target, i.status]), [['Platform v5.0.0-beta.3', 'open']]);
  reconcileReleaseTasks(state, releases, now + MIN);
  assert.deepEqual(state.issues.map((i) => [i.target, i.status, i.resolutionEvidence?.by || null]),
    [['Platform v5.0.0-beta.3', 'resolved', 'v5.0.10'], ['Platform v5.0.10', 'open', null], ['Platform v5.1.0-dev.1', 'open', null]]);
  assert.deepEqual(state.outbox.map((e) => [e.issue.target, e.transition]),
    [['Platform v5.0.0-beta.3', 'opened'], ['Platform v5.0.0-beta.3', 'resolved'], ['Platform v5.0.10', 'opened'], ['Platform v5.1.0-dev.1', 'opened']]);
  const again = structuredClone(state); reconcileReleaseTasks(again, releases, now + 2 * MIN);
  assert.deepEqual(again, state, 'nothing is opened, closed or sent twice');
  const view = remediationView({ ...state, generatedAt: stamp(now + MIN), control: { dispatch: 'off' } }, { full: true, now: now + MIN });
  const shown = view.cases.find((c) => c.title.endsWith('v5.0.0-beta.3'));
  assert.deepEqual([shown.stage, shown.reason], ['closed', 'Superseded by v5.0.10']);
});

// ---- backlog -------------------------------------------------------------
const event = (id, revision, status = 'open', transition = status === 'resolved' ? 'resolved' : revision === 1 ? 'opened' : 'changed') =>
  ({ schemaVersion: 1, eventId: `${id}:${revision}`, occurredAt: stamp(now), transition, issue: { id, revision, domain: 'ci', scope: 'github', target: id, code: 'queue_wait', severity: 'warning', status, sourceKey: 'ci:queue' } });
const issueOf = (id, revision, status = 'open', extra = {}) => ({ id, revision, domain: 'ci', scope: 'github', target: id, code: 'queue_wait', severity: 'warning', status, ...extra });

test('a backlog keeps only the newest waiting event of each issue, an ending included', () => {
  const filler = Array.from({ length: BACKLOG_EVENTS }, (_, n) => `f${n}`);
  const issues = [issueOf('seen', 9, 'resolved'), issueOf('unseen', 2, 'resolved'), issueOf('still', 3), ...filler.map((id) => issueOf(id, 1))];
  const state = { issues: structuredClone(issues), outbox: [event('seen', 7), event('unseen', 1), event('still', 1), event('seen', 8), event('gone', 4),
    ...filler.map((id) => event(id, 1)), event('still', 2), event('unseen', 2, 'resolved'), event('seen', 9, 'resolved'), event('still', 3), event('gone', 5, 'resolved')] };
  const small = { issues: state.issues, outbox: state.outbox.slice(0, BACKLOG_EVENTS) };
  assert.equal(compactBacklog(structuredClone(small)).outbox.length, BACKLOG_EVENTS, 'one batch is not a backlog: every event is delivered as it is');
  compactBacklog(state);
  // unseen opened and ended with nothing acknowledged, and its ending is kept all the
  // same: its opening may have been accepted by a receiver whose answer was lost.
  assert.deepEqual(state.outbox.filter((e) => !e.issue.id.startsWith('f')).map((e) => e.eventId), ['unseen:2', 'seen:9', 'still:3', 'gone:5']);
  assert.equal(state.outbox.length, BACKLOG_EVENTS + 4);
  assert.deepEqual(state.issues, issues, 'issues are not touched');
  // Stable: a second pass changes nothing, and no event was rewritten.
  const once = structuredClone(state); compactBacklog(state); assert.deepEqual(state, once);
  assert.deepEqual(state.outbox.at(-1), event('gone', 5, 'resolved'));
});

test('a receiver that accepted an opening and lost its answer is still told the ending, once it returns', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'incidents-backlog-'));
  mkdirSync(join(dataDir, 'incidents'));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(DEFAULT_SETTINGS));
  const jobs = (ms) => Array.from({ length: 60 }, (_, n) => waiting(ms, { id: 100 + n }));
  let queue = queueOf(now, jobs(now)), clock = now;
  const ci = { summary: (options) => { assert.equal(options.whole, true); return { ...ciHost(clock), queue }; } };
  const destination = 'https://receiver.example-tailnet.ts.net:8444/v1/events';
  const sent = [];
  const accept = async (_, opts) => { const batch = JSON.parse(opts.body).events; sent.push(...batch); return Response.json({ accepted: batch.map((e) => e.eventId), health: { status: 'ok' } }); };
  // The receiver stores the first batch; the connection drops before it answers.
  const stored = [];
  await cycle({ dataDir, ci, destination, secret: 'test-secret', now: clock, fetcher: async (_, opts) => { stored.push(...JSON.parse(opts.body).events); throw new Error('connection lost after acceptance'); } });
  const openThere = new Set(stored.filter((e) => e.issue.code === 'queue_wait').map((e) => e.issue.id));
  assert.ok(openThere.size > 0 && openThere.size < 60, 'one batch of the sixty openings is with the receiver, unacknowledged');
  // The receiver goes away; every job then leaves the queue (two listings say so).
  for (const minutes of [5, 2]) {
    clock += minutes * MIN; queue = queueOf(clock, []);
    await cycle({ dataDir, ci, destination, secret: 'test-secret', now: clock, fetcher: async () => { throw new Error('connection refused'); } });
  }
  const state = loadIncidentState(dataDir);
  assert.ok(byCode(state, 'queue_wait').every((i) => i.status === 'resolved'));
  const pending = state.outbox.filter((e) => e.issue.code === 'queue_wait');
  assert.deepEqual([pending.length, pending.every((e) => e.transition === 'resolved')], [60, true], 'one waiting event per job: its ending');
  // It returns: every ending arrives, each once, the ones it holds open among them.
  for (let n = 0; n < 6 && loadIncidentState(dataDir).outbox.length; n++) { clock += 20 * MIN; queue = queueOf(clock, []); await cycle({ dataDir, ci, destination, secret: 'test-secret', now: clock, fetcher: accept }); }
  const endings = sent.filter((e) => e.issue.code === 'queue_wait');
  assert.deepEqual([endings.length, new Set(endings.map((e) => e.eventId)).size, endings.every((e) => e.transition === 'resolved')], [60, 60, true]);
  assert.ok([...openThere].every((id) => endings.some((e) => e.issue.id === id)));
  assert.equal(loadIncidentState(dataDir).outbox.filter((e) => e.issue.code === 'queue_wait').length, 0);
});

// ---- the page ------------------------------------------------------------
test('with repair switched off and no worker, the page lists open faults with what is wrong, and shows endings for a day', () => {
  const at = stamp(now);
  const base = { domain: 'ci', scope: 'mac-runner-pasta', severity: 'warning', status: 'open', firstSeen: stamp(now - HOUR), lastSeen: at, revision: 1 };
  const closed = (id, why, extra = {}) => ({ ...base, id, code: 'job_failed', target: id, status: 'resolved', resolvedAt: stamp(now - HOUR), resolutionEvidence: { reason: why }, ...extra });
  const issues = [
    { ...base, id: 'job1', code: 'job_failed', target: 'dashpay/platform/9/mac-runner-pasta/x', evidence: { repo: 'dashpay/platform', runId: 9, attempt: 2, jobName: 'Swift SDK build', workflow: 'Tests', branch: 'feat/x', runner: 'mac-runner-pasta' } },
    { ...base, id: 'job2', code: 'job_failed', target: 'dashpay/platform/10/mac-runner-pasta/y', evidence: { repo: 'dashpay/platform', runId: 10, attempt: 1, jobName: 'Swift SDK build', runner: 'mac-runner-pasta' } },
    { ...base, id: 'evil', code: 'job_failed', target: 'x', evidence: { repo: 'dashpay/platform/../../evil.example', runId: '9?x=<script>', jobName: 'Tests' } },
    { ...base, id: 'wait', scope: 'github', code: 'queue_wait', target: 'dashpay/platform/7', evidence: { repo: 'dashpay/platform', jobId: 7, name: 'Swift SDK build', createdAt: stamp(now - HOUR), url: 'javascript:alert(1)' } },
    { ...base, id: 'disk', code: 'disk_pressure', target: '/System/Volumes/Data', evidence: { usedPercent: 93.949, freeBytes: 120728788992 } },
    { ...base, id: 'host', domain: 'network', scope: 'testnet', code: 'host_health', target: 'web-1', severity: 'critical', evidence: { reasons: ['Core RPC not answering', 'container rc5-neg exited'] } },
    { ...base, id: 'held', domain: 'network', scope: 'testnet', code: 'host_health', target: 'mn-1', severity: 'critical', suppressed: true },
    { ...base, id: 'addr', domain: 'aws', scope: 'us-east-2', code: 'idle_address', target: 'eipalloc-1', severity: 'info' },
    closed('left', 'left_queue', { code: 'queue_wait' }), closed('pass', 'later_run_passed'), closed('gone', 'target_removed'), closed('aged', 'expired'),
    closed('policy', 'ignored_job'), closed('old', 'expired', { resolvedAt: stamp(now - HISTORY_MS - MIN) }),
    closed('plain', undefined, { resolutionEvidence: undefined }),
  ];
  // The worker last reported four days ago, with dispatch on, and one repair "active".
  const state = { generatedAt: at, issues, outbox: [{ eventId: 'job1:1', issue: { id: 'job1' } }, { eventId: 'aged:2', issue: { id: 'aged' } }], control: { seq: 6, dispatch: 'off', clearSeq: 4, updatedBy: 'admin' },
    delivery: { configured: true, error: 'receiver HTTP 502', lastAckAt: stamp(now - 96 * HOUR), receiver: { workerAt: (now - 96 * HOUR) / 1000, control: { seq: 5, dispatch: 'on', clearSeq: 4 },
      remediation: { schemaVersion: 1, generatedAt: stamp(now - 96 * HOUR), enabled: true, truncated: true, cases: [{ issueId: 'host', active: true, workerState: 'running' }, { issueId: 'disk', workerState: 'queued', pendingEvents: 3 }] } } } };
  const view = remediationView(state, { full: true, visibleNetworks: ['testnet'], now });
  assert.deepEqual([view.idle, view.stale, view.stalled, view.truncated, view.control.requested, view.control.applied, view.control.lastKnown], [true, false, false, false, 'off', null, 'on']);
  const stage = Object.fromEntries(view.cases.map((c) => [c.id, c.stage]));
  assert.deepEqual(stage, { job1: 'open', job2: 'open', evil: 'open', wait: 'open', disk: 'open', host: 'open', held: 'maintenance', addr: 'review',
    left: 'recovered', pass: 'recovered', plain: 'recovered', gone: 'closed', aged: 'closed', policy: 'closed' }, 'nothing is shown as queued or being worked on');
  assert.deepEqual(view.history, { hours: 24, older: 1, unlisted: 0 });
  assert.deepEqual(view.faults, { open: 8, critical: 2, warning: 5, info: 1, held: 1, recovered: 3, closed: 3, domains: { network: 2, ci: 5, aws: 1, maintenance: 0 } });
  assert.equal(view.cases[0].id, 'host', 'critical faults lead');
  const item = (id) => view.cases.find((c) => c.id === id);
  assert.deepEqual([item('job1').detail, item('job1').link, item('job1').group], ['dashpay/platform · Tests · Swift SDK build · feat/x · attempt 2 · mac-runner-pasta', 'https://github.com/dashpay/platform/actions/runs/9', 'dashpay/platform · Swift SDK build']);
  assert.equal(item('job2').group, item('job1').group);
  assert.equal(item('disk').detail, '93.9% used · 112 GiB free');
  assert.equal(item('host').detail, 'Core RPC not answering · container rc5-neg exited');
  assert.equal(item('addr').detail, 'not associated with an instance or interface');
  assert.deepEqual([item('evil').link, item('wait').link], [null, null], 'a link is built only from a well-formed GitHub run');
  assert.match(item('left').reason, /left the queue/); assert.match(item('pass').reason, /same branch passed/);
  assert.match(item('gone').reason, /no longer exists/); assert.match(item('aged').reason, /no recovery was observed/); assert.match(item('policy').reason, /policy check/);
  assert.match(item('plain').reason, /no autonomous fix is claimed/);
  // Signed out: the same counts, no targets, details, links or groups.
  const anonymous = remediationView(state, { full: false, visibleNetworks: ['testnet'], now });
  assert.deepEqual(anonymous.faults, view.faults);
  assert.doesNotMatch(JSON.stringify(anonymous), /mac-runner-pasta|web-1|rc5-neg|feat\/x|eipalloc|Swift SDK|github\.com|admin/);
  assert.ok(anonymous.cases.every((c) => !('detail' in c) && !('link' in c) && !('group' in c)));
  // Switched on again: an absent worker is a gap once more, and its last word is shown as it was.
  const on = remediationView({ ...state, control: { ...state.control, seq: 7, dispatch: 'on' } }, { full: true, visibleNetworks: ['testnet'], now });
  assert.deepEqual([on.idle, on.stale, on.stalled, on.cases.find((c) => c.id === 'host').stage, on.cases.find((c) => c.id === 'disk').stage, on.cases.find((c) => c.id === 'job1').stage], [false, true, true, 'working', 'queued', 'queued']);
  assert.equal(on.cases.find((c) => c.id === 'aged').stage, 'closed', 'how a case ended does not wait for its event to be delivered');
});

test('the ended list is limited but fully counted, and clearing activity never hides a fault monitoring still sees', () => {
  const at = stamp(now);
  const ended = Array.from({ length: HISTORY_MAX + 50 }, (_, n) => ({ id: `e${n}`, domain: 'ci', scope: 'github', target: `e${n}`, code: 'queue_wait', severity: 'warning', status: 'resolved',
    revision: 2, firstSeen: stamp(now - 2 * HOUR), lastSeen: stamp(now - HOUR + n * 1000), resolvedAt: stamp(now - n * 1000), resolutionEvidence: { reason: 'expired' } }));
  const open = (id, lastSeen) => ({ id, domain: 'ci', scope: 'host', target: id, code: 'disk_pressure', severity: 'warning', status: 'open', revision: 5, firstSeen: stamp(now - 48 * HOUR), lastSeen });
  const state = { generatedAt: at, outbox: [], control: { dispatch: 'off' }, issues: [...ended, open('current', at), open('forgotten', stamp(now - 30 * HOUR))],
    activityHistory: { schemaVersion: 1, clearedAt: stamp(now - 24 * HOUR), clearedBy: 'admin', revisions: { current: 5, forgotten: 5 } } };
  const view = remediationView(state, { full: true, now });
  assert.deepEqual([view.faults.closed, view.counts.closed, view.history.unlisted, view.cases.filter((c) => c.stage === 'closed').length], [HISTORY_MAX + 50, HISTORY_MAX + 50, 50, HISTORY_MAX]);
  assert.ok(view.cases.some((c) => c.id === 'e0') && !view.cases.some((c) => c.id === `e${HISTORY_MAX}`), 'the newest endings are the ones listed');
  assert.deepEqual(view.cases.filter((c) => c.stage === 'closed').slice(0, 3).map((c) => c.id), ['e0', 'e1', 'e2'], 'in the order they ended, not the order they were last seen');
  assert.deepEqual(view.cases.filter((c) => c.monitoring === 'open').map((c) => c.id), ['current'], 'seen since the clear: listed; not seen since: still hidden');
  assert.equal(view.activityHistory.hidden, 1);
});

test('one cycle over a state full of cases that could never close leaves the faults that are real', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'incidents-stale-'));
  for (const dir of ['incidents', 'state']) mkdirSync(join(dataDir, dir));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, networks: DEFAULT_SETTINGS.networks.filter((n) => n.name === 'testnet') }));
  const old = stamp(now - 30 * 24 * HOUR), recent = stamp(now - 5 * MIN);
  const stuck = (id, code, extra) => ({ id, domain: 'ci', scope: 'github', target: id, code, severity: 'warning', status: 'open', sourceKey: 'legacy', revision: 1,
    observedAt: old, firstSeen: old, lastSeen: old, lastFaultAt: old, lastEventAt: old, ...extra });
  const issues = [
    ...Array.from({ length: 40 }, (_, n) => stuck(`q${n}`, 'queue_wait', { evidence: { repo: 'dashpay/platform', jobId: n, createdAt: old } })),
    ...Array.from({ length: 40 }, (_, n) => stuck(`j${n}`, 'job_failed', { scope: 'mac-runner-pasta', evidence: { repo: 'dashpay/platform', runId: n, attempt: 1, jobName: 'Tests', end: old } })),
    ...Array.from({ length: 10 }, (_, n) => stuck(`d${n}`, 'host_health', { domain: 'network', scope: 'devnet-sakura', evidence: { instanceId: `i-${n}`, faults: ['["probe",""]'] } })),
    stuck('real', 'job_failed', { scope: 'mac-runner-pasta', observedAt: recent, firstSeen: recent, lastSeen: recent, lastFaultAt: recent, evidence: { repo: 'dashpay/platform', runId: 99, attempt: 1, jobName: 'Tests', end: recent } }),
  ];
  // Thirty of the old cases were opened while the receiver was away; the rest it knows.
  const outbox = issues.filter((i) => /^[qjd]\d$/.test(i.id)).map((i) => event(i.id, 1));
  saveIncidentState(dataDir, { schemaVersion: 1, issues, outbox, revisionCounters: Object.fromEntries(issues.map((i) => [i.id, 1])) });
  const ci = { summary: () => ({ ...ciHost(now), queue: queueOf(now, []) }) };
  await cycle({ dataDir, ci, now });
  const state = loadIncidentState(dataDir);
  const stale = state.issues.filter((i) => /^[qjd]\d+$/.test(i.id));
  // The deleted devnet's cases wait their ten minutes; the aged CI cases end at once.
  assert.deepEqual([stale.filter((i) => i.status === 'resolved').length, stale.filter((i) => i.status === 'open').map((i) => i.code).every((c) => c === 'host_health')], [80, true]);
  assert.equal(state.issues.find((i) => i.id === 'real').status, 'open');
  const pending = (s, id) => s.outbox.filter((e) => e.issue.id === id).map((e) => e.transition);
  for (const id of ['q0', 'q9', 'j0', 'j9', 'q10', 'q39', 'j10', 'j39']) assert.deepEqual(pending(state, id), ['resolved'], `${id}: one waiting event, its ending`);
  assert.deepEqual(pending(state, 'd0'), ['opened']);
  await cycle({ dataDir, ci, now: now + GONE_AFTER_MS });
  const done = loadIncidentState(dataDir);
  assert.deepEqual(done.issues.filter((i) => i.status === 'open' && i.sourceKey === 'legacy').map((i) => i.id), ['real']);
  assert.ok(done.issues.filter((i) => i.scope === 'devnet-sakura').every((i) => reason(i) === 'network_removed'));
  assert.deepEqual(pending(done, 'd0'), ['resolved'], 'the opening that was never sent is replaced by the ending');
  assert.equal(new Set(done.outbox.map((e) => e.issue.id)).size, done.outbox.length, 'one waiting event per issue');
  const view = remediationView({ ...done, control: { dispatch: 'off' } }, { full: true, now: now + GONE_AFTER_MS });
  assert.deepEqual(view.cases.filter((c) => ['job_failed', 'queue_wait', 'host_health'].includes(c.code) && c.monitoring === 'open').map((c) => c.id), ['real']);
});
