import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advance, createTriage, groupOf, lapse, matches, pileOf, sort, unattended, validPattern, LAPSE_MS, MAX_OPEN, QUIET_MS } from './triage.js';
import { createHooks } from './hooks.js';
import { createWeb } from './web.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

const digest = (token) => createHash('sha256').update(token).digest('hex');
const T0 = Date.parse('2026-11-27T10:00:00Z');
const at = (ms) => new Date(ms).toISOString();
let n = 0;
const issue = (domain, scope, target, code, severity = 'warning', extra = {}) => ({ id: `issue-${++n}`, domain, scope, target, code, severity, status: 'open', firstSeen: at(T0), lastSeen: at(T0), evidence: {}, ...extra });
const insight = () => issue('network', 'devnet-humid', 'insight', 'endpoint_failed');
const wallet = () => issue('network', 'devnet-humid', 'wallet-001', 'host_health', 'critical');
const waiting = (id) => issue('ci', 'github', `dashpay/grovedb/${id}`, 'queue_wait', 'warning', { evidence: { repo: 'dashpay/grovedb', name: 'test' } });
const failed = (run, name = 'build') => issue('ci', 'runner-a', `dashpay/platform/${run}/r1/1`, 'job_failed', 'warning', { evidence: { repo: 'dashpay/platform', jobName: name } });
const entry = (match, covers = [], more = {}) => ({ id: 'aaaaaaaaaaaa', title: 't', reason: 'known because', match, covers, standing: false, until: null, by: 'latte', at: at(T0), idleSince: null, ...more });

test('a pattern matches whole fields with * and is refused when it names nothing', () => {
  const p = validPattern({ domain: 'ci', scope: '*', target: 'dashpay/platform/*', code: 'job_failed', name: 'build*', severity: 'warning' });
  assert.equal(matches(p, failed(1, 'build (arm64)')), true);
  assert.equal(matches(p, failed(1, 'lint')), false);
  assert.equal(matches(p, waiting(1)), false);
  assert.equal(matches(validPattern({ domain: 'network', scope: 'devnet-humid', target: '*', code: '*', severity: 'critical' }), wallet()), true);
  // One code written out, anywhere: allowed. A name of `*` is no name.
  assert.equal(matches(validPattern({ domain: 'aws', scope: '*', target: '*', code: 'idle_volume', severity: 'info' }), issue('aws', 'us-west-2', 'vol-1', 'idle_volume', 'info')), true);
  assert.equal('name' in validPattern({ domain: 'ci', scope: 'runner-a', target: '*', code: '*', name: ' * ', severity: 'warning' }), false);
  for (const bad of [null, { domain: 'ci', scope: '*', target: '*', code: '*', severity: 'warning' }, { domain: 'any', scope: 'a', target: 'b', code: 'c', severity: 'warning' },
    // Everything of a domain, said another way.
    { domain: 'ci', scope: '*', target: '*', code: '*', name: '*', severity: 'critical' }, { domain: 'ci', scope: '*', target: '*', code: '*_*', severity: 'critical' },
    { domain: 'ci', scope: '**', target: ' * ', code: '*', name: 'build', severity: 'critical' }, { domain: 'ci', scope: 'x'.repeat(257), target: 'b', code: 'c', severity: 'warning' },
    { domain: 'ci', scope: 'a', target: 'b', code: 'c' }, { domain: 'ci', scope: 'a', target: 'b', code: 'c', severity: 'warning', regex: 'x' }, { domain: 'ci', scope: '', target: 'b', code: 'c', severity: 'warning' }])
    assert.throws(() => validPattern(bad), `refused: ${JSON.stringify(bad)}`);
});

test('issues are grouped by what a person would call one incident', () => {
  assert.deepEqual(groupOf(insight()).key, ['network', 'devnet-humid']);
  assert.deepEqual(groupOf(wallet()).key, ['network', 'devnet-humid']);
  assert.deepEqual(groupOf(waiting(1)).key, groupOf(waiting(2)).key);
  assert.deepEqual(groupOf(failed(1)).key, ['ci', 'job', 'dashpay/platform', 'build']);
  assert.notDeepEqual(groupOf(failed(1)).key, groupOf(failed(1, 'lint')).key);
  assert.deepEqual(groupOf(issue('ci', 'runner-a', '/', 'disk_pressure')).key, ['ci', 'host', 'runner-a']);
  assert.deepEqual(groupOf(issue('aws', 'us-west-2', 'vol-1', 'idle_volume', 'info')).key, ['aws', 'idle']);
  // A job that waits or fails is a new issue each time: its kind is the only handle.
  assert.equal(groupOf(waiting(1)).exact.target, 'dashpay/grovedb/*');
  assert.equal(groupOf(failed(7)).exact.name, 'build');
  assert.equal(groupOf(insight()).exact.target, 'insight');
  assert.equal(groupOf(insight()).wide.target, '*');
});

test('one issue, one pile: known, expected, held, review or new', () => {
  const dead = insight(), entries = [entry([groupOf(dead).exact], [{ domain: 'network', scope: 'devnet-humid', target: 'faucet', code: '*', severity: 'warning' }])];
  assert.deepEqual(pileOf(dead, entries), { pile: 'known', entry: 'aaaaaaaaaaaa' });
  assert.deepEqual(pileOf(issue('network', 'devnet-humid', 'faucet', 'endpoint_failed'), entries), { pile: 'expected', entry: 'aaaaaaaaaaaa' });
  assert.deepEqual(pileOf(wallet(), entries), { pile: 'new' });
  assert.deepEqual(pileOf({ ...wallet(), suppressed: true }, entries), { pile: 'held' });
  assert.deepEqual(pileOf(issue('aws', 'us-west-2', 'vol-1', 'idle_volume', 'info'), entries), { pile: 'review' });
  // A release task is work to do, whatever its severity.
  assert.deepEqual(pileOf(issue('maintenance', 'releases', 'platform', 'platform_release_compatibility', 'info'), entries), { pile: 'new' });
  // The known fault, grown worse than when it was filed, is news again.
  assert.deepEqual(pileOf({ ...dead, severity: 'critical' }, entries), { pile: 'new', outgrown: 'aaaaaaaaaaaa' });
  // Resolved issues and hosts excluded from remediation are in no pile.
  assert.deepEqual(sort([{ ...dead, status: 'resolved' }, { ...wallet(), remediationExcluded: true }, wallet()], entries).map((s) => s.pile), ['new']);
});

