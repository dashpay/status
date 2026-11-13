// Administrator controls for the repair worker: a dispatch switch and a queue
// clear. The web process writes this file; the incident sidecar only reads it
// and forwards three fixed fields over its signed channel. The switch defaults
// to OFF, and it can only enable dispatch that the receiver host's own ENABLED
// file already allows.
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
  return { schemaVersion: 1, seq: c.seq, dispatch: c.dispatch, clearSeq: c.clearSeq, updatedAt: time(c.updatedAt), updatedBy: text(c.updatedBy, 39),
    clearedAt: time(c.clearedAt), clearedBy: text(c.clearedBy, 39) };
}

const save = (dataDir, control) => { writeAtomic(path(dataDir), JSON.stringify(control)); return control; };

export function setDispatch(dataDir, enabled, actor, now = Date.now()) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
  const c = loadControl(dataDir);
  return save(dataDir, { ...c, seq: c.seq + 1, dispatch: enabled ? 'on' : 'off', updatedAt: new Date(now).toISOString(), updatedBy: text(actor, 39) });
}

export function requestClear(dataDir, actor, now = Date.now()) {
  const c = loadControl(dataDir), seq = c.seq + 1;
  return save(dataDir, { ...c, seq, clearSeq: seq, clearedAt: new Date(now).toISOString(), clearedBy: text(actor, 39) });
}

// Exactly what the receiver accepts. Names and times stay on the status host.
export const wireControl = (c) => ({ seq: c.seq, dispatch: c.dispatch, clearSeq: c.clearSeq });
