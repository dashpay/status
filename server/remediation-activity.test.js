import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearActivity, loadActivity } from './remediation-activity.js';
import { remediationView } from './remediation.js';

test('history clear survives reload, hides what was there, and a new revision reappears without changing monitoring', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'activity-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now(), at = new Date(now).toISOString(), earlier = new Date(now - 3600_000).toISOString();
  const issues = [{ id: 'old', revision: 2, domain: 'ci', severity: 'warning', status: 'resolved', resolvedAt: earlier, lastSeen: earlier },
    { id: 'quiet', revision: 2, domain: 'ci', severity: 'warning', status: 'open', lastSeen: earlier },
    { id: 'never', domain: 'ci', severity: 'warning', status: 'open', lastSeen: earlier }];
  // The release that still sent events kept a case listed while one waited for
  // it or a repair held it. Neither exists any more.
  const state = { generatedAt: at, issues, outbox: [{ eventId: 'old:2', issue: { id: 'old' } }],
    delivery: { receiver: { workerAt: now / 1000, remediation: { schemaVersion: 1, generatedAt: at, cases: [{ issueId: 'quiet', active: true, workerState: 'uncertain', pendingEvents: 3 }] } } } };
  const original = structuredClone(state);
  clearActivity(root, state, 'PRIVATE-ADMIN', now);
  assert.deepEqual(state, original, 'display reset changes no issue');
  state.activityHistory = loadActivity(root);
  assert.deepEqual(state.activityHistory.revisions, { old: 2, quiet: 2, never: 0 });
  const view = remediationView(state, { full: true, now });
  assert.deepEqual([view.cases, view.activityHistory.hidden, view.activityHistory.clearedBy], [[], 3, 'PRIVATE-ADMIN']);
  assert.doesNotMatch(JSON.stringify(remediationView(state, { now })), /PRIVATE/);
  // Reopened, or changed: a revision above the one that was cleared.
  issues[0].revision++; issues[0].status = 'open';
  assert.deepEqual(remediationView(state, { full: true, now }).cases.map((c) => c.id), ['old']);
  // Seen by monitoring after the clear: the present, whatever its revision.
  issues[1].lastSeen = new Date(now + 60_000).toISOString();
  assert.deepEqual(remediationView(state, { full: true, now }).cases.map((c) => c.id).sort(), ['old', 'quiet']);
  writeFileSync(join(root, 'remediation-activity.json'), '{broken');
  assert.equal(loadActivity(root), null, 'invalid reset must not hide anything');
});
