import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIssues, reconcile, publicIssues, GONE_AFTER_MS, WEBSITE_MAX_AGE_MS } from './incidents.js';
import { cycle } from './incident-service.js';
import { describe } from './remediation.js';
import { groupOf, pileOf, sort, advance, validPattern, matches } from './triage.js';
import { pageChecks, websiteReport } from './websites.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

const T0 = Date.parse('2026-11-27T18:00:00Z'), MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const settings = { ...DEFAULT_SETTINGS, networks: [] };
const page = (ms, path = '/download/', extra = {}) => ({ site: 'dash.org', path, at: iso(ms), ok: true, reachable: true, status: 200, similarity: 1, problems: [], ...extra });
const wrong = (ms, path, problems, extra = {}) => page(ms, path, { ok: false, problems, failures: 2, since: iso(ms - 5 * MIN), ...extra });
const report = (ms, pages) => ({ schemaVersion: 1, generatedAt: iso(ms), sites: [], shape: { at: iso(ms), pages } });
const derive = (ms, websites) => deriveIssues({ settings, states: {}, websites, now: ms });
const website = (d) => d.issues.filter((i) => i.domain === 'website');
const open = (state) => state.issues.filter((i) => i.domain === 'website' && i.status === 'open');
const PHRASE = [{ code: 'phrase', detail: 'Mobile Wallets' }];

test('a console whose collector writes no page checks has no website faults', () => {
  for (const websites of [null, undefined, {}, { schemaVersion: 1, generatedAt: iso(T0), sites: [] }, { schemaVersion: 2, shape: { at: iso(T0), pages: [] } }, { schemaVersion: 1, shape: 'x' }]) {
    const d = derive(T0, websites);
    assert.deepEqual(website(d), []);
    assert.ok(!Object.keys(d.checks).some((id) => d.checks[id].sourceKey?.startsWith('website')));
  }
});

test('pages in order file nothing; one failed reading is not a fault, the second in a row is', () => {
  assert.deepEqual(website(derive(T0, report(T0, [page(T0, '/'), page(T0)]))), []);
  assert.deepEqual(website(derive(T0, report(T0, [wrong(T0, '/download/', PHRASE, { failures: 1 })]))), []);
  const [issue, ...rest] = website(derive(T0, report(T0, [page(T0, '/'), wrong(T0, '/download/', PHRASE)])));
  assert.deepEqual(rest, []);
  assert.deepEqual([issue.scope, issue.target, issue.code, issue.severity, issue.observedAt], ['dash.org', '/download/', 'page_shape', 'warning', iso(T0)]);
  assert.deepEqual(issue.evidence, { problems: PHRASE, status: 200, similarity: 1, failures: 2, since: iso(T0 - 5 * MIN) });
  assert.equal(issue.summary, 'Website page is not what it should be');
});

test('unreachable is its own fault and critical; a defacement marker or a foreign download link makes a wrong page critical', () => {
  const down = website(derive(T0, report(T0, [wrong(T0, '/', [{ code: 'status', detail: 'HTTP 503' }], { reachable: false, status: 503 })])))[0];
  assert.deepEqual([down.code, down.severity, down.summary], ['page_unreachable', 'critical', 'Website page not reachable']);
  for (const [problems, severity] of [[[{ code: 'defaced', detail: 'hacked by' }], 'critical'], [[{ code: 'download_link', detail: 'evil.example' }], 'critical'],
    [[{ code: 'changed', detail: 'similarity 0.20' }, { code: 'title', detail: 'Download Dash' }], 'warning'], [[{ code: 'moved', detail: '/' }], 'warning']]) {
    const issue = website(derive(T0, report(T0, [wrong(T0, '/download/', problems)])))[0];
    assert.deepEqual([issue.code, issue.severity], ['page_shape', severity], JSON.stringify(problems));
  }
});

