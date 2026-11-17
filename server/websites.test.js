import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
