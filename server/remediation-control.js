// The administrator's repair switch. The web process writes this file and
// triage reads it: `fixing` in its answer tells the worker whether it may
// repair (deploy/TRIAGE.md). It defaults to OFF. Nothing else is asked: the
// receiver that once had to acknowledge the switch is gone.
//
// `seq` counts the changes. `clearSeq` belonged to that receiver's queue and
// is carried as it is: the release before this one reads both fields, and
// like this one takes a file without them for a damaged one.
import { join } from 'node:path';
import { readJSON, writeAtomic } from '../shared/settings.js';

const path = (dataDir) => join(dataDir, 'remediation-control.json');
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const text = (v, size) => typeof v === 'string' ? v.slice(0, size) : null;
const time = (v) => Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

export function loadControl(dataDir) {
  const c = readJSON(path(dataDir));
  // A missing or malformed file means OFF, never an implicit ON.
  if (!c || !count(c.seq) || !count(c.clearSeq) || c.clearSeq > c.seq || !['on', 'off'].includes(c.dispatch)) return { schemaVersion: 1, seq: 0, dispatch: 'off', clearSeq: 0 };
  return { schemaVersion: 1, seq: c.seq, dispatch: c.dispatch, clearSeq: c.clearSeq, updatedAt: time(c.updatedAt), updatedBy: text(c.updatedBy, 39) };
}

export function setDispatch(dataDir, enabled, actor, now = Date.now()) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
  const c = loadControl(dataDir);
  writeAtomic(path(dataDir), JSON.stringify({ ...c, seq: c.seq + 1, dispatch: enabled ? 'on' : 'off', updatedAt: new Date(now).toISOString(), updatedBy: text(actor, 39) }));
  return loadControl(dataDir);
}
