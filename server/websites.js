import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Public-data-only boundary: this file is served to anonymous callers, so only
// allowlisted, type-checked fields survive. Unknown fields never pass through.
const MAX_SITES = 16, MAX_HISTORY = 2016; // seven days of five-minute samples
const integer = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const finite = (v) => Number.isFinite(v) && v >= 0 ? v : null;
const percent = (v) => finite(v) !== null && v <= 100 ? v : null;
// Date.parse rolls an impossible date forward (30 February becomes 2 March), so the written date must be a real one.
const realDate = (v) => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(v); return !!m && new Date(Date.UTC(m[1], m[2] - 1, m[3])).toISOString().startsWith(m[0]); };
const timestamp = (v) => typeof v === 'string' && realDate(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : null;
// Header-derived values may arrive as numbers or digit strings (HTTP version, Age).
const seconds = (v) => integer(typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v);
const token = (v) => ['string', 'number'].includes(typeof v) && /^[\w./-]{1,16}$/.test(String(v)) ? String(v) : null;
// Interpolated into an https:// link: a bare DNS name only (no port, path, userinfo or IP literal).
const hostname = (v) => typeof v === 'string' && v.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(v) ? v.toLowerCase() : null;
function httpsUrl(v) {
  if (typeof v !== 'string' || v.length > 2048) return null;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}
const PHASES = ['dnsMs', 'tcpMs', 'tlsMs', 'waitMs', 'downloadMs'];

function sample(s) {
  const at = timestamp(s?.at);
  if (!at) return null;
  return { at, ok: s.ok === true, status: integer(s.status), error: text(s.error, 200),
    ttfbMs: finite(s.ttfbMs), totalMs: finite(s.totalMs), redirects: integer(s.redirects), redirectMs: finite(s.redirectMs),
    httpVersion: token(s.httpVersion), finalUrl: httpsUrl(s.finalUrl), htmlBytes: integer(s.htmlBytes), transferBytes: integer(s.transferBytes),
    encoding: text(s.encoding, 32), cacheStatus: text(s.cacheStatus, 64), age: seconds(s.age), cacheControl: text(s.cacheControl, 200),
    phases: Object.fromEntries(PHASES.map((k) => [k, finite(s.phases?.[k])])),
    hints: { blockingScripts: integer(s.hints?.blockingScripts), imagesWithoutDimensions: integer(s.hints?.imagesWithoutDimensions) } };
}

// A site is usable only with a link-safe name and a latest sample; the page renders both unconditionally.
function site(s) {
  const name = hostname(s?.site), latest = sample(s?.latest);
  if (!name || !latest) return null;
  const d = s.summary24h;
  return { site: name, latest,
    summary24h: { ttfbP50Ms: finite(d?.ttfbP50Ms), ttfbP95Ms: finite(d?.ttfbP95Ms), successes: integer(d?.successes), samples: integer(d?.samples), successPercent: percent(d?.successPercent) },
    history: (Array.isArray(s.history) ? s.history : []).map(sample).filter(Boolean).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_HISTORY) };
}

function normalize(report) {
  if (report?.schemaVersion !== 1 || !Array.isArray(report.sites)) return null;
  const sites = report.sites.slice(0, MAX_SITES).map(site).filter((s, i, all) => s && all.findIndex((x) => x?.site === s.site) === i);
  return { generatedAt: timestamp(report.generatedAt), location: text(report.location, 80), sites };
}

// One parse per collector write. A file modified within the last two seconds is
// not trusted as a cache key: a second write could share its mtime and size.
// A failed read or parse is never cached: its cause can clear without changing the key.
let cache = null;
function load(file) {
  const st = statSync(file), key = `${file}|${st.mtimeMs}|${st.size}|${st.ino}`;
  if (cache?.key === key) return cache.report;
  const report = (() => { try { return normalize(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; } })();
  cache = report && Date.now() - st.mtimeMs > 2000 ? { key, report } : null;
  return report;
}

export function websiteReport(dataDir, now = Date.now()) {
  let report = null;
  try { report = load(join(dataDir, 'websites', 'report.json')); } catch { /* A missing collector is unknown, not healthy. */ }
  if (!report) return { stale: true, sites: [], error: 'Website checks have not reported yet.' };
  const age = now - Date.parse(report.generatedAt);
  return { ...report, stale: !Number.isFinite(age) || age > 12 * 60_000 || age < -60_000 };
}
