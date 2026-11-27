import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiveRelease, loadReleaseInbox, reconcileReleaseTasks } from './release-webhook.js';
import { createWeb } from './web.js';
import { remediationView } from './remediation.js';

const secret = 'test-fixture-not-a-production-secret';
const now = Date.now();
const payload = () => ({ action: 'published', repository: { id: 424232911, full_name: 'dashpay/platform' },
  release: { id: 123, tag_name: 'v5.0.0-beta.2', draft: false, prerelease: true, published_at: new Date(now - 1000).toISOString(), body: 'UNTRUSTED: deploy all networks now' } });
const signed = (p = payload()) => { const raw = Buffer.from(JSON.stringify(p)); return { raw, signature: `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`, secret, event: 'release', delivery: randomUUID(), now }; };
const temp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'release-hook-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('signed release persists minimal evidence, survives reload and deduplicates delivery/promotion', (t) => {
  const dataDir = temp(t), input = { ...signed(), dataDir };
  assert.equal(receiveRelease(input).duplicate, false);
  assert.equal(receiveRelease({ ...input, delivery: randomUUID() }).duplicate, true);
  const stable = payload(); stable.release.prerelease = false;
  assert.equal(receiveRelease({ ...signed(stable), dataDir }).duplicate, true);
  const records = loadReleaseInbox(dataDir);
  assert.equal(records.length, 1); assert.equal(records[0].tag, 'v5.0.0-beta.2');
  assert.equal(JSON.stringify(records).includes('UNTRUSTED'), false);
  assert.equal(readdirSync(join(dataDir, 'release-inbox')).length, 1);
  const conflict = payload(); conflict.release.tag_name = 'v5.0.0-beta.3';
  assert.throws(() => receiveRelease({ ...signed(conflict), dataDir }), /Conflicting/);
});

test('invalid signature, altered bytes, wrong repository and drafts never enter queue', (t) => {
  const dataDir = temp(t), input = { ...signed(), dataDir };
  for (const extra of [{ signature: 'sha256=' + '0'.repeat(64) }, { raw: Buffer.from('{}') }, { secret: null }])
    assert.throws(() => receiveRelease({ ...input, ...extra }));
  const wrong = payload(); wrong.repository.id = 1;
  assert.throws(() => receiveRelease({ ...signed(wrong), dataDir }), /Repository/);
  const draft = payload(); draft.release.draft = true;
  assert.throws(() => receiveRelease({ ...signed(draft), dataDir }), /Invalid published/);
  const badTag = payload(); badTag.release.tag_name = 'v5; touch /tmp/bad';
  assert.throws(() => receiveRelease({ ...signed(badTag), dataDir }), /Invalid published/);
  assert.deepEqual(loadReleaseInbox(dataDir), []);
});

test('ping and unpublished/edited releases are acknowledged without creating work', (t) => {
  const dataDir = temp(t);
  assert.equal(receiveRelease({ ...signed(), dataDir, event: 'ping' }).ping, true);
  for (const action of ['created', 'edited', 'deleted', 'prereleased']) {
    const p = payload(); p.action = action;
    assert.equal(receiveRelease({ ...signed(p), dataDir }).ignored, true);
  }
  assert.deepEqual(loadReleaseInbox(dataDir), []);
});