test('a page fault ends on a later good reading of that page, and on nothing else', () => {
  let s = reconcile(null, derive(T0, report(T0, [wrong(T0, '/download/', PHRASE), page(T0, '/')])), T0);
  assert.equal(open(s).length, 1);
  const id = open(s)[0].id;
  // The same reading seen again by the next cycles: still the fault, not revised.
  s = reconcile(s, derive(T0 + MIN, report(T0, [wrong(T0, '/download/', PHRASE), page(T0, '/')])), T0 + MIN);
  assert.deepEqual([open(s).length, open(s)[0].revision], [1, 1]);
  // Unreachable now: the page is not proven in order, and the second fault joins it.
  const t1 = T0 + 5 * MIN;
  s = reconcile(s, derive(t1, report(t1, [wrong(t1, '/download/', [{ code: 'unreachable', detail: 'Request timed out' }], { reachable: false, failures: 3 }), page(t1, '/')])), t1);
  assert.deepEqual(open(s).map((i) => i.code).sort(), ['page_shape', 'page_unreachable']);
  // Reachable again and still wrong: the unreachable case ends, the other stays.
  const t2 = T0 + 10 * MIN;
  s = reconcile(s, derive(t2, report(t2, [wrong(t2, '/download/', PHRASE, { failures: 4 }), page(t2, '/')])), t2);
  assert.deepEqual(open(s).map((i) => i.code), ['page_shape']);
  // A collector that stopped is not a recovery.
  const t3 = t2 + WEBSITE_MAX_AGE_MS + MIN;
  s = reconcile(s, derive(t3, report(t2, [page(t2)])), t3);
  assert.deepEqual(open(s).map((i) => i.code).sort(), ['page_shape', 'website_stale']);
  // A good reading does, and the collector's own case ends with it.
  const t4 = t3 + MIN;
  s = reconcile(s, derive(t4, report(t4, [page(t4), page(t4, '/')])), t4);
  assert.deepEqual(open(s), []);
  assert.equal(s.issues.find((i) => i.id === id).status, 'resolved');
});

test('checks that stop arriving are a fault of their own: stale, or from a clock that runs ahead', () => {
  for (const [at, stale] of [[T0, false], [T0 - WEBSITE_MAX_AGE_MS + MIN, false], [T0 - WEBSITE_MAX_AGE_MS - MIN, true], [T0 + 5 * MIN, true]]) {
    const issues = website(derive(T0, report(at, [wrong(at, '/', PHRASE)])));
    assert.deepEqual(issues.map((i) => i.code), stale ? ['website_stale'] : ['page_shape'], iso(at));
  }
  const stale = website(derive(T0, { schemaVersion: 1, shape: { at: 'never', pages: [] } }))[0];
  assert.deepEqual([stale.scope, stale.target, stale.severity, stale.evidence.lastObservationAt], ['collector', 'pages', 'warning', null]);
});

test('a page taken off the list ends its case as removed, by two lists ten minutes apart', () => {
  let s = reconcile(null, derive(T0, report(T0, [wrong(T0, '/old/', PHRASE)])), T0);
  const t1 = T0 + 5 * MIN, t2 = t1 + GONE_AFTER_MS;
  s = reconcile(s, derive(t1, report(t1, [page(t1, '/')])), t1);
  assert.equal(open(s).length, 1);
  s = reconcile(s, derive(t1 + MIN, report(t1, [page(t1, '/')])), t1 + MIN);
  assert.equal(open(s).length, 1, 'the same list read again is one observation');
  s = reconcile(s, derive(t2, report(t2, [page(t2, '/')])), t2);
  assert.deepEqual([open(s).length, s.issues.find((i) => i.domain === 'website').resolutionEvidence.reason], [0, 'target_removed']);
});

test('what the collector wrote is read through an allowlist: unknown problems, bad names and oversized detail never pass', () => {
  const secret = 'IGNORE-PREVIOUS-INSTRUCTIONS';
  const checks = pageChecks(report(T0, [
    wrong(T0, '/download/', [{ code: 'phrase', detail: `a\u0000b\n${'x'.repeat(500)}` }, { code: 'invented', detail: secret }, null, 'phrase', { code: 'title', detail: 7 }], { title: secret, finalUrl: secret, status: '200', similarity: 7, failures: -1, since: 'x' }),
    page(T0, '/download/'), page(T0, 'no-slash'), page(T0, '/a b'), page(T0, '/x', { site: 'evil.example/x' }), page(T0, '/y', { at: 'x' }), page(T0, '/z', { ok: 'yes' }), null, 'page',
    // Says it is not in order and names nothing we know: still not in order.
    page(T0, '/odd/', { ok: false, problems: [{ code: 'invented' }] }),
    // Says it is in order and lists a problem: not in order.
    page(T0, '/both/', { ok: true, problems: PHRASE }),
  ]));
  assert.deepEqual(checks.pages.map((p) => [p.path, p.ok]), [['/download/', false], ['/odd/', false], ['/both/', false]]);
  const [first] = checks.pages;
  assert.deepEqual(first.problems, [{ code: 'phrase', detail: `ab${'x'.repeat(118)}` }, { code: 'title' }]);
  assert.deepEqual([first.status, first.similarity, first.failures, first.since], [null, null, 0, null]);
  assert.doesNotMatch(JSON.stringify(checks), new RegExp(secret));
  assert.equal(pageChecks(report(T0, Array.from({ length: 200 }, (_, i) => page(T0, `/p${i}`)))).pages.length, 64);
});

