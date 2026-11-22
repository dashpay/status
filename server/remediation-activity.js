// Display history only. Never changes monitoring, delivery, receipts or locks.
import { join } from 'node:path';
import { readJSON, writeAtomic } from '../shared/settings.js';

const path = (dataDir) => join(dataDir, 'remediation-activity.json');
export function loadActivity(dataDir) {
  const value = readJSON(path(dataDir));
  if (value?.schemaVersion !== 1 || !Number.isFinite(Date.parse(value.clearedAt)) || !value.revisions || typeof value.revisions !== 'object' || Array.isArray(value.revisions)
    || Object.values(value.revisions).some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  return value;
}

export function clearActivity(dataDir, state, actor, now = Date.now()) {
  const revisions = Object.fromEntries((state?.issues || []).map((i) => [i.id, Number.isSafeInteger(i.revision) ? i.revision : 0]));
  const value = { schemaVersion: 1, clearedAt: new Date(now).toISOString(), clearedBy: String(actor || '').slice(0, 39), revisions };
  writeAtomic(path(dataDir), JSON.stringify(value));
  return { clearedAt: value.clearedAt, clearedBy: value.clearedBy };
}

export function activityHidden(issue, response, state) {
  // Always retain current ownership and queued work, including stale feeds.
  if (response?.active || response?.workerState === 'queued' || response?.pendingEvents > 0 || state?.outbox?.some((e) => e.issue?.id === issue.id)) return false;
  // A fault monitoring has seen since the clear is the present, not history.
  if (issue.status === 'open' && Date.parse(issue.lastSeen) > Date.parse(state?.activityHistory?.clearedAt)) return false;
  const revisions = state?.activityHistory?.revisions;
  return !!revisions && Object.hasOwn(revisions, issue.id) && (issue.revision || 0) <= revisions[issue.id];
}