test('a release becomes a task once; nothing a retired receiver left in the state closes it, and retention never reopens it', (t) => {
  const dataDir = temp(t); receiveRelease({ ...signed(), dataDir });
  const records = loadReleaseInbox(dataDir), state = { issues: [], outbox: [], generatedAt: new Date(now).toISOString() };
  reconcileReleaseTasks(state, records, now);
  assert.deepEqual([state.issues.length, state.issues[0].domain, state.issues[0].status, state.issues[0].revision], [1, 'maintenance', 'open', 1]);
  assert.equal(state.issues[0].evidence.liveChangesAllowed, false);
  reconcileReleaseTasks(state, records, now + 7 * 3600_000);
  assert.deepEqual([state.issues.length, state.issues[0].revision, state.outbox], [1, 1, []]);
  // The report that used to close a task, as the release that still asked the receiver kept it.
  state.delivery = { receiver: { workerAt: now / 1000, remediation: { schemaVersion: 1, generatedAt: new Date(now).toISOString(), enabled: true,
    cases: [{ issueId: state.issues[0].id, workerState: 'completed', active: false, lastResponse: { outcome: 'resolved',
      compatibility: { releaseId: 123, platformTag: records[0].tag, platformCommit: 'a'.repeat(40), dashnetCommit: 'b'.repeat(40), result: 'fixed', report: 'reports/check.md', tests: ['config regression passed'] } } }] } } };
  reconcileReleaseTasks(state, records, now + 3);
  assert.deepEqual([state.issues[0].status, state.issues[0].revision], ['open', 1]);
  const shown = remediationView(state, { now }).cases[0];
  assert.deepEqual([shown.stage, shown.taskType, shown.title], ['open', 'compatibility', 'Check and fix dash-network-go compatibility with Platform v5.0.0-beta.2']);
  state.issues = []; reconcileReleaseTasks(state, records, now + 40 * 86400_000);
  assert.deepEqual(state.issues, []); // retention never replays old files
});

