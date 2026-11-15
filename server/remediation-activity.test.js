import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearActivity, loadActivity } from './remediation-activity.js';
import { remediationView } from './remediation.js';

test('history clear survives reload, retains queued/held work, and new revisions reappear without changing monitoring', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'activity-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now(), at = new Date(now).toISOString();
  const issues = ['old', 'queued', 'held'].map((id) => ({ id, revision: 2, domain: 'ci', severity: 'warning', status: 'open' }));
  const state = { generatedAt: at, issues, outbox: [], delivery: { receiver: { workerAt: now / 1000, counts: { queued: 3 }, remediation: {
    schemaVersion: 1, generatedAt: at, enabled: false, truncated: true, progress: { attentionRequired: true, stalledRuns: 1 }, cases: [
      { issueId: 'queued', workerState: 'queued', pendingEvents: 3 }, { issueId: 'held', active: true, workerState: 'uncertain', attentionRequired: true },
    ],
  } } } };
  const original = structuredClone(state);
  clearActivity(root, state, 'PRIVATE-ADMIN', now);
  assert.deepEqual(state, original, 'display reset changes no issue, event or ownership');
  state.activityHistory = loadActivity(root);
  const view = remediationView(state, { full: true, now });
  assert.deepEqual(view.cases.map((c) => c.id).sort(), ['held', 'queued']);
  assert.equal(view.activityHistory.hidden, 1); assert.equal(view.truncated, false);
  assert.equal(view.execution, 'stalled'); assert.equal(view.stalledRuns, 1); assert.equal(view.queuedEvents, 3);
  assert.doesNotMatch(JSON.stringify(remediationView(state, { now })), /PRIVATE/);
  issues[0].revision++;
  assert.equal(remediationView(state, { full: true, now }).cases.length, 3);
  assert.equal(remediationView(state, { full: true, now }).truncated, true, 'missing new history stays visible');
  writeFileSync(join(root, 'remediation-activity.json'), '{broken');
  assert.equal(loadActivity(root), null, 'invalid reset must not hide anything');
});

test('administrator queue total uses receiver totals even when the case feed is truncated', () => {
  const state = { issues: [], delivery: { receiver: { counts: { queued: 7 }, remediation: { cases: [], truncated: true } } } };
  assert.equal(remediationView(state, { full: true }).queuedEvents, 7);
  assert.equal(remediationView(state).queuedEvents, 0, 'public network filtering cannot leak private queue counts');
});
