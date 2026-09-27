import { readFileSync, statSync } from 'node:fs';

// A migration supplement, not an ExistingSnapshot or a management enrollment.
// The configured inventory owns the target list; a partial/failed poll cannot
// remove a node. Managed observations retain precedence for overlapping nodes.
export function supplementLegacy(n, view, now, operator, managedTargets = []) {
  if (!n.legacyTargets) return view;
  let report;
  try {
    if (statSync(n.legacySnapshot).size > 8 * 1024 * 1024) throw new Error('Legacy observation too large');
    report = JSON.parse(readFileSync(n.legacySnapshot, 'utf8'));
  } catch { report = null; }
  const valid = report?.kind === 'LegacyStatusObservation' && report.network === n.name && Array.isArray(report.nodes);
  const at = Date.parse(report?.observedAt);
  const fresh = valid && Number.isFinite(at) && at <= now + 60_000 && now - at < (n.legacyMaxAgeSeconds || 180) * 1000;
  const source = new Map();
  if (valid) for (const row of report.nodes) {
    if (source.has(row.name)) source.set(row.name, null); // duplicate identity is ambiguous
    else source.set(row.name, row);
  }
  // Keep the old dashboard's resource meters, with no raw status/system spread.
  // Fresh legacy metrics never override managed health, heights or services.
  const metrics = (t) => {
    const row = source.get(t.name), rowAt = row?.lastUpdated;
    if (!fresh || report.failed || !row || row.error || row.host !== t.host || row.type !== t.type ||
        !Number.isFinite(rowAt) || rowAt > now + 60_000 || now - rowAt >= (n.legacyMaxAgeSeconds || 180) * 1000) return {};
    const resources = {};
    for (const key of ['cpuPercent', 'memPercent', 'diskPercent']) {
      const value = row.system?.[key];
      if (Number.isFinite(value) && value >= 0 && value <= 100) resources[key] = value;
    }
    const result = { resources };
    if (Number.isSafeInteger(row.status?.posePenalty) && row.status.posePenalty >= 0) result.posePenalty = row.status.posePenalty;
    if (['READY', 'POSE_BANNED', 'WAITING_FOR_PROTX', 'WAITING_FOR_PROTX_CONF', 'ERROR', 'REMOVED'].includes(row.status?.masternodeState)) result.masternodeState = row.status.masternodeState;
    return result;
  };
  const existing = new Set(view.nodes.map((r) => r.name));
  const extra = n.legacyTargets.filter((t) => !existing.has(t.name)).map((t) => {
    const row = source.get(t.name), s = row?.status || {};
    const rowAt = row?.lastUpdated;
    const identity = row && row.host === t.host && row.type === t.type;
    const rowFresh = Number.isFinite(rowAt) && rowAt <= now + 60_000 && now - rowAt < (n.legacyMaxAgeSeconds || 180) * 1000;
    const unknown = !identity || report?.failed || row.error || !['healthy', 'warning', 'syncing', 'banned', 'error'].includes(row.health);
    const status = !fresh ? 'stale' : unknown ? 'unknown' : !rowFresh ? 'stale' : row.health === 'healthy' ? 'observed' : 'degraded';
    const usable = identity && rowFresh && fresh && !unknown;
    const height = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
    const result = { ...metrics(t), name: t.name, role: t.type === 'hp' ? 'validator' : 'masternode', status,
      coreHeight: identity ? height(s.coreHeight) : null, platformHeight: identity ? height(s.platformBlockHeight) : null,
      dapi: t.type === 'hp' ? 'unknown' : 'not-applicable',
      services: usable ? [{ component: 'core', image: typeof s.coreVersion === 'string' ? s.coreVersion.slice(0, 120) : '', running: s.coreServiceStatus === 'up', restarts: null }] : [] };
    if (operator) result.operator = { address: t.host, error: !identity ? 'Legacy observation unavailable or identity mismatch' : row.error ? 'Legacy SSH observation failed' : null,
      problems: status === 'degraded' ? ['Legacy monitor reports ' + row.health] : [], source: 'legacy-read-only-monitor' };
    return result;
  });
  const legacyTargets = new Map(n.legacyTargets.map((t) => [t.name, t]));
  const managedAddresses = new Map(managedTargets.map((t) => [t.name, t.address]));
  const nodes = [...view.nodes.map((node) => {
    const t = legacyTargets.get(node.name);
    if (!t || managedAddresses.get(node.name) !== t.host || ['unknown', 'stale'].includes(node.status)) return node;
    const { resources, posePenalty } = metrics(t);
    return { resources, posePenalty, ...node };
  }), ...extra];
  const counts = Object.fromEntries(['healthy', 'observed', 'degraded', 'unknown', 'stale'].map((s) => [s, nodes.filter((r) => r.status === s).length]));
  const status = counts.unknown ? 'unknown' : counts.stale ? 'stale' : counts.degraded || view.status === 'degraded' ? 'degraded' : counts.observed ? 'observed' : view.status;
  const range = (key) => { const values = nodes.map((r) => r[key]).filter((v) => Number.isFinite(v) && v > 0); return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null; };
  return { ...view, nodes, counts, expectedNodes: nodes.length, status, verifiedAt: status === 'healthy' ? view.verifiedAt : null,
    core: range('coreHeight'), platform: range('platformHeight'),
    notice: [view.notice, `${extra.length} additional masternodes use the retained read-only monitor; these observations do not certify consensus or DAPI health.`].filter(Boolean).join(' ') };
}
