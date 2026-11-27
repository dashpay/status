import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadControl, setDispatch } from './remediation-control.js';

const now = Date.parse('2026-11-13T12:00:00Z');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'remediation-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const stored = (root) => JSON.parse(readFileSync(join(root, 'remediation-control.json'), 'utf8'));

test('the switch is off until an administrator turns it on; every change advances one counter', (t) => {
  const root = fixture(t);
  assert.deepEqual(loadControl(root), { schemaVersion: 1, seq: 0, dispatch: 'off', clearSeq: 0 });
  for (const broken of ['not json', JSON.stringify({ seq: 2, dispatch: 'maybe', clearSeq: 0 }), JSON.stringify({ seq: 1, dispatch: 'on', clearSeq: 5 }), JSON.stringify({ dispatch: 'on' }), JSON.stringify({ seq: 3, dispatch: 'on' })]) {
    writeFileSync(join(root, 'remediation-control.json'), broken);
    assert.equal(loadControl(root).dispatch, 'off', 'a malformed file is never an implicit on');
  }
  rmSync(join(root, 'remediation-control.json'));
  assert.throws(() => setDispatch(root, 'yes', 'someone', now));
  const on = setDispatch(root, true, 'someone', now);
  assert.deepEqual(on, { schemaVersion: 1, seq: 1, dispatch: 'on', clearSeq: 0, updatedAt: new Date(now).toISOString(), updatedBy: 'someone' });
  assert.deepEqual(setDispatch(root, false, 'x'.repeat(60), now + 2000), { schemaVersion: 1, seq: 2, dispatch: 'off', clearSeq: 0, updatedAt: new Date(now + 2000).toISOString(), updatedBy: 'x'.repeat(39) });
  // A damaged file starts again from zero, and off.
  writeFileSync(join(root, 'remediation-control.json'), 'not json');
  assert.deepEqual([setDispatch(root, true, 'someone', now).seq, loadControl(root).dispatch], [1, 'on']);
});

test('the file keeps the form the release before this one wrote and reads', (t) => {
  const root = fixture(t), file = join(root, 'remediation-control.json');
  // As that release left it, a queue clear included.
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, seq: 7, dispatch: 'on', clearSeq: 5, updatedAt: '2026-11-10T08:00:00.000Z', updatedBy: 'someone', clearedAt: '2026-11-09T08:00:00.000Z', clearedBy: 'other' }));
  assert.deepEqual(loadControl(root), { schemaVersion: 1, seq: 7, dispatch: 'on', clearSeq: 5, updatedAt: '2026-11-10T08:00:00.000Z', updatedBy: 'someone' });
  setDispatch(root, false, 'someone', now);
  // What that release checks before it believes the file: two counters, the clear not above the other, on or off.
  const written = stored(root);
  assert.deepEqual(written, { schemaVersion: 1, seq: 8, dispatch: 'off', clearSeq: 5, updatedAt: new Date(now).toISOString(), updatedBy: 'someone' });
  assert.ok(Number.isSafeInteger(written.seq) && Number.isSafeInteger(written.clearSeq) && written.clearSeq <= written.seq && ['on', 'off'].includes(written.dispatch));
});