test('an incident opens once, gathers its faults, and is revised only when it gets worse', () => {
  const a = waiting(1), b = waiting(2);
  let t = advance(null, sort([a], []), T0);
  assert.equal(t.episodes.length, 1);
  const first = t.episodes[0];
  assert.equal(first.revision, 1);
  assert.deepEqual(unattended(t.episodes), [`${first.id}:1`]);
  t = advance(t, sort([a, b], []), T0 + 60_000);
  assert.equal(t.episodes.length, 1);
  assert.equal(t.episodes[0].id, first.id);
  assert.deepEqual(t.episodes[0].issues, [a.id, b.id]);
  assert.equal(t.episodes[0].revision, 1, 'more of the same is the same incident');
  t.episodes[0].ledger = { state: 'needs_you', revision: 1 };
  assert.deepEqual(unattended(t.episodes), []);
  t = advance(t, sort([a, { ...b, severity: 'critical' }], []), T0 + 120_000);
  assert.equal(t.episodes[0].revision, 2);
  assert.deepEqual(unattended(t.episodes), [`${first.id}:2`]);
  // Back to warning and up to critical again: it has been critical before.
  t = advance(t, sort([a], []), T0 + 180_000);
  t = advance(t, sort([{ ...a, severity: 'critical' }], []), T0 + 240_000);
  assert.equal(t.episodes[0].revision, 2);
});

test('something else failing in the same place revises the incident; the same thing again does not', () => {
  const a = insight(), faucet = issue('network', 'devnet-humid', 'faucet', 'endpoint_failed');
  let t = advance(null, sort([a], []), T0);
  const id = t.episodes[0].id;
  t.episodes[0].ledger = { state: 'needs_you', revision: 1 };
  t = advance(t, sort([a, faucet], []), T0 + 60_000);
  assert.deepEqual([t.episodes[0].revision, t.episodes[0].severity], [2, 'warning']);
  assert.deepEqual(unattended(t.episodes), [`${id}:2`]);
  t.episodes[0].ledger.revision = 2;
  // The faucet recovers and fails again: seen before, not news.
  t = advance(t, sort([a], []), T0 + 120_000);
  t = advance(t, sort([a, faucet], []), T0 + 180_000);
  assert.equal(t.episodes[0].revision, 2);
  // Open faults are kept at the end of the list, so a cut cannot drop them.
  assert.deepEqual(t.episodes[0].issues.slice(-2), [a.id, faucet.id]);
  assert.deepEqual(t.episodes[0].current, [a.id, faucet.id]);
});

test('a fault that recovers beside a filed one is a recovery, with its quiet hour', () => {
  const a = insight(), b = wallet(), entries = [entry([groupOf(a).exact])];
  let t = advance(null, sort([a, b], []), T0);
  t = advance(t, sort([a, b], entries), T0 + 1000);
  assert.deepEqual(t.episodes[0].current, [b.id]);
  t = advance(t, sort([a], entries), T0 + 2000);
  assert.equal(t.episodes.length, 1, 'not ended as filed: the wallet host was never filed');
  assert.equal(t.episodes[0].clearSince, at(T0 + 2000));
  t = advance(t, sort([a], entries), T0 + 2000 + QUIET_MS);
  assert.equal(t.ended.at(-1).outcome, 'recovered');
});

test('no more than a fixed number of incidents is open at once, and the rest is counted', () => {
  const many = Array.from({ length: MAX_OPEN + 3 }, (_, i) => issue('network', `devnet-${i}`, 'host', 'host_health'));
  let t = advance(null, sort(many, []), T0);
  assert.deepEqual([t.episodes.length, t.unopened], [MAX_OPEN, 3]);
  // The same on the next look: nothing is opened and forgotten in turn.
  const ids = t.episodes.map((e) => e.id).join();
  t = advance(t, sort(many, []), T0 + 60_000);
  assert.deepEqual([t.episodes.map((e) => e.id).join() === ids, t.unopened], [true, 3]);
});

test('a fault counts once it has lasted: one failed sample opens nothing, and one critical sample revises nothing', () => {
  const SETTLE = 180_000, probe = issue('network', 'mainnet', 'Quorums · fresh Core comparison', 'endpoint_failed');
  // One sample, gone on the next look: no incident, nothing to wake for.
  let t = advance(null, sort([probe], []), T0, SETTLE);
  assert.deepEqual([t.episodes.length, unattended(t.episodes), Object.keys(t.pending)], [0, [], [probe.id]]);
  t = advance(t, sort([], []), T0 + 60_000, SETTLE);
  assert.deepEqual([t.episodes.length, Object.keys(t.pending).length], [0, 0]);
  // It fails again later: the count starts over, and a break starts it over too.
  t = advance(t, sort([probe], []), T0 + 600_000, SETTLE);
  t = advance(t, sort([probe], []), T0 + 600_000 + SETTLE - 1, SETTLE);
  assert.equal(t.episodes.length, 0);
  t = advance(t, sort([], []), T0 + 600_000 + SETTLE, SETTLE);
  t = advance(t, sort([probe], []), T0 + 600_000 + SETTLE + 60_000, SETTLE);
  assert.equal(t.episodes.length, 0, 'a break in between: not three minutes in a row');
  // There for three minutes: an incident, opened then, and the worker is to look.
  t = advance(t, sort([probe], []), T0 + 600_000 + 2 * SETTLE + 60_000, SETTLE);
  assert.equal(t.episodes.length, 1);
  const id = t.episodes[0].id, opened = T0 + 600_000 + 2 * SETTLE + 60_000;
  assert.deepEqual([t.episodes[0].openedAt, t.episodes[0].severity, unattended(t.episodes)], [at(opened), 'warning', [`${id}:1`]]);
  t.episodes[0].ledger = { state: 'needs_you', revision: 1 };
  // Critical for one sample: the incident stays as it is. Critical for three minutes: revised.
  t = advance(t, sort([{ ...probe, severity: 'critical' }], []), opened + 60_000, SETTLE);
  t = advance(t, sort([probe], []), opened + 120_000, SETTLE);
  assert.deepEqual([t.episodes[0].severity, t.episodes[0].revision], ['warning', 1]);
  t = advance(t, sort([{ ...probe, severity: 'critical' }], []), opened + 180_000, SETTLE);
  t = advance(t, sort([{ ...probe, severity: 'critical' }], []), opened + 180_000 + SETTLE - 1, SETTLE);
  assert.equal(t.episodes[0].revision, 1);
  t = advance(t, sort([{ ...probe, severity: 'critical' }], []), opened + 180_000 + SETTLE, SETTLE);
  assert.deepEqual([t.episodes[0].severity, t.episodes[0].revision], ['critical', 2]);
  // Something else there for one sample joins nothing; the incident's own fault needs no second wait when it comes back.
  const other = issue('network', 'mainnet', 'DAPI', 'endpoint_failed');
  t.episodes[0].ledger.revision = 2;
  t = advance(t, sort([{ ...probe, severity: 'critical' }, other], []), opened + 600_000, SETTLE);
  assert.deepEqual([t.episodes[0].revision, t.episodes[0].current], [2, [probe.id]]);
  t = advance(t, sort([{ ...probe, severity: 'critical' }, other], []), opened + 600_000 + SETTLE, SETTLE);
  assert.deepEqual([t.episodes[0].revision, t.episodes[0].current], [3, [probe.id, other.id]]);
  // An incident from before there was a settle time: its faults have done their waiting.
  const old = advance(null, sort([probe], []), T0);
  delete old.pending;
  const kept = advance(old, sort([probe], []), T0 + 60_000, SETTLE);
  assert.deepEqual([kept.episodes[0].clearSince, kept.episodes[0].current, kept.episodes[0].revision], [null, [probe.id], 1]);
});

