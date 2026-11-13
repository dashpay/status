import test from 'node:test';
import assert from 'node:assert/strict';
import { stallReasons, stallAlert, validateAlertUrl, STALL_GRACE_MS, STALL_REPEAT_MS } from './stall-alert.js';

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
  paused.delivery.receiver.counts.queued = 0;
  assert.deepEqual(codes(paused), [], 'an empty paused queue needs nobody');
  const blocked = healthy(); blocked.delivery.receiver.attention = [route, { nonsense: true }, null];
  assert.deepEqual(codes(blocked), ['route_unavailable']);
  const heartbeat = healthy(); heartbeat.delivery.receiver.workerAt = (now - 400_000) / 1000;
  assert.deepEqual(codes(heartbeat), ['worker_heartbeat_stale']);
  const old = healthy(now - 600_000); old.delivery.receiver.attention = [route];
  assert.deepEqual(codes(old), [], 'stale receiver facts are not present-tense reasons');
});

test('notifies once after the grace period, repeats every six hours and reports recovery', async () => {
  const sent = [], fetcher = async (target, options) => { assert.equal(target, url); sent.push(JSON.parse(options.body).text); return { ok: true, status: 200 }; };
  const state = healthy(); state.delivery.receiver.attention = [route];
  const at = async (ms) => { state.delivery.lastAckAt = iso(ms); state.delivery.receiver.workerAt = ms / 1000; await stallAlert(state, { url, fetcher, now: ms }); };
  await at(now);
  assert.equal(sent.length, 0, 'a short blip is not worth a message');
  assert.equal(state.stall.since, iso(now));
  await at(now + STALL_GRACE_MS);
  assert.equal(sent.length, 1); assert.match(sent[0], /stalled/); assert.match(sent[0], /route failing/);
  await at(now + STALL_GRACE_MS + 60_000);
  assert.equal(sent.length, 1);
  await at(now + STALL_GRACE_MS + STALL_REPEAT_MS);
  assert.equal(sent.length, 2);
  state.delivery.receiver.attention = [];
  await at(now + STALL_GRACE_MS + STALL_REPEAT_MS + 60_000);
  assert.equal(sent.length, 3); assert.match(sent[2], /recovered/);
  assert.equal(state.stall, undefined);
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
