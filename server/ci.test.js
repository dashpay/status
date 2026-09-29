import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCi } from './ci.js';

const T0 = Date.parse('2026-09-29T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const report = (jobs = [], runner = {}) => ({
  v: 1, reporter: '1', python: '3.9.6', at: iso(T0),
  host: { hostname: 'mac', os: 'macOS 26.6.2', arch: 'arm64', cpus: 14, load: [1.5, 1.2, 1], memTotal: 38e9, memUsed: 20e9, uptimeSec: 3600, disks: [{ path: '/', total: 500e9, free: 130e9 }], docker: null },
  runners: [{ key: '/Users/x/actions-runner', name: 'mac-runner-brian', pool: 'platform-repositories', kind: 'native', version: '2.337.0', listening: true, busy: false, job: null, diag: { bytes: 6e9, files: 162880 }, ...runner }],
  jobs,
});
const job = (startMin, durMin, extra = {}) => ({ runner: '/Users/x/actions-runner', runnerName: 'mac-runner-brian', name: 'Swift SDK build', start: iso(T0 - startMin * 60_000), end: iso(T0 - (startMin - durMin) * 60_000), result: 'Succeeded', repo: 'dashpay/platform', runId: 100 + startMin, attempt: 1, workflow: 'Tests', event: 'push', visibility: 'public', ...extra });

test('reporter tokens authenticate; reports are stored, deduplicated and summarised', () => {
  let now = T0;
  const ci = createCi({ dataDir: mkdtempSync(join(tmpdir(), 'ci-')), clock: () => now });
  const { id, token } = ci.addReporter('Brian Mac Studio');
  assert.equal(id, 'brian-mac-studio');
  assert.match(token, /^dcr_brian-mac-studio_/);
  assert.throws(() => ci.addReporter('brian mac studio'), /already exists/);
  assert.equal(ci.authenticate(`Bearer ${token}`), id);
  assert.equal(ci.authenticate(`Bearer ${token}x`), null);
  assert.equal(ci.authenticate(token), null);
  assert.throws(() => ci.ingest(id, { v: 2 }), /v1 report/);

  assert.deepEqual(ci.ingest(id, report([job(120, 30), job(60, 30, { result: 'Failed' }), { name: 'bad' }])), { accepted: 2 });
  ci.ingest(id, report([job(60, 30, { result: 'Failed' })], { busy: true, job: { name: 'Rust tests', start: iso(T0 - 15 * 60_000), repo: 'dashpay/platform', runId: 7 } }));
  const s = ci.summary({ admin: true });
  assert.equal(s.totals.jobs24h, 2);
  assert.equal(s.totals.failed24h, 1);
  const r = s.runners[0];
  assert.equal(r.status, 'busy');
  assert.equal(r.job.name, 'Rust tests');
  assert.equal(r.day.busySec, 75 * 60); // two 30-minute jobs + 15 minutes of the running one
  assert.equal(r.hours.length, 48);
  assert.equal(r.hours.at(-1).reported, true);
  assert.equal(s.recent[0].url, 'https://github.com/dashpay/platform/actions/runs/160');
  assert.equal(s.workflows[0].jobs, 2);
  assert.equal(s.daily.length, 14);
  assert.equal(s.reporters[0].id, id);
  assert.equal(ci.summary().reporters, undefined);

  now += 4 * 60_000; // no report for four minutes
  assert.equal(ci.summary().runners[0].status, 'offline');
  ci.removeReporter(id);
  assert.equal(ci.authenticate(`Bearer ${token}`), null);
  assert.equal(ci.summary().runners.length, 0);
});

test('GitHub timing adds queue time; queued self-hosted jobs are listed', async () => {
  const now = T0;
  const dataDir = mkdtempSync(join(tmpdir(), 'ci-'));
  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const headers = { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(T0 / 1000 + 3600) };
    if (url.includes('/attempts/1/jobs')) return Response.json({ jobs: [{ id: 1, name: 'Swift SDK build', status: 'completed', conclusion: 'success', created_at: iso(T0 - 125 * 60_000), started_at: iso(T0 - 120 * 60_000 + 3000), completed_at: iso(T0 - 90 * 60_000), runner_name: 'mac-runner-brian', labels: ['self-hosted', 'macOS', 'ARM64'], html_url: 'https://github.com/dashpay/platform/actions/runs/220/job/1' }] }, { headers });
    if (url.includes('status=in_progress')) return Response.json({ workflow_runs: [{ id: 9, name: 'Tests', created_at: iso(T0 - 10 * 60_000), head_branch: 'v4.2-dev' }] }, { headers });
    if (url.includes('status=queued')) return Response.json({ workflow_runs: [] }, { headers });
    if (url.includes('/runs/9/jobs')) return Response.json({ jobs: [
      { id: 2, name: 'Swift SDK build', status: 'queued', created_at: iso(T0 - 8 * 60_000), labels: ['self-hosted', 'macOS', 'ARM64'], html_url: 'u2' },
      { id: 3, name: 'Lint', status: 'queued', created_at: iso(T0 - 8 * 60_000), labels: ['ubuntu-24.04'], html_url: 'u3' },
      { id: 4, name: 'Build', status: 'in_progress', created_at: iso(T0 - 9 * 60_000), labels: ['self-hosted'], html_url: 'u4' },
    ] }, { headers });
    return new Response('{}', { status: 404, headers });
  };
  const ci = createCi({ dataDir, clock: () => now, fetcher, github: { id: 'cid', secret: 'sec' } });
  const { id } = ci.addReporter('brian');
  ci.ingest(id, report([job(120, 30)]));
  await ci.tick();
  assert.ok(calls.every((c) => c.auth === `Basic ${Buffer.from('cid:sec').toString('base64')}`));
  const s = ci.summary();
  assert.equal(s.recent[0].queueSec, 5 * 60 + 3);
  assert.equal(s.recent[0].url, 'https://github.com/dashpay/platform/actions/runs/220/job/1');
  assert.equal(s.totals.queuedNow, 1);
  assert.equal(s.queue.jobs[0].name, 'Swift SDK build');
  assert.equal(s.workflows[0].medianQueueSec, 303);
  // A completed run is not fetched again.
  const before = calls.filter((c) => c.url.includes('/attempts/')).length;
  await ci.tick();
  assert.equal(calls.filter((c) => c.url.includes('/attempts/')).length, before);
  assert.ok(JSON.parse(readFileSync(join(dataDir, 'ci', 'github.json'), 'utf8')).rate.remaining > 0);
});