test('an incident ends an hour after its last fault cleared, or at once when it is filed', () => {
  const a = insight();
  let t = advance(null, sort([a], []), T0);
  const id = t.episodes[0].id;
  t = advance(t, sort([], []), T0 + 60_000);
  assert.equal(t.episodes[0].clearSince, at(T0 + 60_000));
  // It comes back within the hour: the same incident.
  t = advance(t, sort([a], []), T0 + 30 * 60_000);
  assert.equal(t.episodes[0].id, id);
  assert.equal(t.episodes[0].clearSince, null);
  t = advance(t, sort([], []), T0 + 40 * 60_000);
  t = advance(t, sort([], []), T0 + 40 * 60_000 + QUIET_MS - 1);
  assert.equal(t.episodes.length, 1);
  t = advance(t, sort([], []), T0 + 40 * 60_000 + QUIET_MS);
  assert.equal(t.episodes.length, 0);
  assert.deepEqual([t.ended[0].outcome, t.ended[0].endedAt], ['recovered', at(T0 + 40 * 60_000)]);
  // After that it is a new one.
  t = advance(t, sort([a], []), T0 + 3 * 3600_000);
  assert.notEqual(t.episodes[0].id, id);
  // Filed as known: over at once, and not called a recovery.
  t = advance(t, sort([a], [entry([groupOf(a).exact])]), T0 + 3 * 3600_000 + 1000);
  assert.equal(t.episodes.length, 0);
  assert.equal(t.ended.at(-1).outcome, 'filed');
});

test('an incident held for an operation waits as it is', () => {
  const a = wallet();
  let t = advance(null, sort([a], []), T0);
  t = advance(t, sort([{ ...a, suppressed: true }], []), T0 + 2 * QUIET_MS);
  assert.equal(t.episodes.length, 1);
  assert.equal(t.episodes[0].clearSince, null);
});

test('an incident filed while it is held ends as filed, once nothing of it is held any more', () => {
  const a = wallet(), b = insight(), heldA = { ...a, suppressed: true }, heldB = { ...b, suppressed: true };
  let t = advance(null, sort([a, b], []), T0);
  t = advance(t, sort([heldA, heldB], []), T0 + 60_000);
  assert.deepEqual(t.episodes[0].current, [a.id, b.id], 'what is held is what the incident has now');
  // One of the two is filed: the other is still held, and the incident waits.
  t = advance(t, sort([heldA, heldB], [entry([groupOf(a).exact])]), T0 + 120_000);
  assert.deepEqual([t.episodes.length, t.episodes[0].clearSince, t.episodes[0].current], [1, null, [b.id]]);
  // Both are: over at once, and not called a recovery an hour later.
  t = advance(t, sort([heldA, heldB], [entry([groupOf(a).exact, groupOf(b).exact])]), T0 + 180_000);
  assert.equal(t.episodes.length, 0);
  assert.deepEqual([t.ended.at(-1).outcome, t.ended.at(-1).endedAt], ['filed', at(T0 + 180_000)]);
  // Held, then gone with nothing filed: a recovery, with its quiet hour.
  let r = advance(null, sort([a], []), T0);
  r = advance(r, sort([heldA], []), T0 + 60_000);
  r = advance(r, sort([], []), T0 + 120_000);
  assert.deepEqual([r.episodes.length, r.episodes[0].clearSince], [1, at(T0 + 120_000)]);
  // Held, then back as it was: the same incident, not revised.
  let s = advance(null, sort([a], []), T0);
  s = advance(s, sort([heldA], []), T0 + 60_000);
  s = advance(s, sort([a], []), T0 + 120_000);
  assert.deepEqual([s.episodes.length, s.episodes[0].revision, s.episodes[0].current], [1, 1, [a.id]]);
  // Gone for one look before the hold, as when a container is killed and started
  // again: no quiet hour runs during the hold, and filing it then ends it as filed.
  let u = advance(null, sort([a], []), T0);
  u = advance(u, sort([], []), T0 + 60_000);
  assert.deepEqual([u.episodes[0].clearSince, u.episodes[0].current], [at(T0 + 60_000), []]);
  u = advance(u, sort([heldA], []), T0 + 120_000);
  assert.deepEqual([u.episodes[0].clearSince, u.episodes[0].current], [null, [a.id]]);
  u = advance(u, sort([heldA], [entry([groupOf(a).exact])]), T0 + 180_000);
  assert.deepEqual([u.episodes.length, u.ended.at(-1).outcome, u.ended.at(-1).endedAt], [0, 'filed', at(T0 + 180_000)]);
  // One fault filed with patterns written out and the other held, which then
  // goes away unfiled: that one is a recovery, with its quiet hour from then.
  let v = advance(null, sort([a, b], []), T0);
  v = advance(v, sort([a, heldB], [entry([groupOf(a).exact])]), T0 + 60_000);
  assert.deepEqual([v.episodes.length, v.episodes[0].current], [1, [b.id]]);
  v = advance(v, sort([a], [entry([groupOf(a).exact])]), T0 + 120_000);
  assert.deepEqual([v.episodes.length, v.episodes[0].clearSince], [1, at(T0 + 120_000)]);
  v = advance(v, sort([a], [entry([groupOf(a).exact])]), T0 + 120_000 + QUIET_MS);
  assert.equal(v.ended.at(-1).outcome, 'recovered');
  // An incident keeps the level each of its faults last counted at, whatever a
  // fault reads while the change runs. Filed at that level it stays held, named
  // by the entry, and ends the incident as filed when the hold ends at that
  // level again.
  const worseB = { ...b, severity: 'critical', suppressed: true }, filedB = [entry([groupOf(b).exact])];
  let q = advance(null, sort([b], []), T0);
  q = advance(q, sort([worseB], []), T0 + 60_000);
  assert.deepEqual([q.episodes[0].levels, q.episodes[0].severity], [{ [b.id]: 'warning' }, 'warning']);
  assert.deepEqual(sort([worseB], filedB).map((x) => [x.pile, x.outgrown]), [['held', 'aaaaaaaaaaaa']]);
  q = advance(q, sort([worseB], filedB), T0 + 120_000);
  assert.deepEqual([q.episodes.length, q.episodes[0].current, q.episodes[0].clearSince], [1, [b.id], null]);
  q = advance(q, sort([b], filedB), T0 + 180_000);
  assert.deepEqual([q.episodes.length, q.ended.at(-1).outcome, 'levels' in q.ended.at(-1)], [0, 'filed', false]);
  // One fault new and another held: both are what the incident has now, and
  // the held one keeps the level it counted at.
  let m = advance(null, sort([a, b], []), T0);
  m = advance(m, sort([{ ...heldA, severity: 'info' }, { ...b, severity: 'critical' }], []), T0 + 60_000);
  assert.deepEqual([m.episodes[0].current, m.episodes[0].levels], [[a.id, b.id], { [a.id]: 'critical', [b.id]: 'critical' }]);
  // The incident's new fault is filed while an old one of it, filed long ago,
  // reads above its ceiling during a restart. The old one is no part of what
  // the incident has now: the incident ends as filed, at once.
  const old = insight(), fresh = wallet(), filedOld = [entry([groupOf(old).exact])];
  let k = advance(null, sort([old], []), T0);
  k = advance(k, sort([old, fresh], filedOld), T0 + 60_000);
  assert.deepEqual(k.episodes[0].current, [fresh.id]);
  const oldWorse = { ...old, severity: 'critical', suppressed: true };
  k = advance(k, sort([oldWorse, fresh], filedOld), T0 + 120_000);
  assert.deepEqual(k.episodes[0].current, [fresh.id]);
  k = advance(k, sort([oldWorse, fresh], [entry([groupOf(old).exact, groupOf(fresh).exact])]), T0 + 180_000);
  assert.deepEqual([k.episodes.length, k.ended.at(-1).outcome, k.ended.at(-1).endedAt], [0, 'filed', at(T0 + 180_000)]);
  // A fault of the incident's past, filed since, reads above its ceiling while
  // its host restarts. That is not what the incident has now: the quiet hour of
  // the fault that did recover runs on, and the incident ends as a recovery.
  const x = insight(), y = wallet(), filedX = [entry([groupOf(x).exact])];
  let w = advance(null, sort([x, y], []), T0);
  w = advance(w, sort([x, y], filedX), T0 + 60_000);
  w = advance(w, sort([x], filedX), T0 + 120_000);
  assert.equal(w.episodes[0].clearSince, at(T0 + 120_000));
  w = advance(w, sort([{ ...x, severity: 'critical', suppressed: true }], filedX), T0 + 180_000);
  assert.deepEqual([w.episodes.length, w.episodes[0].current, w.episodes[0].clearSince], [1, [], at(T0 + 120_000)]);
  w = advance(w, sort([x], filedX), T0 + 240_000);
  assert.deepEqual([w.episodes.length, w.episodes[0].clearSince], [1, at(T0 + 120_000)], 'not ended as filed: nothing was filed');
  w = advance(w, sort([x], filedX), T0 + 120_000 + QUIET_MS);
  assert.deepEqual([w.ended.at(-1).outcome, w.ended.at(-1).endedAt], ['recovered', at(T0 + 120_000)]);
});

