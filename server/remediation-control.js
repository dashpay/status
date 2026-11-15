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

// The receiver keeps the highest sequence it has applied and ignores anything
// not above it. It only ever learns sequences from this file, so a receiver
// that is ahead means the file was lost, damaged or replaced by an older copy.
// Read as written, such a file could not switch the receiver off: its OFF, and
// every later command numbered from it, would be discarded as stale. So it is
// read as OFF at a sequence the receiver accepts. No clear is inferred: the
// clear counter is the one the receiver already applied.
// `acknowledged` is the control block of the receiver's last acknowledgement.
export function againstReceiver(control, acknowledged) {
  if (!count(acknowledged?.seq) || acknowledged.seq <= control.seq) return control;
  // Already off: repeat its own sequence, which changes nothing. Otherwise one above.
  const seq = acknowledged.dispatch === 'off' ? acknowledged.seq : acknowledged.seq + 1;
  return { ...control, seq, dispatch: 'off', clearSeq: count(acknowledged.clearSeq) ? Math.min(acknowledged.clearSeq, acknowledged.seq) : 0,
    updatedAt: null, updatedBy: null, recovered: true };
}

const save = (dataDir, control) => { writeAtomic(path(dataDir), JSON.stringify({ ...control, recovered: undefined })); return loadControl(dataDir); };

// Both commands are numbered above the file and above what the receiver has
// acknowledged, so neither can be stale after the file was lost.
export function setDispatch(dataDir, enabled, actor, now = Date.now(), acknowledged = null) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
  const c = againstReceiver(loadControl(dataDir), acknowledged);
  return save(dataDir, { ...c, seq: c.seq + 1, dispatch: enabled ? 'on' : 'off', updatedAt: new Date(now).toISOString(), updatedBy: text(actor, 39) });
}

export function requestClear(dataDir, actor, now = Date.now(), acknowledged = null) {
  const c = againstReceiver(loadControl(dataDir), acknowledged), seq = c.seq + 1;
  return save(dataDir, { ...c, seq, clearSeq: seq, clearedAt: new Date(now).toISOString(), clearedBy: text(actor, 39) });
}

// Exactly what the receiver accepts. Names and times stay on the status host.
export const wireControl = (c) => ({ seq: c.seq, dispatch: c.dispatch, clearSeq: c.clearSeq });
