import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { againstReceiver, loadControl, requestClear, setDispatch, wireControl } from './remediation-control.js';
import { cycle } from './incident-service.js';
import { loadIncidentState, saveIncidentState } from './incidents.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

const now = Date.parse('2026-11-13T12:00:00Z');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'remediation-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'incidents'));
  writeFileSync(join(root, 'settings.json'), JSON.stringify(DEFAULT_SETTINGS));
  return root;
}

test('the switch is off until an administrator turns it on; every change advances one counter', (t) => {
  const root = fixture(t);
  assert.deepEqual(loadControl(root), { schemaVersion: 1, seq: 0, dispatch: 'off', clearSeq: 0 });
  for (const broken of ['not json', JSON.stringify({ seq: 2, dispatch: 'maybe', clearSeq: 0 }), JSON.stringify({ seq: 1, dispatch: 'on', clearSeq: 5 }), JSON.stringify({ dispatch: 'on' })]) {
    writeFileSync(join(root, 'remediation-control.json'), broken);
    assert.equal(loadControl(root).dispatch, 'off', 'a malformed file is never an implicit on');
  }
  rmSync(join(root, 'remediation-control.json'));
  assert.throws(() => setDispatch(root, 'yes', 'someone', now));
  const on = setDispatch(root, true, 'someone', now);
  assert.deepEqual([on.seq, on.dispatch, on.clearSeq, on.updatedBy], [1, 'on', 0, 'someone']);
  const cleared = requestClear(root, 'other', now + 1000);
  assert.deepEqual([cleared.seq, cleared.dispatch, cleared.clearSeq, cleared.clearedBy, cleared.updatedBy], [2, 'on', 2, 'other', 'someone']);
  const off = setDispatch(root, false, 'someone', now + 2000);
  assert.deepEqual(wireControl(off), { seq: 3, dispatch: 'off', clearSeq: 2 }, 'names and times stay on the status host');
  assert.deepEqual(wireControl(loadControl(root)), { seq: 3, dispatch: 'off', clearSeq: 2 });
});

test('controls are sent only to a receiver that announced them, and a rejecting receiver never quarantines events', async (t) => {
  const root = fixture(t);
  const params = { dataDir: root, ci: { summary: () => ({}) }, destination: 'https://receiver.example-tailnet.ts.net/v1/events', secret: 'fixture' };
  setDispatch(root, true, 'someone', now);
  const bodies = [];
  const accept = (health) => async (_, options) => { const body = JSON.parse(options.body); bodies.push(body); return Response.json({ accepted: body.events.map((e) => e.eventId), health }); };
  await cycle({ ...params, now, fetcher: accept({ status: 'ok' }) });
  assert.equal('control' in bodies[0], false, 'an older receiver rejects unknown envelope fields');
  await cycle({ ...params, now: now + 60_000, fetcher: accept({ status: 'ok', control: { seq: -1, dispatch: 'off', clearSeq: 0 } }) });
  assert.equal('control' in bodies[1], false);
  await cycle({ ...params, now: now + 120_000, fetcher: accept({ status: 'ok', control: { seq: 1, dispatch: 'on', clearSeq: 0 } }) });
  assert.deepEqual(bodies[2].control, { seq: 1, dispatch: 'on', clearSeq: 0 });
  // The receiver is rolled back and now answers 400 to the control field.
  const state = loadIncidentState(root);
  state.outbox = [{ schemaVersion: 1, eventId: `${'c'.repeat(24)}:1`, issue: { id: 'c'.repeat(24), domain: 'ci', scope: 'x', target: 'y', code: 'job_failed' } }];
  saveIncidentState(root, state);
  await cycle({ ...params, now: now + 180_000, fetcher: async () => new Response('{}', { status: 400 }) });
  const after = loadIncidentState(root);
  assert.equal(after.quarantined?.length || 0, 0);
  assert.ok(after.outbox.some((e) => e.eventId === `${'c'.repeat(24)}:1`));
  assert.equal(after.delivery.receiver.control, undefined, 'controls are withheld until the receiver announces them again');
});