test('a known entry lapses after a day with nothing to match, unless it is standing or dated', () => {
  const a = insight(), e = entry([groupOf(a).exact]);
  let r = lapse([e], [a], T0);
  assert.equal(r.kept[0].idleSince, null);
  r = lapse(r.kept, [{ ...a, status: 'resolved' }], T0 + 1000);
  assert.equal(r.kept[0].idleSince, at(T0 + 1000));
  // It matches again: the count starts over.
  assert.equal(lapse(r.kept, [a], T0 + 2000).kept[0].idleSince, null);
  assert.equal(lapse(r.kept, [], T0 + LAPSE_MS).kept.length, 1);
  assert.deepEqual(lapse(r.kept, [], T0 + 1000 + LAPSE_MS).dropped, [{ id: e.id, why: 'idle' }]);
  assert.equal(lapse([{ ...r.kept[0], standing: true }], [], T0 + 10 * LAPSE_MS).kept.length, 1);
  assert.deepEqual(lapse([{ ...e, standing: true, until: at(T0 + 5000) }], [a], T0 + 5000).dropped, [{ id: e.id, why: 'date' }]);
  // An issue above the entry's ceiling still keeps the entry alive: it is the same fault.
  assert.equal(lapse([e], [{ ...a, severity: 'critical' }], T0).kept[0].idleSince, null);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'triage-'));
  const dataDir = join(root, 'data'), dir = join(root, 'hooks');
  mkdirSync(join(dataDir, 'incidents'), { recursive: true }); mkdirSync(dir);
  let now = T0;
  const state = (issues, generatedAt = now) => writeFileSync(join(dataDir, 'incidents', 'state.json'), JSON.stringify({ generatedAt: at(generatedAt), issues }));
  const fired = [], logged = [];
  const hooks = { fire: (name, event) => { fired.push([name, event]); return { seq: fired.length }; } };
  const make = (settleMs = 0) => createTriage({ dataDir, clock: () => now, hooks, hook: 'remediation', workersFile: join(dir, 'workers.json'), settleMs, log: (e) => logged.push(e) });
  return { root, dataDir, dir, fired, logged, state, make, tick: (ms) => { now += ms; return now; }, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the worker is woken once for a new incident, again only when it gets worse, and not for known things', () => {
  const f = fixture();
  try {
    const a = insight(), q = waiting(1);
    f.state([a]);
    let triage = f.make();
    triage.refresh(); triage.refresh();
    assert.deepEqual(f.fired, [['remediation', 'triage']]);
    // A restart of the console does not wake for it again.
    triage = f.make();
    triage.refresh();
    assert.equal(f.fired.length, 1);
    // Another incident wakes; more faults in the first do not.
    f.tick(60_000); f.state([a, wallet(), q]);
    triage.refresh();
    assert.equal(f.fired.length, 2);
    const view = triage.view({ full: true });
    assert.equal(view.incidents.length, 2);
    assert.equal(view.counts.new, 2);
    const net = view.incidents.find((i) => i.kind === 'Network');
    assert.equal(net.severity, 'critical');
    assert.equal(net.revision, 2, 'the network incident got worse when the wallet host failed');
    // The worker reports; the incident is attended and nothing wakes.
    triage.report(net.id, { state: 'needs_you', summary: 'cannot reach the host', slack: { channel: 'C0C5QSM5FFG', ts: '1764237600.000100' } }, 'infraclaw');
    f.tick(60_000); f.state([a, q]);
    triage.refresh();
    assert.equal(f.fired.length, 2);
    const later = triage.view({ full: true });
    assert.equal(later.counts.needsYou, 1);
    assert.equal(later.incidents.find((i) => i.id === net.id).ledger.slack.ts, '1764237600.000100');
    // A second report keeps the thread it was given the first time.
    const second = triage.report(net.id, { state: 'fixed', summary: 'restarted' }, 'infraclaw');
    assert.deepEqual([second.ledger.slack.channel, second.ledger.revision, second.revision], ['C0C5QSM5FFG', 2, 2]);
    // A report that arrives late, read at an older revision, takes nothing back.
    assert.equal(triage.report(net.id, { state: 'fixed', revision: 1 }, 'infraclaw').ledger.revision, 2);
    assert.equal(f.fired.length, 2);
    assert.throws(() => triage.report(net.id, { state: 'done' }, 'infraclaw'), /state is one of/);
    assert.throws(() => triage.report(net.id, { state: 'fixed', revision: 9 }, 'infraclaw'), /revision/);
    assert.throws(() => triage.report('0000000000000000', { state: 'fixed' }, 'infraclaw'), /No open incident/);
  } finally { f.done(); }
});

