import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { websiteReport } from './websites.js';
import { segments, recommendations } from '../src/website-metrics.js';

test('missing, stale and future data never appear fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'websites-'));
  try {
    assert.equal(websiteReport(dir).stale, true);
    mkdirSync(join(dir, 'websites'));
    const now = Date.now();
    for (const [offset, stale] of [[0, false], [-13 * 60_000, true], [120_000, true]]) {
      writeFileSync(join(dir, 'websites/report.json'), JSON.stringify({ schemaVersion: 1, generatedAt: new Date(now + offset).toISOString(), sites: [] }));
      assert.equal(websiteReport(dir, now).stale, stale);
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test('chart breaks lines on failed checks and missing intervals; no invented zeroes', () => {
  const at = (n, ok = true) => ({ at: new Date(n * 300_000).toISOString(), ok, ttfbMs: 100 });
  const result = segments([at(0), at(1), at(2, false), at(3), at(8)], 'ttfbMs', 0, 9 * 300_000);
  assert.deepEqual(result.map((g) => g.length), [2, 1, 1]);
  assert.ok(result.flat().every((s) => s.value === 100));
});

test('recommendations are evidence-based and failures are not performance advice', () => {
  assert.deepEqual(recommendations({ ok: false, error: 'TLS validation failed' }), ['TLS validation failed']);
  assert.ok(recommendations({ ok: true, redirects: 1, redirectMs: 95 }).some((s) => s.includes('95 ms')));
  assert.ok(!recommendations({ ok: true, encoding: 'br', htmlBytes: 1000 }).some((s) => s.includes('not compressed')));
});

const sampleAt = (t, extra = {}) => ({ at: new Date(t).toISOString(), ok: true, status: 200, error: null, ttfbMs: 120, totalMs: 180, redirects: 0, redirectMs: 0, httpVersion: '2',
  finalUrl: 'https://www.dash.org/', htmlBytes: 5000, transferBytes: 1500, encoding: 'br', cacheStatus: 'HIT', age: 12, cacheControl: 'public, max-age=60',
  phases: { dnsMs: 1, tcpMs: 2, tlsMs: 3, waitMs: 100, downloadMs: 5 }, hints: { blockingScripts: 0, imagesWithoutDimensions: 2 }, ...extra });
const siteAt = (t, extra = {}) => ({ site: 'dash.org', latest: sampleAt(t), summary24h: { ttfbP50Ms: 110, ttfbP95Ms: 300, successes: 287, samples: 288, successPercent: 99.7 }, history: [sampleAt(t)], ...extra });
function withReport(report, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'websites-'));
  try {
    mkdirSync(join(dir, 'websites'));
    const file = join(dir, 'websites/report.json');
    writeFileSync(file, JSON.stringify(report));
    return fn(dir, file);
  } finally { rmSync(dir, { recursive: true }); }
}

test('public report is rebuilt from an allowlist: unknown fields, unusable sites and oversized values never pass', () => {
  const now = Date.now(), secret = 'PRIVATE-COLLECTOR-DETAIL';
  const report = { schemaVersion: 1, generatedAt: new Date(now).toISOString(), location: 'us-west-2', collectorHost: secret, sites: [
    siteAt(now, { resolvedIp: secret, latest: sampleAt(now, { ok: false, error: 'x'.repeat(500), finalUrl: 'http://dash.org/', ttfbMs: '120', headers: { cookie: secret }, phases: { dnsMs: 1, peer: secret } }),
      history: [...Array.from({ length: 2020 }, (_, i) => sampleAt(now - (2020 - i) * 300_000, { remote: secret })), { at: 'not a time' }, null] }),
    siteAt(now, { site: 'dash.dev', latest: undefined }),
    siteAt(now, { site: 'DASH.dev', summary24h: undefined, history: 'none' }),
    ...['evil.example/x', 'user@dash.org', 'dash.org:8443', 'javascript:alert(1)', '192.0.2.1', 'localhost', '', null, 7].map((site) => siteAt(now, { site })),
    siteAt(now), null, 'dash.org',
  ] };
  const out = withReport(report, (dir) => websiteReport(dir, now));
  assert.deepEqual(Object.keys(out).sort(), ['generatedAt', 'location', 'sites', 'stale']);
  assert.equal(out.stale, false);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE-COLLECTOR-DETAIL/);
  assert.deepEqual(out.sites.map((s) => s.site), ['dash.org', 'dash.dev']);
  for (const s of out.sites) assert.ok(s.latest && typeof s.latest.at === 'string' && s.summary24h && typeof s.summary24h === 'object' && Array.isArray(s.history));
  const [org, dev] = out.sites;
  assert.equal(org.latest.error.length, 200);
  assert.equal(org.latest.finalUrl, null);
  assert.equal(org.latest.ttfbMs, null);
  assert.deepEqual(org.latest.phases, { dnsMs: 1, tcpMs: null, tlsMs: null, waitMs: null, downloadMs: null });
  assert.equal(org.history.length, 2016);
  assert.deepEqual(org.history.at(-1), sampleAt(now - 300_000));
  assert.deepEqual(dev.summary24h, { ttfbP50Ms: null, ttfbP95Ms: null, successes: null, samples: null, successPercent: null });
  assert.deepEqual(dev.history, []);
  assert.deepEqual(dev.latest, sampleAt(now));
});

test('an unchanged report file is parsed once while staleness still follows the clock', () => {
  const now = Date.now();
  withReport({ schemaVersion: 1, generatedAt: new Date(now).toISOString(), sites: [siteAt(now)] }, (dir, file) => {
    utimesSync(file, new Date(now - 60_000), new Date(now - 60_000));
    const first = websiteReport(dir, now), later = websiteReport(dir, now + 13 * 60_000);
    assert.equal(first.sites, later.sites);
    assert.equal(first.stale, false);
    assert.equal(later.stale, true);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, generatedAt: new Date(now).toISOString(), sites: [siteAt(now, { site: 'dash.dev' })] }));
    assert.deepEqual(websiteReport(dir, now).sites.map((s) => s.site), ['dash.dev']);
    writeFileSync(file, '{ truncated');
    assert.deepEqual(websiteReport(dir, now), { stale: true, sites: [], error: 'Website checks have not reported yet.' });
  });
});

test('website page helpers tolerate samples with missing fields', () => {
  assert.ok(recommendations({ ok: true, redirects: 2 }).some((s) => s.startsWith('2 redirects. ')));
  assert.doesNotMatch(recommendations({ ok: true, redirects: 1, ttfbMs: 900, redirectMs: null }).join(' '), /NaN|null|undefined/);
  assert.deepEqual(segments(undefined, 'ttfbMs', 0, 1), []);
});
