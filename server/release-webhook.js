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

// Platform reports carry platformTag/platformCommit, as they always have. Core
// and Tenderdash reports name their repository and use releaseTag/releaseCommit;
// a Platform report may use either form.
export function validCompatibility(proof, release) {
  if (!proof || typeof proof !== 'object') return false;
  const platform = release.repository === PLATFORM_REPOSITORY;
  const named = proof.repository === release.repository && typeof proof.releaseTag === 'string';
  if (!named && !(platform && proof.repository === undefined)) return false;
  const tag = named ? proof.releaseTag : proof.platformTag, commit = named ? proof.releaseCommit : proof.platformCommit;
  return proof.releaseId === release.releaseId && tag === release.tag
    && /^[a-f0-9]{40}$/.test(commit || '') && /^[a-f0-9]{40}$/.test(proof.dashnetCommit || '')
    && ['compatible', 'fixed'].includes(proof.result) && typeof proof.report === 'string' && proof.report.length > 0
    && Array.isArray(proof.tests) && proof.tests.length > 0 && proof.tests.every((t) => typeof t === 'string' && t.length > 0);
}

// Called only by the incident-state single writer. No health-fault derivation or
// six-hour reminder loop: a release is durable work, not a recurring outage.
export function reconcileReleaseTasks(state, releases, now = Date.now()) {
  state.revisionCounters ||= {};
  const responses = new Map((state.delivery?.receiver?.remediation?.cases || []).map((c) => [c.issueId, c]));
  // A receiver from before Core and Tenderdash were added rejects their tasks,
  // and one rejected event fails its whole batch. Their releases stay in the
  // inbox until the receiver announces it takes them. Platform never waits.
  const announced = state.delivery?.receiver?.releaseRepositories;
  const taken = new Set([PLATFORM_REPOSITORY, ...(Array.isArray(announced) ? announced : [])]);
  for (const release of releases) {
    const source = sourceOf(release.repository);
    if (!source || !taken.has(release.repository)) continue;
    const id = createHash('sha256').update(`platform-release:${release.repositoryId}:${release.releaseId}`).digest('hex').slice(0, 24);
    let issue = state.issues.find((i) => i.id === id);
    const emit = (transition) => {
      issue.revision = (state.revisionCounters[id] || issue.revision || 0) + 1;
      state.revisionCounters[id] = issue.revision; issue.lastEventAt = iso(now);
      state.outbox.push({ schemaVersion: 1, eventId: `${id}:${issue.revision}`, occurredAt: iso(now), transition, issue: structuredClone(issue) });
    };
    if (!issue) {
      // Counters survive display retention; never re-enqueue an old webhook file.
      if (state.revisionCounters[id]) continue;
      issue = { id, domain: 'maintenance', scope: 'dash-network-go', target: `${source.component} ${release.tag}`, code: source.code,
        sourceKey: `github-release:${release.repositoryId}:${release.releaseId}`, severity: 'info', status: 'open',
        summary: `Check and fix dash-network-go compatibility with ${source.component} ${release.tag}`,
        observedAt: iso(now), firstSeen: iso(now), lastSeen: iso(now), resolvedAt: null,
        evidence: { ...release, taskType: 'compatibility', mode: 'code-and-tests-only', liveChangesAllowed: false } };
      state.issues.push(issue); emit('opened');
    }
    const response = responses.get(id);
    if (issue.status === 'open' && !response?.active && response?.lastResponse?.outcome === 'resolved'
        && validCompatibility(response.lastResponse.compatibility, release)) {
      issue.status = 'resolved'; issue.resolvedAt = iso(now); issue.observedAt = iso(now);
      issue.resolutionEvidence = { reason: 'compatibility_report', ...response.lastResponse.compatibility };
      emit('resolved');
    }
  }
  return state;
}