test('filing an incident as known takes it off the list, and what it causes can be put under it', () => {
  const f = fixture();
  try {
    const a = insight(), faucet = issue('network', 'devnet-humid', 'faucet', 'endpoint_failed');
    f.state([a]);
    const triage = f.make();
    const [inc] = triage.view({ full: true }).incidents;
    assert.throws(() => triage.file({ incident: inc.id, reason: '' }, 'latte'), /reason/);
    const filed = triage.file({ incident: inc.id, reason: 'Insight is dead on purpose: the devnet is being retired' }, 'latte');
    assert.deepEqual(filed.match, [{ domain: 'network', scope: 'devnet-humid', target: 'insight', code: 'endpoint_failed', severity: 'warning' }]);
    assert.deepEqual(filed.covers, []);
    let view = triage.view({ full: true });
    assert.equal(view.incidents.length, 0);
    assert.equal(view.ended[0].outcome, 'filed');
    assert.equal(view.known[0].issues.length, 1);
    assert.equal(f.fired.length, 1);
    // Something next to it fails: new, the worker is woken, and it says "this follows from that".
    f.tick(60_000); f.state([a, faucet]);
    triage.refresh();
    assert.equal(f.fired.length, 2);
    const [next] = triage.view({ full: true }).incidents;
    triage.attach(filed.id, { incident: next.id }, 'infraclaw');
    view = triage.view({ full: true });
    assert.equal(view.incidents.length, 0);
    assert.deepEqual([view.counts.known, view.counts.expected, view.counts.new], [1, 1, 0]);
    assert.equal(view.known[0].expected[0].target, 'faucet');
    // "And whatever else this causes": the whole network under one entry.
    f.tick(60_000); f.state([a, faucet, wallet()]);
    const [third] = triage.view({ full: true }).incidents;
    const wide = triage.file({ incident: third.id, reason: 'wallet host is being rebuilt', wide: true, standing: true }, 'latte');
    assert.deepEqual(wide.covers, [{ domain: 'network', scope: 'devnet-humid', target: '*', code: '*', severity: 'critical' }]);
    triage.remove(filed.id, 'latte');
    assert.throws(() => triage.remove(filed.id, 'latte'), /No known entry/);
    // With the first entry gone, the wide one still covers what it named.
    view = triage.view({ full: true });
    assert.deepEqual([view.counts.known, view.counts.expected, view.counts.new], [1, 2, 0]);
    assert.equal(JSON.parse(readFileSync(join(f.dataDir, 'remediation-known.json'), 'utf8')).entries.length, 1);
    // A name with * in it would be filed wider than it is: by hand, then.
    f.tick(60_000); f.state([a, faucet, wallet(), failed(9, 'test *')]);
    const starred = triage.view({ full: true }).incidents.find((i) => i.kind === 'CI job');
    assert.throws(() => triage.file({ incident: starred.id, reason: 'flaky' }, 'latte'), /has \* in its name/);
    // The worker adds to any entry, and rewords only its own.
    assert.throws(() => triage.attach(wide.id, { reason: 'reworded by the worker' }, 'infraclaw', { worker: true }), /only of entries it filed/);
    const added = triage.attach(wide.id, { covers: [{ domain: 'ci', scope: '*', target: 'dashpay/platform/*', code: 'job_failed', name: 'test ?', severity: 'warning' }] }, 'infraclaw', { worker: true });
    assert.deepEqual([added.by, added.changedBy, added.reason], ['latte', 'infraclaw', 'wallet host is being rebuilt']);
    const own = triage.file({ match: [{ domain: 'ci', scope: 'runner-a', target: '*', code: 'disk_pressure', severity: 'warning' }], reason: 'cache fills up nightly' }, 'infraclaw', { worker: true });
    assert.equal(triage.attach(own.id, { reason: 'cache fills up nightly; cleaned at 03:00' }, 'infraclaw', { worker: true }).reason, 'cache fills up nightly; cleaned at 03:00');
  } finally { f.done(); }
});