test('a file behind the receiver is read as OFF above the receiver, and never asks for a clear', () => {
  const on = { seq: 5, dispatch: 'on', clearSeq: 3, localEnabled: true, lastClear: null };
  const written = { schemaVersion: 1, seq: 5, dispatch: 'on', clearSeq: 3 };
  assert.equal(againstReceiver(written, on), written, 'in step with the receiver: as written');
  assert.equal(againstReceiver({ ...written, seq: 6, dispatch: 'off' }, on).seq, 6, 'ahead with an unacknowledged request: as written');
  assert.equal(againstReceiver(written, { seq: -1, dispatch: 'off', clearSeq: 0 }), written, 'a new receiver has applied nothing');
  assert.equal(againstReceiver(written, undefined), written);
  const lost = { schemaVersion: 1, seq: 0, dispatch: 'off', clearSeq: 0 };
  assert.deepEqual(wireControl(againstReceiver(lost, on)), { seq: 6, dispatch: 'off', clearSeq: 3 });
  assert.equal(againstReceiver(lost, on).recovered, true);
  assert.deepEqual(wireControl(againstReceiver(lost, { ...on, seq: 6, dispatch: 'off' })), { seq: 6, dispatch: 'off', clearSeq: 3 }, 'once the receiver is off it is only repeated');
  assert.deepEqual(wireControl(againstReceiver({ ...written, seq: 4, clearSeq: 4 }, on)), { seq: 6, dispatch: 'off', clearSeq: 3 }, 'an older copy that says on is not trusted, and its clear is not repeated');
  assert.deepEqual(wireControl(againstReceiver(lost, { seq: 5, dispatch: 'on', clearSeq: 'x' })), { seq: 6, dispatch: 'off', clearSeq: 0 });
});

test('a lost or damaged control file switches the receiver off, and later commands are not stale', async (t) => {
  const root = fixture(t), file = join(root, 'remediation-control.json');
  const params = { dataDir: root, ci: { summary: () => ({}) }, destination: 'https://receiver.example-tailnet.ts.net/v1/events', secret: 'fixture' };
  // The receiver's rule: only a higher counter is applied (apply_control in broker.py).
  const receiver = { seq: -1, dispatch: 'off', clearSeq: 0, clears: 0 };
  const fetcher = async (_, options) => {
    const body = JSON.parse(options.body), c = body.control;
    if (c && c.clearSeq > receiver.clearSeq) { receiver.clearSeq = c.clearSeq; receiver.clears++; }
    if (c && c.seq > receiver.seq) { receiver.seq = c.seq; receiver.dispatch = c.dispatch; }
    return Response.json({ accepted: body.events.map((e) => e.eventId), health: { status: 'ok', control: { seq: receiver.seq, dispatch: receiver.dispatch, clearSeq: receiver.clearSeq, localEnabled: true } } });
  };
  let at = now;
  const beat = async (times = 1) => { for (let i = 0; i < times; i++) await cycle({ ...params, now: at += 60_000, fetcher }); };
  const acknowledged = () => loadIncidentState(root).delivery.receiver.control;
  setDispatch(root, true, 'someone', now); requestClear(root, 'someone', now);
  await beat(2);
  assert.deepEqual([receiver.seq, receiver.dispatch, receiver.clears], [2, 'on', 1]);

  for (const damage of [() => rmSync(file), () => writeFileSync(file, 'not json')]) {
    damage();
    assert.equal(loadControl(root).dispatch, 'off');
    await beat();
    assert.equal(receiver.dispatch, 'off', 'OFF reaches the receiver although the file restarted from zero');
    const applied = receiver.seq;
    await beat(2);
    assert.deepEqual([receiver.seq, receiver.dispatch, receiver.clears], [applied, 'off', 1], 'nothing more is asked, and the queue is not cleared');
    // An administrator switches on again: the command is numbered above the receiver.
    setDispatch(root, true, 'someone', at, acknowledged());
    await beat();
    assert.deepEqual([receiver.seq, receiver.dispatch, receiver.clears], [applied + 1, 'on', 1]);
  }

  // The reported case: the file is lost and OFF is pressed before the receiver's
  // sequence is known to the web process, so the command starts again from one.
  rmSync(file);
  assert.equal(setDispatch(root, false, 'someone', at).seq, 1);
  await beat();
  assert.equal(receiver.dispatch, 'off');
  // A clear after a loss is not stale either, and does not switch dispatch on.
  setDispatch(root, true, 'someone', at, acknowledged()); await beat();
  assert.equal(receiver.dispatch, 'on');
  rmSync(file);
  requestClear(root, 'someone', at, acknowledged());
  await beat();
  assert.deepEqual([receiver.dispatch, receiver.clears], ['off', 2]);
});
