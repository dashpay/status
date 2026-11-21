import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The nightly from-genesis Platform sync (dashpay/infra, platform-sync) pushes
// where its node is and how the last replay ended. Public-data-only boundary:
// the result is served to anonymous callers, so only allowlisted, type-checked
// fields survive. No host name, path, container name or request id passes.
export const SYNC_NETWORKS = ['testnet', 'mainnet'];
const PHASES = ['idle', 'starting', 'syncing', 'verifying', 'following', 'failed'];
const RESULTS = ['passed', 'failed'];
const BYTES = ['internetRx', 'internetTx', 'platformRx', 'platformTx', 'coreRx', 'coreTx', 'image'];
const FRESH_MS = 180_000, STALE_MS = 15 * 60_000;

const integer = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const finite = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
const boolean = (v) => (typeof v === 'boolean' ? v : null);
const enumeration = (v, allowed) => (allowed.includes(v) ? v : null);
const timestamp = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const match = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
// The reason can quote a log line. Printable ASCII only, and short.
const reason = (v) => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, ' ').slice(0, 300) : null);
const VERSION = /^[\w.+-]{1,40}$/, IMAGE = /^[\w./:@-]{1,200}$/, REVISION = /^[0-9a-f]{40}$/;

const image = (i) => (i && typeof i === 'object' ? { ref: match(i.ref, IMAGE), version: match(i.version, VERSION), revision: match(i.revision, REVISION) } : null);

function run(r) {
  if (!r || typeof r !== 'object') return null;
  return { result: enumeration(r.result, RESULTS), reason: reason(r.reason), startedAt: timestamp(r.startedAt), finishedAt: timestamp(r.finishedAt),
    durationSeconds: integer(r.durationSeconds), height: integer(r.height), image: image(r.image), tenderdash: match(r.tenderdash, VERSION),
    bytes: Object.fromEntries(BYTES.map((k) => [k, integer(r.bytes?.[k])])) };
}

export function validatePlatformSyncReport(input, now = Date.now()) {
  if (!input || input.schema !== 1 || !SYNC_NETWORKS.includes(input.network)) throw new Error('platform-sync report for testnet or mainnet required');
  const at = timestamp(input.updatedAt);
  if (!at || Date.parse(at) > now + 60_000 || now - Date.parse(at) > FRESH_MS) throw new Error('platform-sync report timestamp invalid or stale');
  const phase = enumeration(input.phase, PHASES);
  if (!phase) throw new Error('platform-sync phase unknown');
  const progress = finite(input.progress);
  return { network: input.network, generatedAt: at, phase, healthy: boolean(input.healthy), onHold: input.hold != null && input.hold !== false,
    height: integer(input.height), referenceHeight: integer(input.referenceHeight), progress: progress !== null && progress <= 1 ? progress : null,
    blocksPerSecond: finite(input.blocksPerSecond), etaSeconds: integer(input.etaSeconds), run: run(input.run), lastPassed: run(input.lastPassed) };
}

// Freshness is decided on every read: a stored report outlives the host that sent it.
export function readGenesisSync(dataDir, name, now = Date.now()) {
  if (!SYNC_NETWORKS.includes(name)) return null;
  try {
    const report = JSON.parse(readFileSync(join(dataDir, 'state', `platform-sync-${name}.json`), 'utf8'));
    const at = Date.parse(report.generatedAt);
    return Number.isFinite(at) ? { ...report, stale: now - at > STALE_MS } : null;
  } catch { return null; }
}