test('an incident whose faults are held for a change in progress lists them and can still be filed', () => {
  const f = fixture();
  try {
    // Somebody kills four containers to test and starts them again: the start
    // reads as a change in progress, and the faults that opened the incident
    // are held before the worker has filed what it found.
    const a = wallet(), b = insight();
    f.state([a, b]);
    const triage = f.make();
    const testing = triage.file({ match: [{ domain: 'network', scope: 'devnet-humid', target: 'faucet', code: 'endpoint_failed', severity: 'warning' }], reason: 'fault testing on devnet-humid', standing: true }, 'latte');
    let [inc] = triage.view({ full: true }).incidents;
    assert.deepEqual([inc.issues.length, inc.held.length], [2, 0]);
    triage.report(inc.id, { state: 'working', summary: 'looking' }, 'infraclaw');
    f.tick(60_000); f.state([{ ...a, suppressed: true }, { ...b, suppressed: true }]);
    let view = triage.view({ full: true });
    [inc] = view.incidents;
    assert.deepEqual([inc.issues.length, inc.held.map((i) => i.target), inc.canWiden, inc.clearSince, view.counts.held], [0, ['wallet-001', 'insight'], true, null, 2]);
    assert.equal(f.fired.length, 1, 'a hold wakes nobody');
    // The worker says what it found: "this follows from that".
    const under = triage.attach(testing.id, { incident: inc.id }, 'infraclaw', { worker: true });
    assert.deepEqual(under.covers.map((p) => [p.target, p.code, p.severity]), [['wallet-001', 'host_health', 'critical'], ['insight', 'endpoint_failed', 'warning']]);
    view = triage.view({ full: true });
    assert.deepEqual([view.incidents.length, view.ended[0].outcome, view.counts.expected, view.counts.held], [0, 'filed', 2, 0]);
    // The hold ends with the faults still there: expected, and nothing new.
    f.tick(60_000); f.state([a, b]);
    view = triage.view({ full: true });
    assert.deepEqual([view.incidents.length, view.counts.expected, f.fired.length], [0, 2, 1]);
    // Filed as known works the same way while held.
    const c = issue('network', 'devnet-x', 'host-1', 'host_health');
    f.tick(60_000); f.state([a, b, c]);
    const other = triage.view({ full: true }).incidents.find((i) => i.title === 'devnet-x');
    f.tick(60_000); f.state([a, b, { ...c, suppressed: true }]);
    assert.deepEqual(triage.file({ incident: other.id, reason: 'host-1 is being rebuilt by hand' }, 'latte').match.map((p) => p.target), ['host-1']);
    assert.equal(triage.view({ full: true }).ended[0].outcome, 'filed');
    // A held fault reads worse while its host restarts. Nobody looked at that
    // reading: it is filed at the level it counted at, and so is "whatever else
    // it causes" on that network, although the incident has had a critical
    // fault (another host, gone since).
    const host3 = issue('network', 'devnet-z', 'host-3', 'host_health'), api3 = issue('network', 'devnet-z', 'api', 'endpoint_failed'), host9 = issue('network', 'devnet-z', 'host-9', 'host_health', 'critical');
    f.tick(60_000); f.state([a, b, c, host3, api3, host9]);
    const mild = triage.view({ full: true }).incidents.find((i) => i.title === 'devnet-z');
    assert.equal(mild.severity, 'critical');
    f.tick(60_000); f.state([a, b, c, { ...host3, severity: 'critical', suppressed: true }, api3]);
    const capped = triage.file({ incident: mild.id, reason: 'devnet-z is being moved to new hosts', wide: true }, 'latte');
    assert.deepEqual(capped.match.map((p) => [p.target, p.severity]), [['host-3', 'warning'], ['api', 'warning']]);
    assert.deepEqual(capped.covers.map((p) => [p.target, p.severity]), [['*', 'warning']]);
    // It reads above what was filed: it stays held and says that it is filed
    // and under which entry, the incident waits, and it is not filed a second time.
    const during = triage.view({ full: true }).incidents.find((i) => i.id === mild.id);
    assert.deepEqual([during.issues.length, during.held.map((i) => [i.target, i.outgrown, i.filed]), during.canWiden, during.clearSince], [0, [['host-3', capped.id, true]], false, null]);
    assert.throws(() => triage.file({ incident: mild.id, reason: 'once more' }, 'latte'), (e) => e.status === 409 && /no open fault/.test(e.message));
    assert.equal(triage.view({ full: true }).known.filter((k) => k.title === 'devnet-z').length, 1);
    // The hold ends and it is still critical: above what was filed, so new again.
    f.tick(60_000); f.state([a, b, c, { ...host3, severity: 'critical' }, api3]);
    assert.deepEqual(triage.view({ full: true }).incidents.filter((i) => i.title === 'devnet-z').map((i) => i.issues.map((x) => [x.target, x.outgrown])), [[['host-3', capped.id]]]);
    // Worse than when it was filed, counted as such, and then held: that
    // reading was looked at, so it can be filed, at that level.
    const now3 = triage.view({ full: true }).incidents.find((i) => i.id === mild.id);
    assert.deepEqual(now3.issues.map((x) => [x.target, x.severity]), [['host-3', 'critical']]);
    f.tick(60_000); f.state([a, b, c, { ...host3, severity: 'critical', suppressed: true }, api3]);
    const heldWorse = triage.view({ full: true }).incidents.find((i) => i.id === mild.id);
    assert.deepEqual([heldWorse.held.map((i) => [i.target, i.outgrown, i.filed]), heldWorse.canWiden], [[['host-3', capped.id, undefined]], true]);
    const again = triage.file({ incident: mild.id, reason: 'host-3 stays down until the move is done' }, 'latte');
    assert.deepEqual(again.match.map((p) => [p.target, p.severity]), [['host-3', 'critical']]);
    assert.deepEqual([triage.view({ full: true }).ended[0].id, triage.view({ full: true }).ended[0].outcome], [mild.id, 'filed']);
    // Killed, gone for one look, and started again in an incident that has had
    // a critical fault: the level it counted at is still on record.
    const host4 = issue('network', 'devnet-w', 'host-4', 'host_health'), host5 = issue('network', 'devnet-w', 'host-5', 'host_health', 'critical');
    f.tick(60_000); f.state([a, b, c, host4, host5]);
    const flap = triage.view({ full: true }).incidents.find((i) => i.title === 'devnet-w');
    f.tick(60_000); f.state([a, b, c]);
    f.tick(60_000); f.state([a, b, c, { ...host4, severity: 'critical', suppressed: true }]);
    assert.deepEqual(triage.file({ incident: flap.id, reason: 'host-4 is restarted by the test rig', wide: true }, 'latte').covers.map((p) => [p.target, p.severity]), [['*', 'warning']]);
    f.tick(60_000); f.state([a, b, c]);
    // Nothing of an incident open or held any more: there is nothing to file, and the answer says so.
    const d = issue('network', 'devnet-y', 'host-2', 'host_health');
    f.tick(60_000); f.state([a, b, c, d]);
    const gone = triage.view({ full: true }).incidents.find((i) => i.title === 'devnet-y');
    f.tick(60_000); f.state([a, b, c, { ...d, status: 'resolved' }]);
    assert.deepEqual(triage.view({ full: true }).incidents.find((i) => i.id === gone.id).held, []);
    assert.throws(() => triage.file({ incident: gone.id, reason: 'it went away' }, 'latte'), (e) => e.status === 409 && /no open fault/.test(e.message));
    assert.throws(() => triage.attach(testing.id, { incident: gone.id }, 'infraclaw', { worker: true }), (e) => e.status === 409 && /no open fault/.test(e.message));
  } finally { f.done(); }
});

