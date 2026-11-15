import test from 'node:test';
import assert from 'node:assert/strict';
import { stallReasons, stallAlert, validateAlertUrl, STALL_GRACE_MS, STALL_CLEAR_MS, RECOVERY_RETRY_MS } from './stall-alert.js';

const now = Date.parse('2026-11-13T12:00:00Z'), iso = (ms) => new Date(ms).toISOString();
const healthy = (at = now) => ({ delivery: { configured: true, lastAckAt: iso(at), error: null,
  receiver: { workerAt: at / 1000, counts: { queued: 0 }, attention: [], remediation: { enabled: true } } } });
const codes = (state, at = now) => stallReasons(state, at).map((r) => r.code);
const route = { code: 'route_unavailable', since: now / 1000, detail: 'Repair model route failing (3 in a row)' };
const url = 'https://hooks.example.org/services/fixture';

test('a healthy or unconfigured pipeline is not stalled; each blocker is named', () => {
  assert.deepEqual(codes(healthy()), []);
  assert.deepEqual(codes({ delivery: { configured: false, error: 'receiver not configured' } }), []);
  assert.deepEqual(codes(null), []);
  const unreachable = healthy(); unreachable.delivery.error = 'receiver timeout';
  assert.deepEqual(codes(unreachable), ['receiver_unreachable']);
  const paused = healthy(); paused.delivery.receiver.remediation.enabled = false; paused.delivery.receiver.counts.queued = 4;
  assert.deepEqual(codes(paused), ['dispatch_paused']);
  paused.delivery.receiver.control = { seq: 3, dispatch: 'off', clearSeq: 0, localEnabled: true };
  assert.deepEqual(codes(paused), [], 'switched off from the dashboard is deliberate, not a stall');
  paused.delivery.receiver.control.dispatch = 'on';
  assert.deepEqual(codes(paused), ['dispatch_paused'], 'a pause on the receiver host is still reported');
  paused.delivery.receiver.counts.queued = 0;
  assert.deepEqual(codes(paused), [], 'an empty paused queue needs nobody');
  const blocked = healthy(); blocked.delivery.receiver.attention = [route, { nonsense: true }, null];
  assert.deepEqual(codes(blocked), ['route_unavailable']);
  const heartbeat = healthy(); heartbeat.delivery.receiver.workerAt = (now - 400_000) / 1000;
  assert.deepEqual(codes(heartbeat), ['worker_heartbeat_stale']);
  const old = healthy(now - 600_000); old.delivery.receiver.attention = [route];
  assert.deepEqual(codes(old), [], 'stale receiver facts are not present-tense reasons');
});

// One producer cycle at `ms`, with fresh receiver facts and the stall on or off.
const tick = (state, ms, fetcher, stalled) => {
  state.delivery.lastAckAt = iso(ms); state.delivery.receiver.workerAt = ms / 1000;
  if (stalled !== undefined) state.delivery.receiver.attention = stalled ? [route] : [];
  return stallAlert(state, { url, fetcher, now: ms });
};

