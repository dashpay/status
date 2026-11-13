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
    // The notice is built from the release's own publication time, never from
    // when it happened to arrive, so a redelivered webhook describes it identically.
    const published = Date.parse(r.published_at);
    if (!Number.isFinite(published) || published > now + 60_000) throw new Error('release has no usable publication time');
    const record = { schemaVersion: 1, id, component, repo, tag: r.tag_name, prerelease,
      // Built here, never copied from the payload.
      url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(r.tag_name)}`,
      publishedAt: iso(published), receivedAt: iso(now) };
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
      && r.id === issueId('release', r.repo, r.tag, r.prerelease === true ? 'prerelease' : 'release')
      && Number.isFinite(Date.parse(r.publishedAt)) && Number.isFinite(Date.parse(r.receivedAt)))
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
}

// One event per release, and a pure function of the release: the same ID
// always carries the same bytes, whenever and however often it is built. The
// receiver treats an identical repeat as a duplicate and a differing one as
// corruption, so nothing here may depend on the clock or on local state.
export const releaseEvent = (r) => ({ schemaVersion: 1, eventId: `${r.id}:1`, occurredAt: r.publishedAt, transition: 'opened',
  issue: { id: r.id, revision: 1, domain: 'release', scope: r.component, target: `${r.repo}@${r.tag}`, code: 'release_published', sourceKey: 'github:release',
    severity: 'warning', status: 'open', summary: 'Upstream release published', observedAt: r.publishedAt,
    evidence: { component: r.component, repo: r.repo, tag: r.tag, prerelease: r.prerelease === true, url: r.url, publishedAt: r.publishedAt } } });

const FIRST_NOTICE_MS = 30 * 86400_000;
export const RELEASES_SHOWN = 100;

// Events the sidecar still owes the worker. Two separate memories:
//   state.releaseAnnounced  delivery identity: every release already announced,
//                           kept for as long as its record file exists and never
//                           trimmed for display;
//   state.releases          the newest few, for the board only.
// A release is announced once. The receiver queues an attempt that never ran
// again by itself, and a notice an administrator cleared stays cleared.
export function releaseEvents(records, state, now = Date.now()) {
  const announced = new Set(Array.isArray(state.releaseAnnounced) ? state.releaseAnnounced : []);
  const shown = state.releases && typeof state.releases === 'object' ? { ...state.releases } : {};
  const events = [];
  for (const r of records) {
    if (announced.has(r.id)) continue;
    announced.add(r.id);
    // An old record met with no memory of it (state was lost) is remembered
    // without being announced again. A recent one is re-sent byte for byte.
    if (now - Date.parse(r.receivedAt) <= FIRST_NOTICE_MS) events.push(releaseEvent(r));
    shown[r.id] = { component: r.component, repo: r.repo, tag: r.tag, prerelease: r.prerelease === true, url: r.url, publishedAt: r.publishedAt };
  }
  const present = new Set(records.map((r) => r.id));
  state.releaseAnnounced = [...announced].filter((id) => present.has(id));
  state.releases = Object.fromEntries(Object.entries(shown).sort(([, a], [, b]) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, RELEASES_SHOWN));
  return events;
}