test('a fault that has not lasted is counted apart, wakes nobody, and is listed for nobody', () => {
  const f = fixture();
  try {
    const a = { ...insight(), scope: 'testnet' };
    f.state([a]);
    const triage = f.make(180_000);
    let view = triage.view({ full: true });
    assert.deepEqual([view.incidents.length, view.counts.new, view.counts.settling, view.counts.faults, view.settleSeconds], [0, 0, 1, 1, 180]);
    assert.deepEqual(triage.view({ full: false, visibleNetworks: ['testnet'] }).new, []);
    assert.equal(f.fired.length, 0);
    // Gone a minute later: it never was an incident.
    f.tick(60_000); f.state([]);
    view = triage.view({ full: true });
    assert.deepEqual([view.incidents.length, view.counts.settling, f.fired.length, view.ended.length], [0, 0, 0, 0]);
    // There for three minutes: now it is one.
    f.tick(60_000); f.state([a]);
    triage.refresh();
    f.tick(180_000); f.state([a]);
    view = triage.view({ full: true });
    assert.deepEqual([view.incidents.length, view.counts.new, view.counts.settling, f.fired.length], [1, 1, 0, 1]);
    // And the time survives a restart of the console.
    assert.equal(f.make(180_000).view({ full: true }).incidents.length, 1);
  } finally { f.done(); }
});

test('nothing moves on stale monitoring', () => {
  const f = fixture();
  try {
    const a = insight();
    f.state([a]);
    const triage = f.make();
    triage.refresh();
    // The monitor stops, with the fault no longer in its last word.
    f.state([], T0);
    f.tick(3 * QUIET_MS);
    const view = triage.view({ full: true });
    assert.equal(view.stale, true);
    assert.equal(view.incidents.length, 1, 'not called recovered because the monitor stopped');
    assert.equal(view.incidents[0].clearSince, null);
  } finally { f.done(); }
});

test('without an account: counts by network and area, and no host, repository, reason or report', () => {
  const f = fixture();
  try {
    const a = insight(), secretive = issue('network', 'devnet-private', 'host-9', 'host_health');
    f.state([a, secretive, waiting(1), waiting(2), failed(3)]);
    const triage = f.make();
    const [inc] = triage.view({ full: true }).incidents.filter((i) => i.kind === 'CI job');
    triage.file({ incident: inc.id, reason: 'flaky upstream, tracked in platform#1234' }, 'latte');
    const open = triage.view({ full: false, visibleNetworks: ['devnet-humid'] });
    assert.equal(open.public, true);
    assert.deepEqual(open.incidents, []);
    assert.deepEqual(open.known, []);
    assert.deepEqual(open.new.map((g) => [g.title, g.count]), [['devnet-humid', 1], ['CI', 2]]);
    assert.deepEqual(open.knownOpen.map((g) => [g.title, g.count]), [['CI', 1]]);
    assert.equal(/devnet-private|host-9|insight|grovedb|platform|flaky|latte|runner-a/.test(JSON.stringify(open)), false);
    assert.equal(open.worker, undefined);
    // A running operation is named for whoever may see its network, with its details for administrators only.
    const operations = () => ({ 'devnet-humid': { active: true, operations: [{ id: 'op-1', action: 'upgrade', status: 'running' }] }, 'devnet-private': { active: true, operations: [] }, testnet: { active: false } });
    f.tick(6000);
    assert.deepEqual(triage.view({ full: false, visibleNetworks: ['devnet-humid'], maintenance: operations }).maintenance, [{ network: 'devnet-humid' }]);
    assert.deepEqual(triage.view({ full: true, maintenance: operations }).maintenance.map((m) => [m.network, m.operations.length]), [['devnet-humid', 1], ['devnet-private', 0]]);
    f.tick(6000);
    const open2 = triage.view({ full: false, visibleNetworks: ['devnet-humid'] });
    assert.deepEqual(open2.maintenance, []);
    // The same answer for a few seconds, without another look; a change ends that at once.
    const looks = f.logged.length;
    assert.equal(triage.view({ full: false, visibleNetworks: ['devnet-humid'] }), open2);
    assert.notEqual(triage.view({ full: false, visibleNetworks: [] }), open2);
    assert.deepEqual(triage.view({ full: false, visibleNetworks: [] }).new.map((g) => g.title), ['CI']);
    assert.equal(f.logged.length, looks);
    f.tick(1000); f.state([a]);
    triage.refresh();
    assert.deepEqual(triage.view({ full: false, visibleNetworks: ['devnet-humid'] }).new.map((g) => [g.title, g.count]), [['devnet-humid', 1]]);
  } finally { f.done(); }
});

