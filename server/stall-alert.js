// Out-of-band notice when autonomous remediation cannot make progress. A
// stalled repair worker cannot report its own stall through the repair queue.
// Reads receiver facts only: never changes incidents, the outbox or dispatch.
export const STALL_GRACE_MS = 15 * 60_000;
export const STALL_CLEAR_MS = 15 * 60_000;
export const RECOVERY_RETRY_MS = 6 * 3600_000;

const iso = (ms) => new Date(ms).toISOString();
const clip = (value, size) => [...String(value ?? '')].map((c) => c < ' ' ? ' ' : c).join('').slice(0, size);

export function stallReasons(state, now = Date.now()) {
  const delivery = state?.delivery, reasons = [];
  if (!delivery || delivery.configured === false) return reasons;
  if (delivery.error) reasons.push({ code: 'receiver_unreachable', detail: `Repair receiver is not acknowledging events: ${clip(delivery.error, 150)}` });
  const receiver = delivery.receiver;
  // Receiver facts describe the present only while acknowledgements are fresh.
  if (!receiver || delivery.error || !(now - Date.parse(delivery.lastAckAt) < 180_000)) return reasons;
  if (Number.isFinite(receiver.workerAt) && now / 1000 - receiver.workerAt > 300) reasons.push({ code: 'worker_heartbeat_stale', detail: 'Repair worker heartbeat is older than five minutes' });
  // Switched off from the dashboard is a deliberate, visible state, not a stall.
  // A pause on the receiver host itself (or an older receiver) is still reported.
  if (receiver.remediation?.enabled === false && (receiver.counts?.queued || 0) > 0 && receiver.control?.dispatch !== 'off')
    reasons.push({ code: 'dispatch_paused', detail: `Dispatch is paused on the receiver host with ${receiver.counts.queued} queued event(s)` });
  for (const item of Array.isArray(receiver.attention) ? receiver.attention.slice(0, 10) : []) {
    if (typeof item?.code === 'string' && item.code) reasons.push({ code: clip(item.code, 60), detail: clip(item.detail || item.code, 300) });
  }
  return reasons;
}

async function post(url, text, fetcher) {
  const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`alert webhook HTTP ${response.status}`);
}

// Tracks the stall in state.stall and sends at most two messages per stall:
// one after the grace period and one when it is over. Nothing is repeated
// while a stall lasts. A stall is over only after it has stayed clear for the
// clear period: a brief recovery is the same stall, so it neither announces a
// recovery nor forgets that the stall was already announced. Without a webhook
// the stall is still recorded for the remediation board.
export async function stallAlert(state, { url = null, fetcher = fetch, now = Date.now() } = {}) {
  const reasons = stallReasons(state, now), old = state.stall || null;
  if (reasons.length) {
    // Once a stall has been stably clear, what follows is a new stall.
    const same = old && !old.recoveredAt && Number.isFinite(Date.parse(old.since));
    const since = same ? old.since : iso(now);
    state.stall = { since, notifiedAt: same ? old.notifiedAt || null : null, reasons };
    if (state.stall.notifiedAt || !url || now - Date.parse(since) < STALL_GRACE_MS) return;
    await post(url, `Dash status: autonomous remediation is stalled since ${since}.\n${reasons.slice(0, 5).map((r) => `- ${r.detail}`).join('\n')}`, fetcher);
    state.stall.notifiedAt = iso(now);
    return;
  }
  if (!old) return;
  const clearSince = Number.isFinite(Date.parse(old.clearSince)) ? old.clearSince : iso(now);
  if (!old.recoveredAt && now - Date.parse(clearSince) < STALL_CLEAR_MS) {
    state.stall = { since: old.since, notifiedAt: old.notifiedAt || null, reasons: [], clearSince };
    return;
  }
  if (old.notifiedAt && url) {
    // Keep the record until the notice is delivered, so a failed post is
    // retried on the next cycle; give up after the retry period.
    const recoveredAt = Number.isFinite(Date.parse(old.recoveredAt)) ? old.recoveredAt : iso(now);
    state.stall = { since: old.since, notifiedAt: old.notifiedAt, reasons: [], clearSince, recoveredAt };
    if (now - Date.parse(recoveredAt) < RECOVERY_RETRY_MS) await post(url, `Dash status: autonomous remediation has recovered (stalled since ${old.since}).`, fetcher);
  }
  delete state.stall;
}

export function validateAlertUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('alert webhook must be an https URL without embedded credentials');
  return url.href;
}
