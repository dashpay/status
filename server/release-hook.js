// Upstream release notices for the repair worker. GitHub posts a signed
// `release` webhook for Core, Platform and Tenderdash; the web process records
// the facts it can verify (repository, tag, pre-release flag) and the incident
// sidecar forwards each one over its signed channel. The worker host has no
// public ingress, so this relay is the only path from GitHub to it.
//
// Release titles and notes are never recorded or forwarded: they are free
// text written upstream and would reach an agent as untrusted instructions.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { issueId } from './incidents.js';
import { readJSON, writeAtomic } from '../shared/settings.js';

// The three things a network runs. Anything else is acknowledged and ignored.
export const RELEASE_COMPONENTS = { 'dashpay/dash': 'core', 'dashpay/platform': 'platform', 'dashpay/tenderdash': 'tenderdash' };
// `published` fires for releases and pre-releases; `released` also fires when a
// pre-release is promoted, which is a new stable release worth a fresh look.
const ACTIONS = new Set(['published', 'released', 'prereleased']);
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const ID = /^[a-f0-9]{24}$/;
const KEEP_MS = 180 * 86400_000;
const iso = (ms) => new Date(ms).toISOString();
const releasesDir = (dataDir) => join(dataDir, 'releases');

export function createReleaseHook({ dataDir, secret = null, clock = Date.now }) {
  const dir = releasesDir(dataDir);
  function verify(raw, header) {
    if (!secret || !Buffer.isBuffer(raw) || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
    const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`), got = Buffer.from(header);
    return got.length === want.length && timingSafeEqual(got, want);
  }
  // Returns the stored record, or null when the delivery is not a new release.
  function webhook(event, payload) {
    const repo = payload?.repository?.full_name, component = RELEASE_COMPONENTS[repo], r = payload?.release;
    if (event !== 'release' || !component || !ACTIONS.has(payload.action) || !r || r.draft === true) return null;
    if (typeof r.tag_name !== 'string' || !TAG.test(r.tag_name)) throw new Error('unsupported release tag');
    const prerelease = r.prerelease === true, now = clock();
    const id = issueId('release', repo, r.tag_name, prerelease ? 'prerelease' : 'release');
    const path = join(dir, `${id}.json`);
    // `published` and `released` arrive together for one release: record it once.
    if (existsSync(path)) return null;
    const published = Date.parse(r.published_at);
    const record = { schemaVersion: 1, id, component, repo, tag: r.tag_name, prerelease,
      // Built here, never copied from the payload.
      url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(r.tag_name)}`,
      publishedAt: Number.isFinite(published) && published <= now + 60_000 ? iso(published) : iso(now), receivedAt: iso(now) };
    mkdirSync(dir, { recursive: true });
    writeAtomic(path, JSON.stringify(record));
    for (const f of readdirSync(dir)) {
      try { if (f.endsWith('.json') && now - statSync(join(dir, f)).mtimeMs > KEEP_MS) rmSync(join(dir, f), { force: true }); } catch { /* pruned by another request */ }
    }
    return record;
  }
  return { verify, webhook, configured: () => !!secret };
}

// Read-only for the incident sidecar. Malformed files are skipped, never trusted.
export function loadReleases(dataDir) {
  const dir = releasesDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json') && ID.test(f.slice(0, -5))).map((f) => readJSON(join(dir, f)))
    .filter((r) => r && r.id && ID.test(r.id) && RELEASE_COMPONENTS[r.repo] === r.component && typeof r.tag === 'string' && TAG.test(r.tag)
      && r.id === issueId('release', r.repo, r.tag, r.prerelease === true ? 'prerelease' : 'release') && Number.isFinite(Date.parse(r.receivedAt)))
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
}

const eventFor = (r, revision, now) => ({ schemaVersion: 1, eventId: `${r.id}:${revision}`, occurredAt: iso(now), transition: revision === 1 ? 'opened' : 'reminder',
  issue: { id: r.id, revision, domain: 'release', scope: r.component, target: `${r.repo}@${r.tag}`, code: 'release_published', sourceKey: 'github:release',
    severity: 'warning', status: 'open', summary: 'Upstream release published', observedAt: iso(now),
    evidence: { component: r.component, repo: r.repo, tag: r.tag, prerelease: r.prerelease === true, url: r.url, publishedAt: r.publishedAt } } });

export const RELEASE_ATTEMPTS = 3;
export const RELEASE_RETRY_MS = 3600_000;
const FIRST_NOTICE_MS = 30 * 86400_000;

// Events the sidecar owes the worker. A release is not a fault that monitoring
// re-reports, so nothing else would offer it again: an attempt the worker
// abandoned without a result is re-sent here, a bounded number of times. A
// release an administrator cleared from the queue is left alone.
export function releaseEvents(records, state, now = Date.now()) {
  const known = state.releases && typeof state.releases === 'object' ? state.releases : {};
  const cases = new Map((Array.isArray(state.delivery?.receiver?.remediation?.cases) ? state.delivery.receiver.remediation.cases : []).map((c) => [c.issueId, c]));
  const events = [];
  for (const r of records) {
    const k = known[r.id];
    if (!k) {
      // Only a recent record is announced for the first time: an old file whose
      // memory was trimmed must never reuse an event ID the worker has seen.
      if (now - Date.parse(r.receivedAt) > FIRST_NOTICE_MS) continue;
      known[r.id] = { component: r.component, repo: r.repo, tag: r.tag, prerelease: r.prerelease === true, url: r.url, publishedAt: r.publishedAt, revision: 1, attempts: 1, emittedAt: iso(now) };
      events.push(eventFor(r, 1, now));
      continue;
    }
    const c = cases.get(r.id);
    if (c?.workerState === 'abandoned' && c.eventId === `${r.id}:${k.revision}` && k.attempts < RELEASE_ATTEMPTS
      && now - Date.parse(k.emittedAt) >= RELEASE_RETRY_MS && !(state.outbox || []).some((e) => e.issue?.id === r.id)) {
      k.revision += 1; k.attempts += 1; k.emittedAt = iso(now);
      events.push(eventFor(r, k.revision, now));
    }
  }
  // Bounded memory: the newest notices only. Older record files are pruned by the web process.
  state.releases = Object.fromEntries(Object.entries(known).sort(([, a], [, b]) => Date.parse(b.emittedAt) - Date.parse(a.emittedAt)).slice(0, 300));
  return events;
}