test('a console hook is woken by the console and by nothing from outside', async () => {
  const f = fixture();
  try {
    const TOKEN = 'fixture-listener-token-0123456789abcdef';
    writeFileSync(join(f.dir, 'hooks.json'), JSON.stringify({ schemaVersion: 1, hooks: { remediation: { source: 'console', listeners: { triage: digest(TOKEN) } }, other: { source: 'github', listeners: { w: digest(TOKEN) } } } }));
    let told = 0;
    const hooks = createHooks({ dir: f.dir, dataDir: f.dataDir, waitMs: 60, log: () => {}, onChange: () => { told += 1; } });
    assert.equal((await hooks.wait('remediation', `Bearer ${TOKEN}`)).body.seq, 0);
    const held = hooks.wait('remediation', `Bearer ${TOKEN}`, '0');
    assert.equal(hooks.fire('remediation', 'triage').seq, 1);
    assert.deepEqual([(await held).body.seq, (await held).body.event], [1, 'triage']);
    // Not a console hook, not a hook: nothing fires.
    assert.equal(hooks.fire('other', 'triage'), null);
    assert.equal(hooks.fire('nothing', 'triage'), null);
    // Posted from outside it is a name that is not a hook, and counts nothing.
    const { Readable } = await import('node:stream');
    const posted = await hooks.receive('remediation', { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}`, 'x-github-event': 'push', 'x-github-delivery': 'd-1' }, Readable.from([Buffer.from('{}')]));
    assert.deepEqual(posted, { status: 401, body: { error: 'Invalid signature' } });
    const row = hooks.list().find((h) => h.name === 'remediation');
    assert.deepEqual([row.level, row.hasSecret, row.deliveries.woke, row.deliveries.refused], ['ok', true, 1, 0]);
    // Its wakes follow what breaks, on private networks too: the counts everyone can read leave it out, and no open page is told.
    const s = hooks.status();
    assert.deepEqual([s.summary.hooks, s.summary.woke, s.open.hooks, s.open.woke, s.open.lastWakeAt, told], [2, 1, 1, 0, null, 0]);
    // A console hook has listeners only.
    writeFileSync(join(f.dir, 'hooks.json'), JSON.stringify({ schemaVersion: 1, hooks: { remediation: { source: 'console', events: ['push'], listeners: {} } } }));
    assert.equal(createHooks({ dir: f.dir, dataDir: f.dataDir, log: () => {} }).status().invalid, true);
  } finally { f.done(); }
});

test('over HTTP: an administrator files, the worker reports, and nobody else reads or writes', async () => {
  const f = fixture();
  const WORKER = 'fixture-triage-worker-token-0123456789abc', LISTENER = 'fixture-listener-token-0123456789abcdef';
  writeFileSync(join(f.dir, 'workers.json'), JSON.stringify({ schemaVersion: 1, workers: { infraclaw: digest(WORKER) } }));
  writeFileSync(join(f.dir, 'hooks.json'), JSON.stringify({ schemaVersion: 1, hooks: { remediation: { source: 'console', listeners: { triage: digest(LISTENER) } } } }));
  writeFileSync(join(f.dataDir, 'settings.json'), JSON.stringify(structuredClone(DEFAULT_SETTINGS)));
  const a = { ...insight(), scope: 'testnet' };
  writeFileSync(join(f.dataDir, 'incidents', 'state.json'), JSON.stringify({ generatedAt: new Date().toISOString(), issues: [a, waiting(1)] }));
  const origin = 'http://127.0.0.1';
  const github = async (url) => (url.includes('access_token') ? Response.json({ access_token: 't' }) : Response.json({ id: 9920871, login: 'someone' }));
  const app = createWeb({ dataDir: f.dataDir, origin, hooksDir: f.dir, hookWaitMs: 5000, triageWorkersFile: join(f.dir, 'workers.json'), triageSettleMs: 0, auth: { clientId: 'c', clientSecret: 's', fetcher: github }, fetcher: github });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (path, opts = {}) => {
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie, origin, ...(opts.headers || {}) } });
    for (const c of r.headers.getSetCookie()) cookie = [cookie, c.split(';')[0]].filter(Boolean).join('; ');
    return r;
  };
  const json = (method, body, headers = {}) => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  const worker = { authorization: `Bearer ${WORKER}` };
  try {
    // The listener is held; the first look at the page sorts the issues and wakes it.
    const held = fetch(`${base}/api/hooks/remediation/wait?after=0`, { headers: { authorization: `Bearer ${LISTENER}` } });
    await new Promise((r) => setTimeout(r, 50));
    const open = await (await fetch(`${base}/api/remediation/triage`)).json();
    assert.equal(open.public, true);
    assert.deepEqual(open.new.map((g) => g.title), ['testnet', 'CI']);
    assert.equal(/insight|grovedb/.test(JSON.stringify(open)), false);
    assert.equal((await (await held).json()).seq, 1);
    // The worker reads everything, with the evidence.
    const seen = await (await fetch(`${base}/api/remediation/triage`, { headers: worker })).json();
    assert.equal(seen.public, false);
    assert.equal(seen.fixing, 'off');
    assert.equal(seen.incidents.length, 2);
    const net = seen.incidents.find((i) => i.kind === 'Network'), queue = seen.incidents.find((i) => i.kind === 'CI queue');
    assert.equal(net.issues[0].target, 'insight');
    assert.deepEqual(queue.issues[0].evidence, { repo: 'dashpay/grovedb', name: 'test' });
    // Nobody without a token or an admin session writes.
    for (const headers of [{}, { authorization: 'Bearer wrong-token-0123456789abcdefghijklmnop' }]) {
      assert.equal((await fetch(`${base}/api/remediation/incidents/${net.id}`, json('PUT', { state: 'fixed' }, headers))).status, 401);
      assert.equal((await fetch(`${base}/api/remediation/known`, json('POST', { incident: net.id, reason: 'because' }, headers))).status, 401);
    }
    const reported = await fetch(`${base}/api/remediation/incidents/${net.id}`, json('PUT', { state: 'working', summary: 'looking', thread: 'thread-1' }, worker));
    assert.equal(reported.status, 200);
    assert.deepEqual([(await reported.json()).ledger.by], ['infraclaw']);
    assert.equal((await fetch(`${base}/api/remediation/incidents/${net.id}`, json('PUT', { state: 'nope' }, worker))).status, 400);
    assert.equal((await fetch(`${base}/api/remediation/incidents/ffffffffffffffff`, json('PUT', { state: 'fixed' }, worker))).status, 404);
    // The worker files a thing away; it cannot bring one back.
    const filed = await fetch(`${base}/api/remediation/known`, json('POST', { incident: queue.id, reason: 'grovedb has two runners; long queues are normal on release days' }, worker));
    assert.equal(filed.status, 201);
    const entry = (await filed.json()).entry;
    assert.equal(entry.by, 'infraclaw');
    assert.equal((await fetch(`${base}/api/remediation/known/${entry.id}`, { method: 'DELETE', headers: worker })).status, 401);
    // An administrator, signed in: sees it all, and removes the entry (with the CSRF token).
    const r = await req('/api/auth/github');
    await req(`/api/auth/callback?state=${new URL(r.headers.get('location')).searchParams.get('state')}&code=x`);
    const csrf = (await (await req('/api/session')).json()).csrf;
    const admin = await (await req('/api/remediation/triage')).json();
    assert.equal(admin.public, false);
    assert.deepEqual([admin.counts.working, admin.counts.known, admin.known[0].reason.slice(0, 7)], [1, 1, 'grovedb']);
    assert.equal(admin.worker.hook, 'remediation');
    assert.ok(admin.worker.seenAt);
    assert.equal((await req(`/api/remediation/known/${entry.id}`, { method: 'DELETE' })).status, 403, 'no CSRF token');
    assert.equal((await req(`/api/remediation/known/${entry.id}`, { method: 'DELETE', headers: { 'x-csrf-token': csrf } })).status, 200);
    const filedByAdmin = await req('/api/remediation/known', json('POST', { incident: net.id, reason: 'testnet insight is being moved', wide: true }, { 'x-csrf-token': csrf }));
    assert.equal(filedByAdmin.status, 201);
    const mine = (await filedByAdmin.json()).entry;
    assert.deepEqual([mine.by, mine.worker], ['someone', false]);
    // The worker puts more under an administrator's entry, and cannot reword it.
    assert.equal((await fetch(`${base}/api/remediation/known/${mine.id}`, json('PATCH', { reason: 'reworded' }, worker))).status, 403);
    const more = await fetch(`${base}/api/remediation/known/${mine.id}`, json('PATCH', { covers: [{ domain: 'ci', scope: 'github', target: 'dashpay/grovedb/*', code: 'queue_wait', severity: 'warning' }] }, worker));
    assert.deepEqual([more.status, (await more.json()).entry.changedBy], [200, 'infraclaw']);
    // Hiding a whole domain is refused, whoever asks.
    assert.equal((await fetch(`${base}/api/remediation/known`, json('POST', { reason: 'everything', match: [{ domain: 'ci', scope: '*', target: '*', code: '*', name: '*', severity: 'critical' }] }, worker))).status, 400);
  } finally { app.close(); server.close(); f.done(); }
});