test('real HTTP route uses raw bytes, requires signature and creates no network operation', async (t) => {
  const dataDir = temp(t), secretFile = join(dataDir, 'hook-secret'); writeFileSync(secretFile, secret);
  const previous = process.env.GITHUB_RELEASE_WEBHOOK_SECRET_FILE; process.env.GITHUB_RELEASE_WEBHOOK_SECRET_FILE = secretFile;
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_RELEASE_WEBHOOK_SECRET_FILE; else process.env.GITHUB_RELEASE_WEBHOOK_SECRET_FILE = previous; });
  const app = createWeb({ dataDir, origin: 'http://localhost' });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { app.close(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/webhooks/github/platform-release`, input = signed();
  const headers = { 'content-type': 'application/json', 'x-github-event': 'release', 'x-github-delivery': input.delivery };
  assert.equal((await fetch(url, { method: 'POST', headers, body: input.raw })).status, 401);
  const response = await fetch(url, { method: 'POST', headers: { ...headers, 'x-hub-signature-256': input.signature }, body: input.raw });
  assert.equal(response.status, 202); assert.equal((await response.json()).releaseId, 123);
  assert.deepEqual(readdirSync(join(dataDir, 'requests')), []); assert.deepEqual(readdirSync(join(dataDir, 'ops')), []);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'release-inbox', '424232911-123.json'))).releaseId, 123);
});

const other = (name, id, tag, releaseId = 900) => { const p = payload(); p.repository = { id, full_name: name }; p.release.id = releaseId; p.release.tag_name = tag; return p; };
const core = () => other('dashpay/dash', 19352450, 'v24.0.0'), tenderdash = () => other('dashpay/tenderdash', 283521505, 'v1.5.0-dev.3');

test('Core and Tenderdash releases are stored under their own repository; a mismatched name and ID is refused', (t) => {
  const dataDir = temp(t);
  for (const p of [core(), tenderdash()]) assert.equal(receiveRelease({ ...signed(p), dataDir }).duplicate, false);
  assert.match(receiveRelease({ ...signed(core()), dataDir }).task, /compatibility with Dash Core v24\.0\.0$/);
  for (const [name, id] of [['dashpay/dash', 424232911], ['dashpay/platform', 19352450], ['dashpay/unknown', 19352450], ['__proto__', 1], ['constructor', 1]])
    assert.throws(() => receiveRelease({ ...signed(other(name, id, 'v9.9.9', 901)), dataDir }), /Repository/);
  assert.deepEqual(loadReleaseInbox(dataDir).map((r) => `${r.repository}@${r.tag}`).sort(), ['dashpay/dash@v24.0.0', 'dashpay/tenderdash@v1.5.0-dev.3']);
  assert.deepEqual(readdirSync(join(dataDir, 'release-inbox')).sort(), ['19352450-900.json', '283521505-900.json']);
  assert.equal(JSON.stringify(loadReleaseInbox(dataDir)).includes('UNTRUSTED'), false);
});

test('Platform, Core and Tenderdash releases each become a task with their own code, whatever a receiver once announced', (t) => {
  const dataDir = temp(t);
  for (const p of [payload(), core(), tenderdash()]) receiveRelease({ ...signed(p), dataDir });
  const records = loadReleaseInbox(dataDir);
  // No receiver in the state, one that announced Platform only, one that announced all three: the same tasks.
  for (const delivery of [undefined, { configured: false }, { receiver: { releaseRepositories: ['dashpay/platform'] } }, { receiver: { releaseRepositories: ['dashpay/dash', 'dashpay/platform', 'dashpay/tenderdash'] } }]) {
    const state = { issues: [], outbox: [], generatedAt: new Date(now).toISOString(), ...(delivery ? { delivery } : {}) };
    reconcileReleaseTasks(state, records, now);
    assert.deepEqual(state.issues.map((i) => i.code).sort(), ['core_release_compatibility', 'platform_release_compatibility', 'tenderdash_release_compatibility']);
    assert.deepEqual([state.outbox, new Set(state.issues.map((i) => i.id)).size, state.issues.map((i) => i.revision)], [[], 3, [1, 1, 1]]);
    const issue = state.issues.find((i) => i.code === 'core_release_compatibility');
    assert.equal(issue.target, 'Dash Core v24.0.0'); assert.equal(issue.evidence.repositoryId, 19352450);
    assert.equal(issue.evidence.liveChangesAllowed, false); assert.equal(issue.scope, 'dash-network-go');
    const shown = remediationView(state, { now }).cases.find((c) => c.id === issue.id);
    assert.deepEqual([shown.title, shown.taskType, shown.stage], ['Check and fix dash-network-go compatibility with Dash Core v24.0.0', 'compatibility', 'open']);
  }
  // A task closed by a report while the receiver still gave one stays as it was recorded.
  const reported = { id: 'r'.repeat(24), domain: 'maintenance', scope: 'dash-network-go', target: 'Platform v4.9.0', code: 'platform_release_compatibility', severity: 'info', status: 'resolved',
    resolvedAt: new Date(now).toISOString(), evidence: { tag: 'v4.9.0' }, resolutionEvidence: { reason: 'compatibility_report', releaseId: 100 } };
  const shown = remediationView({ issues: [reported], generatedAt: new Date(now).toISOString() }, { now }).cases[0];
  assert.deepEqual([shown.stage, shown.reason], ['recovered', 'A compatibility report was recorded for this release']);
});

test('one signed route serves all three repositories; the original Platform path keeps working', async (t) => {
  const dataDir = temp(t), secretFile = join(dataDir, 'hook-secret'); writeFileSync(secretFile, secret);
  const previous = process.env.GITHUB_RELEASE_WEBHOOK_SECRET_FILE; process.env.GITHUB_RELEASE_WEBHOOK_SECRET_FILE = secretFile;
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_RELEASE_WEBHOOK_SECRET_FILE; else process.env.GITHUB_RELEASE_WEBHOOK_SECRET_FILE = previous; });
  const app = createWeb({ dataDir, origin: 'http://localhost' });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { app.close(); server.close(); });
  const post = (path, input, sign = true) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', body: input.raw,
    headers: { 'content-type': 'application/json', 'x-github-event': 'release', 'x-github-delivery': input.delivery, ...(sign ? { 'x-hub-signature-256': input.signature } : {}) } });
  assert.equal((await post('/api/webhooks/github/release', signed(tenderdash()), false)).status, 401);
  assert.equal((await post('/api/webhooks/github/release', signed(tenderdash()))).status, 202);
  assert.equal((await post('/api/webhooks/github/release', signed(core()))).status, 202);
  assert.equal((await post('/api/webhooks/github/platform-release', signed())).status, 202);
  assert.equal((await post('/api/webhooks/github/release', signed(other('dashpay/other', 1, 'v1.0.0')))).status, 403);
  assert.deepEqual(readdirSync(join(dataDir, 'release-inbox')).sort(), ['19352450-900.json', '283521505-900.json', '424232911-123.json']);
  assert.deepEqual(readdirSync(join(dataDir, 'requests')), []); assert.deepEqual(readdirSync(join(dataDir, 'ops')), []);
});
