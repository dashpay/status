// Recognises planned change (upgrade, redeploy, reboot) from live observations
// so that it does not enter the repair queue. Read-only projection: it never
// alters collector, operation or issue state and never resolves a fault.
// Every hold is bounded, so recognised activity cannot silence a fault forever.
export const SETTLE_MS = 20 * 60_000;
export const HOST_HOLD_MAX_MS = 90 * 60_000;
export const NETWORK_HOLD_MAX_MS = 3 * 3600_000;
export const ROLLING_HOSTS = 2;

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => Array.isArray(v) ? v.filter(object) : [];
const text = (v) => typeof v === 'string' && v.length > 0;
const iso = (ms) => new Date(ms).toISOString();

export const activityKey = (network, host) => `${network}/${host.instanceId || host.name}`;

// Signals come only from a fresh successful probe of the host itself.
export function hostSignals(host, now = Date.now()) {
  const probe = host?.probe, at = Date.parse(probe?.at);
  if (probe?.ok !== true || probe.skipped || !object(probe.data) || !Number.isFinite(at) || at > now + 60_000 || now - at > 180_000) return [];
  const signals = [], uptime = probe.data.system?.uptime;
  if (typeof uptime === 'number' && Number.isFinite(uptime) && uptime >= 0 && uptime * 1000 < SETTLE_MS) signals.push({ kind: 'reboot', at: at - uptime * 1000 });
  for (const k of list(probe.data.containers)) {
    const started = Date.parse(k.startedAt);
    // Recreating a container resets Docker's RestartCount. A crash loop under a
    // restart policy increments it, is not a planned change and stays actionable.
    if (k.oneShot || k.running !== true || k.restarting || (k.restarts || 0) !== 0 || !text(k.name)
      || !Number.isFinite(started) || started > at + 60_000 || at - started >= SETTLE_MS) continue;
    signals.push({ kind: 'container', at: Math.min(started, at), name: k.name.slice(0, 120) });
  }
  return signals;
}

// One episode lasts while new signals keep arriving within the settle window.
// Its total length is capped, so a recreate loop becomes actionable again.
function episode(prev, latest, now, max) {
  let last = Date.parse(prev?.lastSignalAt), since = Date.parse(prev?.since);
  if (!Number.isFinite(last) || !Number.isFinite(since) || since > last || last > now + 60_000 || now - last >= SETTLE_MS) { last = null; since = null; }
  if (latest !== null && (last === null || latest > last)) { if (last === null) since = latest; last = latest; }
  if (last === null) return null;
  return { held: now - last < SETTLE_MS && now - since < max, since: iso(since), lastSignalAt: iso(last), until: iso(Math.min(last + SETTLE_MS, since + max)) };
}

export function recognizeActivity({ settings, states, previous, now = Date.now() }) {
  const result = { schemaVersion: 1, at: iso(now), networks: {}, hosts: {} };
  for (const n of list(settings?.networks)) {
    // Mainnet and externally operated networks are never held by inference.
    if (!text(n.name) || n.chainType === 'mainnet' || n.kind === 'external') continue;
    const s = states?.[n.name];
    let changing = 0;
    for (const h of list(s?.hosts)) {
      if (h.duplicate || (!text(h.instanceId) && !text(h.name))) continue;
      const key = activityKey(n.name, h), old = previous?.hosts?.[key];
      const signals = hostSignals(h, now);
      const entry = episode(old, signals.length ? Math.max(...signals.map((x) => x.at)) : null, now, HOST_HOLD_MAX_MS);
      if (!entry) continue;
      result.hosts[key] = { ...entry, network: n.name, host: String(h.name || '').slice(0, 120), instanceId: h.instanceId || null,
        signals: signals.length ? signals.slice(0, 8).map(({ kind, name }) => ({ kind, name })) : list(old?.signals).slice(0, 8) };
      if (entry.held) changing++;
    }
    const old = previous?.networks?.[n.name];
    const oldSince = Date.parse(old?.since), oldLast = Date.parse(old?.lastSignalAt), oldJournal = Date.parse(old?.lastJournalAt);
    const continuing = Number.isFinite(oldSince) && Number.isFinite(oldLast) && oldSince <= oldLast && oldLast <= now + 60_000 && now - oldLast < SETTLE_MS;
    const owner = text(s?.journal?.owner);
    const journalAt = owner ? now : continuing && Number.isFinite(oldJournal) ? oldJournal : null;
    // A recorded failure of the operation this episode belongs to returns the
    // network's faults to remediation at once. The hosts it recreated must not
    // keep the whole network held through rolling inference.
    const failed = !owner && journalAt !== null && text(s?.journal?.lastError);
    const rolling = changing >= ROLLING_HOSTS && !failed, active = owner || rolling;
    if (!active && !continuing) continue;
    const since = continuing ? oldSince : now, last = active ? now : oldLast;
    // The network settles after an external operation releases its journal claim.
    const settling = !active && !failed && journalAt !== null && now - journalAt < SETTLE_MS;
    result.networks[n.name] = { held: (active || settling) && now - since < NETWORK_HOLD_MAX_MS, since: iso(since), lastSignalAt: iso(last),
      lastJournalAt: journalAt === null ? null : iso(journalAt), until: iso(Math.min(since + NETWORK_HOLD_MAX_MS, last + SETTLE_MS)),
      reason: owner ? 'journal' : rolling ? 'rolling' : settling ? 'settling' : failed ? 'failed' : 'ended', hosts: changing };
  }
  return result;
}