test('one notice per stall: never repeated, and a brief recovery neither announces nor resets it', async () => {
  const sent = [], fetcher = async (target, options) => { assert.equal(target, url); sent.push(JSON.parse(options.body).text); return { ok: true, status: 200 }; };
  const state = healthy();
  await tick(state, now, fetcher, true);
  assert.equal(sent.length, 0, 'a short blip is not worth a message');
  assert.equal(state.stall.since, iso(now));
  await tick(state, now + STALL_GRACE_MS, fetcher);
  assert.equal(sent.length, 1); assert.match(sent[0], /stalled/); assert.match(sent[0], /route failing/);
  let t = now + STALL_GRACE_MS;
  for (const later of [60_000, 6 * 3600_000, 48 * 3600_000]) await tick(state, t + later, fetcher);
  assert.equal(sent.length, 1, 'no reminders while the same stall lasts');
  t += 48 * 3600_000;
  // It clears for a few minutes, then returns: still the same stall.
  await tick(state, t + 60_000, fetcher, false);
  await tick(state, t + STALL_CLEAR_MS - 60_000, fetcher);
  assert.equal(sent.length, 1, 'a brief recovery is not announced');
  await tick(state, t + STALL_CLEAR_MS, fetcher, true);
  await tick(state, t + STALL_CLEAR_MS + STALL_GRACE_MS + 3600_000, fetcher);
  assert.equal(sent.length, 1, 'and does not make the stall look new');
  assert.equal(state.stall.since, iso(now));
  // It stays clear: one recovery notice, once the clear period has passed.
  t += 4 * 3600_000;
  await tick(state, t, fetcher, false);
  await tick(state, t + STALL_CLEAR_MS - 1, fetcher);
  assert.equal(sent.length, 1);
  await tick(state, t + STALL_CLEAR_MS, fetcher);
  assert.equal(sent.length, 2); assert.match(sent[1], /recovered/);
  assert.equal(state.stall, undefined);
  // A later stall is a new one and is announced after its own grace period.
  await tick(state, t + 3600_000, fetcher, true);
  await tick(state, t + 3600_000 + STALL_GRACE_MS, fetcher);
  assert.equal(sent.length, 3); assert.match(sent[2], /stalled/);
  // A stall that clears before it was ever announced ends silently.
  const blip = healthy();
  await tick(blip, now, fetcher, true);
  await tick(blip, now + 60_000, fetcher, false);
  await tick(blip, now + 60_000 + STALL_CLEAR_MS, fetcher);
  assert.equal(blip.stall, undefined); assert.equal(sent.length, 3);
});

test('a failed recovery notice is retried until delivered, and a new stall meanwhile starts afresh', async () => {
  const sent = [], ok = async (_, options) => { sent.push(JSON.parse(options.body).text); return { ok: true, status: 200 }; };
  const down = async () => ({ ok: false, status: 500 });
  // Announced earlier, clear since `now`, so the recovery notice is due at `due`.
  const cleared = async () => { const s = healthy(); s.stall = { since: iso(now - 3_600_000), notifiedAt: iso(now - 1_800_000), reasons: [route] }; await tick(s, now, down, false); return s; };
  const due = now + STALL_CLEAR_MS;
  const state = await cleared();
  await assert.rejects(tick(state, due, down));
  assert.equal(state.stall.recoveredAt, iso(due), 'the pending recovery notice survives the failed post');
  await assert.rejects(tick(state, due + 60_000, down));
  await tick(state, due + 120_000, ok);
  assert.equal(sent.length, 1); assert.match(sent[0], /recovered/);
  assert.equal(state.stall, undefined);
  const again = await cleared();
  await assert.rejects(tick(again, due, down));
  await tick(again, due + 60_000, ok, true);
  assert.deepEqual([again.stall.since, again.stall.notifiedAt], [iso(due + 60_000), null], 'not treated as the old, already-announced stall');
  const dropped = await cleared();
  await assert.rejects(tick(dropped, due, down));
  await tick(dropped, due + RECOVERY_RETRY_MS, down);
  assert.equal(dropped.stall, undefined, 'a webhook that stays broken is not retried forever');
});

test('a failed notice is retried, and without a webhook the stall is still recorded', async () => {
  const failing = healthy(); failing.delivery.receiver.attention = [route];
  failing.stall = { since: iso(now - STALL_GRACE_MS), notifiedAt: null, reasons: [] };
  await assert.rejects(stallAlert(failing, { url, fetcher: async () => ({ ok: false, status: 500 }), now }));
  assert.equal(failing.stall.notifiedAt, null);
  const silent = healthy(); silent.delivery.receiver.attention = [route];
  silent.stall = { since: iso(now - STALL_GRACE_MS), notifiedAt: null, reasons: [] };
  await stallAlert(silent, { fetcher: async () => { throw new Error('no webhook is configured'); }, now });
  assert.deepEqual(silent.stall.reasons.map((r) => r.code), ['route_unavailable']);
  assert.throws(() => validateAlertUrl('http://hooks.example.org/x'));
  assert.throws(() => validateAlertUrl('https://user:secret@hooks.example.org/x'));
  assert.equal(validateAlertUrl(url), url);
});
