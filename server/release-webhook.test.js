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

test('release task is actionable once; cannot resolve from an unbound/missing compatibility report', (t) => {
  const dataDir = temp(t); receiveRelease({ ...signed(), dataDir });
  const records = loadReleaseInbox(dataDir), state = { issues: [], outbox: [], generatedAt: new Date(now).toISOString() };
  reconcileReleaseTasks(state, records, now);
  assert.equal(state.outbox.length, 1); assert.equal(state.issues[0].domain, 'maintenance');
  assert.equal(state.issues[0].evidence.liveChangesAllowed, false);
  reconcileReleaseTasks(state, records, now + 7 * 3600_000); assert.equal(state.outbox.length, 1);
  const lastResponse = { outcome: 'resolved' };
  state.delivery = { receiver: { workerAt: now / 1000, remediation: { schemaVersion: 1, generatedAt: new Date(now).toISOString(), enabled: true,
    cases: [{ issueId: state.issues[0].id, workerState: 'completed', active: false, lastResponse }] } } };
  reconcileReleaseTasks(state, records, now + 1); assert.equal(state.issues[0].status, 'open');
  lastResponse.compatibility = { releaseId: 999, platformTag: records[0].tag, platformCommit: 'a'.repeat(40), dashnetCommit: 'b'.repeat(40), result: 'fixed', report: 'reports/check.md', tests: ['config regression passed'] };
  reconcileReleaseTasks(state, records, now + 2); assert.equal(state.issues[0].status, 'open');
  lastResponse.compatibility.releaseId = 123;
  reconcileReleaseTasks(state, records, now + 3); assert.equal(state.issues[0].status, 'resolved');
  assert.equal(state.outbox.length, 2);
  state.outbox = [];
  const view = remediationView(state, { now });
  assert.equal(view.cases[0].stageLabel, 'Compatibility verified');
  assert.match(view.cases[0].reason, /no live network changes/);
  state.issues = []; reconcileReleaseTasks(state, records, now + 40 * 86400_000);
  assert.equal(state.outbox.length, 0); // retention never replays old files
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
