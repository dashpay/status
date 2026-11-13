import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadControl, requestClear, setDispatch, wireControl } from './remediation-control.js';
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
