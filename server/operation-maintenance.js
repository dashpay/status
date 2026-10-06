// Read-only projection of the operation controller's durable records. Never
// writes operation/collector state and never infers a hold from a journal alone.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON } from '../shared/settings.js';

const MUTATING = new Set(['platform-reset', 'upgrade', 'deploy', 'create-devnet', 'delete-devnet', 'devnet-services', 'devnet-platform']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const OPERATION_LEASE_MS = 35 * 60_000;

export function operationMaintenance(dataDir, settings, now = Date.now()) {
  const dir = join(dataDir, 'ops'), result = {};
  if (!existsSync(dir)) return result;
  const managed = new Set(settings.networks.filter((n) => n.chainType !== 'mainnet' && n.kind !== 'external').map((n) => n.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && UUID.test(f.slice(0, -5)))) {
    const op = readJSON(join(dir, file));
    if (!op || op.id !== file.slice(0, -5) || !managed.has(op.network) || !MUTATING.has(op.request?.action)
      || !['confirmed', 'running'].includes(op.status)) continue;
    const started = Date.parse(op.confirmedAt), updated = Date.parse(op.updatedAt);
    // Expire abandoned records rather than silently disabling alerts forever.
    // Long-running controllers renew updatedAt when saving stage/progress data.
    if (!Number.isFinite(started) || !Number.isFinite(updated) || started > now + 60_000 || updated > now + 60_000
      || now - updated >= OPERATION_LEASE_MS || now - started >= 24 * 3600_000) continue;
    const entry = result[op.network] ??= { active:true, operations:[] };
    entry.operations.push({ id:op.id, action:op.request.action, status:op.status, since:op.confirmedAt,
      expiresAt:new Date(Math.min(updated + OPERATION_LEASE_MS, started + 24 * 3600_000)).toISOString() });
  }
  return result;
}

export function heldByOperation(issue, maintenance) {
  return issue.domain === 'network' && maintenance?.[issue.scope]?.active === true;
}
