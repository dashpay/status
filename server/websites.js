import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function websiteReport(dataDir, now = Date.now()) {
  let report;
  try { report = JSON.parse(readFileSync(join(dataDir, 'websites', 'report.json'), 'utf8')); } catch { /* A missing collector is unknown, not healthy. */ }
  const age = now - Date.parse(report?.generatedAt);
  if (report?.schemaVersion !== 1 || !Array.isArray(report.sites)) {
    return { stale: true, sites: [], error: 'Website checks have not reported yet.' };
  }
  return { ...report, stale: !Number.isFinite(age) || age > 12 * 60_000 || age < -60_000 };
}
