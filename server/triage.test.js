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
  const make = () => createTriage({ dataDir, clock: () => now, hooks, hook: 'remediation', workersFile: join(dir, 'workers.json'), log: (e) => logged.push(e) });
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
    // The same answer for a few seconds, without another look; a change ends that at once.
    const looks = f.logged.length;
    assert.equal(triage.view({ full: false, visibleNetworks: ['devnet-humid'] }), open);
    assert.notEqual(triage.view({ full: false, visibleNetworks: [] }), open);
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
  const app = createWeb({ dataDir: f.dataDir, origin, hooksDir: f.dir, hookWaitMs: 5000, triageWorkersFile: join(f.dir, 'workers.json'), auth: { clientId: 'c', clientSecret: 's', fetcher: github }, fetcher: github });
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
