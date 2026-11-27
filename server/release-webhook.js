// GitHub pushes release metadata; it never supplies commands or deployment authority.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PLATFORM_REPOSITORY = 'dashpay/platform';
export const PLATFORM_REPOSITORY_ID = 424232911;
export const RELEASE_CODE = 'platform_release_compatibility';
// The three components a network is built from. A release of any of them can
// break dash-network-go. Platform keeps its original code, file names and issue
// identity, so tasks and receipts recorded before the other two were added stay
// valid. Names and IDs are fixed here; a payload only ever selects one of them.
export const RELEASE_SOURCES = Object.freeze({
  [PLATFORM_REPOSITORY]: Object.freeze({ id: PLATFORM_REPOSITORY_ID, component: 'Platform', code: RELEASE_CODE }),
  'dashpay/dash': Object.freeze({ id: 19352450, component: 'Dash Core', code: 'core_release_compatibility' }),
  'dashpay/tenderdash': Object.freeze({ id: 283521505, component: 'Tenderdash', code: 'tenderdash_release_compatibility' }),
});
export const RELEASE_CODES = Object.freeze(Object.fromEntries(Object.values(RELEASE_SOURCES).map((s) => [s.code, s.component])));
const sourceOf = (repository) => (typeof repository === 'string' && Object.hasOwn(RELEASE_SOURCES, repository) ? RELEASE_SOURCES[repository] : null);
const TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const iso = (at) => new Date(at).toISOString();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const syncDir = (path) => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };

export function receiveRelease({ dataDir, secret, raw, signature, event, delivery, now = Date.now() }) {
  if (!secret) fail('Release webhook is not configured', 503);
  if (!Buffer.isBuffer(raw) || !/^sha256=[a-f0-9]{64}$/.test(signature || '')) fail('Invalid webhook signature', 401);
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) fail('Invalid webhook signature', 401);
  if (!/^[a-f0-9-]{36}$/i.test(delivery || '')) fail('Invalid delivery ID');
  let payload;
  try { payload = JSON.parse(raw); } catch { fail('Invalid JSON'); }
  const repository = payload?.repository?.full_name, source = sourceOf(repository);
  if (!source || payload.repository.id !== source.id) fail('Repository is not allowed', 403);
  if (event === 'ping') return { accepted: true, ping: true };
  if (event !== 'release' || payload.action !== 'published') return { accepted: true, ignored: true };
  const r = payload.release;
  if (!Number.isSafeInteger(r?.id) || r.id <= 0 || r.draft !== false || typeof r.prerelease !== 'boolean'
      || typeof r.tag_name !== 'string' || r.tag_name.length > 100 || !TAG.test(r.tag_name)
      || !Number.isFinite(Date.parse(r.published_at)) || Date.parse(r.published_at) > now + 60_000) fail('Invalid published release');
  const record = { schemaVersion: 1, repository, repositoryId: source.id,
    releaseId: r.id, tag: r.tag_name, prerelease: r.prerelease, publishedAt: iso(r.published_at),
    receivedAt: iso(now), deliveryId: delivery, url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(r.tag_name)}` };
  const dir = join(dataDir, 'release-inbox');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  syncDir(dataDir);
  // Write + fsync before atomically exposing the record. Never overwrite a release.
  const path = join(dir, `${source.id}-${r.id}.json`), tmp = join(dir, `.${randomUUID()}.tmp`);
  let duplicate = false;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(tmp, path); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = JSON.parse(readFileSync(path, 'utf8'));
      if (old.repositoryId !== record.repositoryId || old.releaseId !== record.releaseId || old.tag !== record.tag) fail('Conflicting release identity', 409);
      duplicate = true;
    }
    syncDir(dir);
  } finally { try { unlinkSync(tmp); } catch { /* already absent */ } }
  return { accepted: true, duplicate, releaseId: record.releaseId, task: `Check and fix dash-network-go compatibility with ${source.component} ${record.tag}` };
}

export function loadReleaseInbox(dataDir) {
  const dir = join(dataDir, 'release-inbox');
  let names;
  try { names = readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const ids = new Set(Object.values(RELEASE_SOURCES).map((s) => String(s.id)));
  return names.filter((n) => /^[1-9][0-9]*-[1-9][0-9]*\.json$/.test(n) && ids.has(n.split('-')[0])).map((n) => {
    const r = JSON.parse(readFileSync(join(dir, n), 'utf8')), source = sourceOf(r.repository);
    if (!source || r.repositoryId !== source.id || !TAG.test(r.tag)
        || !Number.isSafeInteger(r.releaseId) || n !== `${source.id}-${r.releaseId}.json`) throw Error('Invalid stored release identity');
    return r;
  });
}

// Semantic-version order within one release line (major.minor). A release with
// a newer one in its own line is superseded: checking dash-network-go against
// it is no longer work anyone needs. A release is superseded only by a newer
// release, a prerelease by anything newer.
const version = (tag) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(typeof tag === 'string' ? tag : '');
  return m ? { line: `${m[1]}.${m[2]}`, patch: Number(m[3]), pre: m[4] ? m[4].split('.') : null } : null;
};
function newer(a, b) {
  if (a.patch !== b.patch) return a.patch > b.patch;
  if (!a.pre || !b.pre) return !a.pre && !!b.pre;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return y === undefined && x !== undefined;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) > Number(y);
    if (nx !== ny) return ny;
    return x > y;
  }
  return false;
}
export function supersededBy(release, releases) {
  const mine = version(release.tag);
  if (!mine) return null;
  let best = null;
  for (const other of releases) {
    const theirs = other.repository === release.repository && other.releaseId !== release.releaseId ? version(other.tag) : null;
    // A prerelease does not supersede a release: 5.0.3 stays in service while 5.0.4-rc.1 is tried.
    if (theirs && theirs.line === mine.line && !(theirs.pre && !mine.pre) && newer(theirs, mine) && (!best || newer(theirs, version(best.tag)))) best = other;
  }
  return best;
}

// Called only by the incident-state single writer. No health-fault derivation:
// a release is durable work, not a recurring outage. A task is one more issue
// for triage (domain `maintenance`). It ends when a newer release of its line
// supersedes it: the report that used to close one came from the retired
// repair receiver, and nothing reports in its place.
export function reconcileReleaseTasks(state, releases, now = Date.now()) {
  state.revisionCounters ||= {};
  for (const release of releases) {
    const source = sourceOf(release.repository);
    if (!source) continue;
    const id = createHash('sha256').update(`platform-release:${release.repositoryId}:${release.releaseId}`).digest('hex').slice(0, 24);
    let issue = state.issues.find((i) => i.id === id);
    // As in reconcile (incidents.js): the revision counts openings and endings.
    const revise = () => {
      issue.revision = (state.revisionCounters[id] || issue.revision || 0) + 1;
      state.revisionCounters[id] = issue.revision; issue.lastEventAt = iso(now);
    };
    const successor = supersededBy(release, releases);
    if (!issue) {
      // Counters survive display retention; an old webhook file never becomes a
      // task again. A release that is already superseded never becomes one.
      if (state.revisionCounters[id] || successor) continue;
      issue = { id, domain: 'maintenance', scope: 'dash-network-go', target: `${source.component} ${release.tag}`, code: source.code,
        sourceKey: `github-release:${release.repositoryId}:${release.releaseId}`, severity: 'info', status: 'open',
        summary: `Check and fix dash-network-go compatibility with ${source.component} ${release.tag}`,
        observedAt: iso(now), firstSeen: iso(now), lastSeen: iso(now), resolvedAt: null,
        evidence: { ...release, taskType: 'compatibility', mode: 'code-and-tests-only', liveChangesAllowed: false } };
      state.issues.push(issue); revise();
    }
    if (issue.status === 'open' && successor) {
      // Ended, not verified: no compatibility is claimed for this release.
      issue.status = 'resolved'; issue.resolvedAt = iso(now); issue.observedAt = iso(now);
      issue.resolutionEvidence = { reason: 'superseded', by: successor.tag, releaseId: successor.releaseId };
      revise();
    }
  }
  return state;
}