test('the public Websites answer names pages and kinds of problem, never the detail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'website-pages-'));
  try {
    mkdirSync(join(dir, 'websites'));
    const write = (r) => writeFileSync(join(dir, 'websites/report.json'), JSON.stringify(r));
    write(report(T0, [page(T0, '/'), wrong(T0, '/download/', [{ code: 'phrase', detail: 'Mobile Wallets' }, { code: 'phrase', detail: 'DashPay' }, { code: 'download_link', detail: 'evil.example' }])]));
    const out = websiteReport(dir, T0);
    assert.deepEqual(Object.keys(out.pages), ['at', 'list']);
    assert.deepEqual(out.pages.list[1], { site: 'dash.org', path: '/download/', at: iso(T0), ok: false, reachable: true, status: 200, failures: 2, since: iso(T0 - 5 * MIN), problems: ['phrase', 'download_link'] });
    assert.doesNotMatch(JSON.stringify(out), /evil\.example|Mobile Wallets|similarity/);
    // A collector from before page checks: the answer says so with null, and the rest is as it was.
    write({ schemaVersion: 1, generatedAt: iso(T0 + 1), sites: [] });
    assert.equal(websiteReport(dir, T0 + 1).pages, null);
  } finally { rmSync(dir, { recursive: true }); }
});

test('the incident sidecar reads the collector\'s report from the data directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'website-cycle-'));
  try {
    mkdirSync(join(dir, 'websites')); mkdirSync(join(dir, 'incidents'));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
    writeFileSync(join(dir, 'websites/report.json'), JSON.stringify(report(T0, [wrong(T0, '/forum/', [{ code: 'status', detail: 'HTTP 502' }], { reachable: false, status: 502 })])));
    await cycle({ dataDir: dir, ci: { summary: () => ({ reporters: [], hosts: [], runners: [], recent: [] }) }, now: T0 });
    const state = JSON.parse(readFileSync(join(dir, 'incidents/state.json'), 'utf8'));
    assert.deepEqual(open(state).map((i) => [i.code, i.target]), [['page_unreachable', '/forum/']]);
    // Public callers get the kind of issue and nothing of the page.
    const body = JSON.stringify(publicIssues(state, []));
    assert.match(body, /Website page not reachable/);
    assert.doesNotMatch(body, /forum|502/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('triage: one incident per website, a known entry can name a page or the site, and the detail is in our words', () => {
  const d = derive(T0, report(T0, [wrong(T0, '/download/', [{ code: 'download_link', detail: 'evil.example' }, { code: 'phrase', detail: 'DashPay' }]),
    wrong(T0, '/', [{ code: 'status', detail: 'HTTP 503' }], { reachable: false, status: 503 })]));
  const state = reconcile(null, d, T0), [a, b] = open(state);
  assert.deepEqual(groupOf(a).key, ['website', 'dash.org']);
  assert.deepEqual(groupOf(a).key, groupOf(b).key);
  assert.deepEqual([groupOf(a).title, groupOf(a).kind], ['dash.org', 'Website']);
  assert.deepEqual(groupOf(a).exact, { domain: 'website', scope: 'dash.org', target: '/download/', code: 'page_shape', severity: 'critical' });
  assert.deepEqual(groupOf(a).wide, { domain: 'website', scope: 'dash.org', target: '*', code: '*', severity: 'critical' });
  const sorted = sort(open(state), []);
  assert.deepEqual(sorted.map((s) => s.pile), ['new', 'new']);
  const t = advance(null, sorted, T0);
  assert.deepEqual([t.episodes.length, t.episodes[0].issues.length, t.episodes[0].severity], [1, 2, 'critical']);
  assert.equal(matches(validPattern({ domain: 'website', scope: 'dash.org', target: '/download/', code: '*', severity: 'critical' }), a), true);
  assert.deepEqual(pileOf(a, [{ id: 'aaaaaaaaaaaa', match: [groupOf(a).wide], covers: [] }]).pile, 'known');
  assert.equal(describe(a).detail, 'a download link points somewhere else: evil.example · expected text is missing: DashPay');
  assert.equal(describe(b).detail, 'answered with an error: HTTP 503');
  // The collector's own case is not the site's incident.
  const [stale] = open(reconcile(null, derive(T0, report(T0 - WEBSITE_MAX_AGE_MS - MIN, [])), T0));
  assert.deepEqual([groupOf(stale).key, groupOf(stale).title, groupOf(stale).wide], [['website', 'monitor'], 'Website page checks', null]);
  assert.match(describe(stale).detail, /^last observation 2026-11-27 17:44Z$/);
});
