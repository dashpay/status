// Triage: what monitoring reports, sorted by whether anybody needs to hear
// about it. Monitoring (server/incidents.js) keeps one issue per failing check
// and says nothing about how they relate. This module puts them in piles:
//
//   known     somebody filed it with a reason: it is being lived with
//   expected  it follows from something known (a known entry `covers` it)
//   held      a recognised operation is in progress on its network or host
//   review    informational; nothing to repair
//   new       none of the above
//
// and groups what is new into incidents: one per network, CI host, repository
// queue, failing job or AWS resource, so that thirty jobs waiting for the same
// runners are one thing to look at. A new incident wakes the triage worker
// through a wake hook (server/hooks.js); the worker looks, repairs what it may,
// and reports back here what it did. Monitoring alone decides when a fault is
// over: nothing in this file ends an issue.
//
// The web process is the only writer of both files. The incident sidecar is
// not involved: it produces issues, and this reads them.
import { createHash, timingSafeEqual } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON, writeAtomic } from '../shared/settings.js';
import { TITLES, wildcard } from './incidents.js';
import { describe } from './remediation.js';

const RANK = { info: 0, warning: 1, critical: 2 };
const rank = (severity) => RANK[severity] ?? 1;
const worst = (severities) => severities.reduce((a, b) => (rank(b) > rank(a) ? b : a), 'info');
const DOMAINS = ['network', 'ci', 'aws', 'maintenance'];
// After the last fault of an incident clears, the incident stays open this
// long: a fault that comes back within the hour is the same incident, with the
// same Slack thread, not a new one.
export const QUIET_MS = 60 * 60_000;
// A known entry that has matched nothing for a day is dropped, so that the
// same fault next month is new again. A standing entry is kept.
export const LAPSE_MS = 24 * 3600_000;
export const ENDED_KEEP_MS = 7 * 24 * 3600_000;
export const ENDED_MAX = 200;
export const MAX_ENTRIES = 300;
export const MAX_PATTERNS = 200;
// Across the whole known list. Every open issue is tried against every pattern.
export const MAX_TOTAL_PATTERNS = 3000;
// Incidents open at once. A fault that would open one more waits, and is counted.
export const MAX_OPEN = 500;
const FRESH_MS = 180_000;
// The answer for a visitor without an account is kept this long.
const PUBLIC_MS = 5000;
// What the worker may say about an incident.
//   working    a repair run has started
//   fixed      the worker changed something and believes the fault is repaired
//   needs_you  it cannot or may not repair it; a person was told
//   noted      looked at, nothing to do (it recovered by itself, a duplicate)
export const STATES = ['working', 'fixed', 'needs_you', 'noted'];

const iso = (ms) => new Date(ms).toISOString();
const time = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const field = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 256 && ![...v].some((ch) => ch.charCodeAt(0) < 32);
const stars = (v) => /^\**$/.test(v.trim());

// A pattern names issues by the four fields monitoring identifies them with,
// each matched whole with `*` for any run of characters, and optionally by the
// name of the CI job. `severity` is a ceiling: the same fault grown worse than
// it was when somebody filed it is news again.
export function validPattern(p) {
  if (!object(p)) throw new Error('a pattern is an object');
  const unknown = Object.keys(p).find((k) => !['domain', 'scope', 'target', 'code', 'name', 'severity'].includes(k));
  if (unknown) throw new Error(`a pattern has no field ${JSON.stringify(unknown).slice(0, 40)}`);
  if (!DOMAINS.includes(p.domain)) throw new Error(`a pattern's domain is one of ${DOMAINS.join(', ')}`);
  for (const k of ['scope', 'target', 'code']) if (!field(p[k])) throw new Error(`a pattern needs ${k}: text, or * for any`);
  if (p.name !== undefined && !field(p.name)) throw new Error('a pattern\'s name is text when given');
  if (!Object.hasOwn(RANK, p.severity)) throw new Error('a pattern\'s severity is info, warning or critical');
  // A whole domain cannot be filed away in one line: a pattern names a scope
  // or a target, at least in part, or one code written out. A name of `*` is
  // no name.
  if (stars(p.scope) && stars(p.target) && p.code.includes('*')) throw new Error('a pattern must name a scope or a target, or one code without *');
  const name = p.name === undefined || stars(p.name) ? undefined : p.name.trim();
  return { domain: p.domain, scope: p.scope.trim(), target: p.target.trim(), code: p.code.trim(), ...(name === undefined ? {} : { name }), severity: p.severity };
}

export function matches(pattern, issue) {
  if (pattern.domain !== issue.domain) return false;
  if (!wildcard(pattern.scope, str(issue.scope)) || !wildcard(pattern.target, str(issue.target)) || !wildcard(pattern.code, str(issue.code))) return false;
  return pattern.name === undefined || wildcard(pattern.name, str(issue.evidence?.jobName ?? issue.evidence?.name));
}

// Which incident an issue belongs to, and how it is filed when somebody says
// "known". `exact` names this fault only. `wide` names everything of the kind
// the incident is about, for "and whatever else this causes". A job that fails
// or waits is a new issue every time, so for those the kind is the only handle
// there is and `exact` is the wide pattern.
export function groupOf(issue) {
  const e = object(issue.evidence) ? issue.evidence : {};
  const scope = str(issue.scope), target = str(issue.target), code = str(issue.code), severity = Object.hasOwn(RANK, issue.severity) ? issue.severity : 'warning';
  const exact = { domain: issue.domain, scope, target, code, severity };
  const repo = str(e.repo) || target.split('/').slice(0, 2).join('/');
  if (issue.domain === 'network') return { key: ['network', scope], title: scope, kind: 'Network', exact, wide: { domain: 'network', scope, target: '*', code: '*', severity } };
  if (issue.domain === 'ci' && code === 'queue_wait') {
    const kind = { domain: 'ci', scope, target: `${repo}/*`, code, severity };
    return { key: ['ci', 'queue', repo], title: `${repo} · jobs waiting for a runner`, kind: 'CI queue', exact: kind, wide: null };
  }
  if (issue.domain === 'ci' && code === 'job_failed') {
    const name = str(e.jobName);
    const kind = { domain: 'ci', scope: '*', target: `${repo}/*`, code, ...(name ? { name } : {}), severity };
    return { key: ['ci', 'job', repo, name], title: `${repo} · ${name || 'job'} failing`, kind: 'CI job', exact: kind, wide: null };
  }
  if (issue.domain === 'ci' && code === 'queue_stale') return { key: ['ci', 'queue-monitor'], title: 'CI queue observation', kind: 'CI', exact, wide: null };
  if (issue.domain === 'ci') return { key: ['ci', 'host', scope], title: scope, kind: 'CI host', exact, wide: { domain: 'ci', scope, target: '*', code: '*', severity } };
  if (issue.domain === 'aws' && ['idle_volume', 'idle_address'].includes(code)) return { key: ['aws', 'idle'], title: 'Unused AWS resources', kind: 'AWS', exact, wide: { domain: 'aws', scope: '*', target: '*', code, severity } };
  if (issue.domain === 'aws' && ['aws_stale', 'aws_collection_failed', 'aws_health_missing'].includes(code)) return { key: ['aws', 'monitor'], title: 'AWS collection', kind: 'AWS', exact, wide: null };
  if (issue.domain === 'aws') return { key: ['aws', scope, target], title: `${target} (${scope})`, kind: 'AWS', exact, wide: null };
  if (issue.domain === 'maintenance') return { key: ['maintenance', code, target], title: `${TITLES[code] || 'Release task'}${str(e.tag) ? ` · ${str(e.tag).slice(0, 100)}` : ''}`, kind: 'Release task', exact, wide: null };
  return { key: [str(issue.domain), scope, target], title: target || scope, kind: 'Other', exact, wide: null };
}

// One issue, one pile. A known entry is asked first, then what it covers; an
// issue above the ceiling of every pattern that names it is new, and says which
// entry it has outgrown.
export function pileOf(issue, entries) {
  let outgrown = null;
  for (const [list, pile] of [['match', 'known'], ['covers', 'expected']]) {
    for (const entry of entries) for (const pattern of entry[list]) {
      if (!matches(pattern, issue)) continue;
      if (rank(issue.severity) <= rank(pattern.severity)) return { pile, entry: entry.id };
      outgrown ??= entry.id;
    }
  }
  if (issue.suppressed) return { pile: 'held' };
  if (issue.severity === 'info' && issue.domain !== 'maintenance') return { pile: 'review' };
  return { pile: 'new', ...(outgrown ? { outgrown } : {}) };
}

// Open issues with their pile. A host latte excluded from remediation is in no
// pile: it is on the CI page, and nothing here acts on it.
export function sort(issues, entries) {
  return (Array.isArray(issues) ? issues : []).filter((i) => object(i) && i.status !== 'resolved' && !i.remediationExcluded && typeof i.id === 'string' && DOMAINS.includes(i.domain))
    .map((issue) => ({ issue, ...pileOf(issue, entries) }));
}

// Incidents over time. `previous` is what was saved; the result is what to
// save. An incident opens when its group has a new issue and none is open, and
// ends when the group has had none for QUIET_MS (recovered) or as soon as its
// issues were filed as known (filed). Its severity is the worst it has had; it
// is revised, and the worker woken again, only when it gets worse than that.
export function advance(previous, sorted, now) {
  const at = iso(now);
  const open = new Map((previous?.episodes || []).map((e) => [e.key, structuredClone(e)]));
  let ended = [...(previous?.ended || [])];
  const groups = new Map();
  for (const s of sorted) {
    if (s.pile !== 'new') continue;
    const group = groupOf(s.issue), key = JSON.stringify(group.key);
    if (!groups.has(key)) groups.set(key, { group, items: [] });
    groups.get(key).items.push(s.issue);
  }
  let unopened = 0;
  for (const [key, { group, items }] of groups) {
    const severity = worst(items.map((i) => i.severity)), things = [...new Set(items.map(thingOf))], ids = items.map((i) => i.id);
    let e = open.get(key);
    if (!e) {
      if (open.size >= MAX_OPEN) { unopened += 1; continue; }
      e = { id: hash(key, at).slice(0, 16), key, title: group.title, kind: group.kind, openedAt: at, severity, revision: 1, issues: [], things: [], current: [], clearSince: null, ledger: null };
      open.set(key, e);
    } else {
      const had = new Set(e.things);
      if (rank(severity) > rank(e.severity)) { e.severity = severity; e.revision += 1; }
      // A different thing failing in the same place is news too. The same thing
      // again is not: a job that waits or fails is one thing however often.
      else if (things.some((t) => !had.has(t))) e.revision += 1;
      e.clearSince = null;
    }
    // What is open now goes last, so that the cut never drops it.
    const now_ = new Set(ids);
    e.issues = [...e.issues.filter((id) => !now_.has(id)), ...ids].slice(-500);
    e.things = [...new Set([...e.things, ...things])].slice(-500);
    e.current = ids.slice(-500);
  }
  const pile = new Map(sorted.map((s) => [s.issue.id, s.pile]));
  for (const [key, e] of open) {
    if (groups.has(key)) continue;
    // Filed: what was new on the last look is known now. A fault that recovered
    // beside a filed one is a recovery, and gets its quiet hour.
    const filed = (e.current || []).some((id) => pile.get(id) === 'known' || pile.get(id) === 'expected');
    e.current = [];
    if (!filed) {
      // Held for an operation is neither over nor new: it waits as it is.
      if (e.issues.some((id) => pile.get(id) === 'held')) continue;
      e.clearSince ??= at;
      if (now - Date.parse(e.clearSince) < QUIET_MS) continue;
    }
    open.delete(key);
    ended.push({ ...e, endedAt: filed ? at : e.clearSince, outcome: filed ? 'filed' : 'recovered' });
  }
  ended = ended.filter((e) => now - Date.parse(e.endedAt) <= ENDED_KEEP_MS).slice(-ENDED_MAX);
  return { episodes: [...open.values()], ended, unopened };
}

// What an incident consists of, for telling "more of the same" from "something
// else": the pattern an issue would be filed under, without its severity.
const thingOf = (issue) => JSON.stringify({ ...groupOf(issue).exact, severity: undefined });

// What the worker has not been shown: an incident it has not reported on, or
// one that has got worse or gained a different fault since the revision it
// reported at.
export const unattended = (episodes) => episodes.filter((e) => !e.ledger || e.ledger.revision < e.revision).map((e) => `${e.id}:${e.revision}`);

// Known entries past their date, or idle for a day, are dropped. `idleSince` is
// when an entry was first seen to match no open issue at all.
export function lapse(entries, issues, now) {
  const open = (Array.isArray(issues) ? issues : []).filter((i) => object(i) && i.status !== 'resolved');
  const kept = [], dropped = [];
  for (const entry of entries) {
    const matched = open.some((i) => [...entry.match, ...entry.covers].some((p) => matches(p, i)));
    const next = { ...entry, idleSince: matched ? null : entry.idleSince || iso(now) };
    const over = entry.until && Date.parse(entry.until) <= now ? 'date' : !matched && !entry.standing && now - Date.parse(next.idleSince) >= LAPSE_MS ? 'idle' : null;
    if (over) dropped.push({ id: entry.id, why: over }); else kept.push(next);
  }
  return { kept, dropped };
}

const patterns = (list, least) => {
  if (!Array.isArray(list) || list.length < least || list.length > MAX_PATTERNS) throw new Error(`between ${least} and ${MAX_PATTERNS} patterns are needed`);
  const seen = new Set();
  return list.map(validPattern).filter((p) => { const k = JSON.stringify(p); return !seen.has(k) && seen.add(k); });
};
const reasonOf = (v) => {
  if (typeof v !== 'string' || v.trim().length < 3 || v.length > 500) throw new Error('a reason of 3 to 500 characters is needed: why this is known');
  return v.trim();
};
function validEntry(e) {
  try {
    if (!object(e) || !/^[a-f0-9]{12}$/.test(e.id)) return null;
    return { id: e.id, title: str(e.title).slice(0, 300), reason: reasonOf(e.reason), match: patterns(e.match, 1), covers: patterns(e.covers || [], 0),
      standing: e.standing === true, until: time(e.until), by: str(e.by).slice(0, 39), worker: e.worker === true, at: time(e.at), idleSince: time(e.idleSince),
      ...(time(e.changedAt) ? { changedBy: str(e.changedBy).slice(0, 39), changedAt: time(e.changedAt) } : {}) };
  } catch { return null; }
}
const validLedger = (l) => (object(l) && STATES.includes(l.state) && Number.isSafeInteger(l.revision)
  ? { state: l.state, revision: l.revision, summary: str(l.summary).slice(0, 2000), slack: object(l.slack) ? { channel: str(l.slack.channel), ts: str(l.slack.ts) } : null,
    thread: str(l.thread).slice(0, 100) || null, by: str(l.by).slice(0, 39), at: time(l.at), since: time(l.since) } : null);
const strings = (list) => (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string').slice(-500);
const validEpisode = (e) => (object(e) && /^[a-f0-9]{16}$/.test(e.id) && typeof e.key === 'string' && time(e.openedAt) && Number.isSafeInteger(e.revision)
  ? { id: e.id, key: e.key, title: str(e.title).slice(0, 300), kind: str(e.kind).slice(0, 40), openedAt: time(e.openedAt), severity: Object.hasOwn(RANK, e.severity) ? e.severity : 'warning', revision: e.revision,
    issues: strings(e.issues), things: strings(e.things), current: strings(e.current), clearSince: time(e.clearSince), ledger: validLedger(e.ledger),
    ...(time(e.endedAt) ? { endedAt: time(e.endedAt), outcome: e.outcome === 'filed' ? 'filed' : 'recovered' } : {}) } : null);

// Listed for the page and the worker. Evidence names hosts, branches and
// resources, and a reason is somebody's note: both are for administrators and
// the worker. Everyone else gets counts by network or area, as on the other
// pages.
const AREA = { ci: 'CI', aws: 'AWS', maintenance: 'Release tasks' };
function listing(items, full) {
  const groups = new Map();
  for (const { issue } of items) {
    const g = full ? groupOf(issue) : { key: issue.domain === 'network' ? ['network', issue.scope] : [issue.domain], title: issue.domain === 'network' ? issue.scope : AREA[issue.domain], kind: issue.domain === 'network' ? 'Network' : 'Area' };
    const key = JSON.stringify(g.key);
    if (!groups.has(key)) groups.set(key, { key, title: g.title, kind: g.kind, issues: [] });
    groups.get(key).issues.push(project(issue, full));
  }
  return [...groups.values()].map((g) => ({ ...g, severity: worst(g.issues.map((i) => i.severity)), firstSeen: g.issues.map((i) => i.firstSeen).filter(Boolean).sort()[0] || null,
    ...(full ? {} : { issues: undefined, count: g.issues.length }) }));
}
function project(issue, full) {
  const base = { id: issue.id, domain: issue.domain, code: issue.code, severity: issue.severity, title: TITLES[issue.code] || 'Status issue', firstSeen: time(issue.firstSeen), lastSeen: time(issue.lastSeen) };
  if (!full) return base;
  return { ...base, scope: str(issue.scope).slice(0, 512), target: str(issue.target).slice(0, 512), detail: null, link: null, ...describe(issue), group: undefined,
    evidence: object(issue.evidence) ? issue.evidence : {} };
}

// The store. `hooks` is the wake-hook module of the same process; `hook` is
// the name of a hook with source "console" that the worker's listener waits
// on. Without one configured nothing is woken and the worker's own timer finds
// the incident a little later.
export function createTriage({ dataDir, clock = Date.now, hooks = null, hook = process.env.TRIAGE_HOOK || 'remediation', workersFile = process.env.TRIAGE_WORKERS_FILE,
  log = (entry) => console.info(JSON.stringify(entry)), onChange = () => {} } = {}) {
  const knownPath = join(dataDir, 'remediation-known.json'), triagePath = join(dataDir, 'remediation-triage.json');
  const loadKnown = () => (readJSON(knownPath)?.entries || []).map(validEntry).filter(Boolean).slice(0, MAX_ENTRIES);
  const saveKnown = (entries) => writeAtomic(knownPath, JSON.stringify({ schemaVersion: 1, entries }));
  const loadTriage = () => {
    const t = readJSON(triagePath);
    return { episodes: (t?.episodes || []).map(validEpisode).filter(Boolean), ended: (t?.ended || []).map(validEpisode).filter((e) => e?.endedAt),
      // As long as the list of open incidents can be (MAX_OPEN), so that none is forgotten and woken for twice.
      unopened: Number.isSafeInteger(t?.unopened) && t.unopened > 0 ? t.unopened : 0, woken: (Array.isArray(t?.woken) ? t.woken : []).filter((x) => typeof x === 'string').slice(0, MAX_OPEN) };
  };
  const saveTriage = (t) => writeAtomic(triagePath, JSON.stringify({ schemaVersion: 1, ...t }));
  const incidentState = () => readJSON(join(dataDir, 'incidents', 'state.json'));
  const fresh = (state, now) => Number.isFinite(Date.parse(state?.generatedAt)) && now - Date.parse(state.generatedAt) <= FRESH_MS && Date.parse(state.generatedAt) <= now + 60_000;
  let workerSeenAt = null;

  // Bring both files up to what monitoring says now, and wake the worker for
  // whatever it has not been shown. Nothing moves on stale monitoring: an
  // incident must not be called recovered because the monitor stopped.
  // The last look is kept, for the answer to a visitor without an account: such
  // a request sorts nothing and writes nothing. The file watch and the timer in
  // the web process keep it current.
  let snapshot = null;
  const memo = new Map();
  const changed = () => { memo.clear(); onChange(); };
  const keep = (state, entries, triage) => (snapshot = { generatedAt: time(state?.generatedAt), entries, triage, sorted: sort(state?.issues, entries) });
  function refresh() {
    const now = clock(), state = incidentState();
    let entries = loadKnown();
    const before = loadTriage();
    if (!fresh(state, now)) return keep(state, entries, before);
    // A file that cannot be written must not wake the worker on every look: what
    // was woken for is in that file.
    let saved = true;
    const save = (what, fn) => { try { fn(); } catch (e) { saved = false; log({ event: 'triage-not-saved', what, error: String(e.message).slice(0, 200), at: iso(now) }); } };
    const lapsed = lapse(entries, state.issues, now);
    if (JSON.stringify(lapsed.kept) !== JSON.stringify(entries)) {
      entries = lapsed.kept;
      save('known', () => saveKnown(entries));
      for (const d of lapsed.dropped) log({ event: 'triage-known-lapsed', entry: d.id, why: d.why, at: iso(now) });
    }
    const next = advance(before, sort(state.issues, entries), now);
    const want = unattended(next.episodes), had = new Set(before.woken);
    const news = want.filter((w) => !had.has(w));
    // Kept: what is still unattended, so a restart does not wake for it twice.
    const triage = { ...next, woken: want };
    if (JSON.stringify(triage) !== JSON.stringify(before)) { save('triage', () => saveTriage(triage)); changed(); }
    if (news.length && saved) {
      const fired = hooks?.fire?.(hook, 'triage') || null;
      log({ event: 'triage-wake', hook, incidents: news.length, seq: fired?.seq ?? null, at: iso(now) });
    }
    return keep(state, entries, triage);
  }

  // The answer to "what is going on": incidents by what is happening to them,
  // then the piles. `full` is an administrator or the worker, and looks afresh.
  // Everyone else gets the last look, and the same answer for a few seconds.
  // `dispatch` is asked only when an answer is made.
  // `maintenance` gives the networks a console operation is running on (or has
  // just finished on): their faults are held, and the page and the worker are
  // told why.
  function view({ full = false, visibleNetworks = [], dispatch = () => 'off', maintenance = () => ({}) } = {}) {
    const now = clock(), key = full ? null : [...visibleNetworks].sort().join('\n'), hit = full ? null : memo.get(key);
    if (hit && now - hit.at < PUBLIC_MS && now >= hit.at) return hit.value;
    const { generatedAt, entries, triage, sorted } = full || !snapshot ? refresh() : snapshot;
    const stale = !(generatedAt && now - Date.parse(generatedAt) <= FRESH_MS && Date.parse(generatedAt) <= now + 60_000);
    const state = { generatedAt }, fixing = (typeof dispatch === 'function' ? dispatch() : dispatch) === 'on' ? 'on' : 'off', operations = maintenance();
    const visible = new Set(visibleNetworks);
    const seen = sorted.filter((s) => full || s.issue.domain !== 'network' || visible.has(s.issue.scope));
    const of = (pile) => seen.filter((s) => s.pile === pile);
    const byId = new Map(sorted.map((s) => [s.issue.id, s]));
    const stateOf = (e) => (e.ledger && e.ledger.revision >= e.revision ? e.ledger.state : e.ledger ? 'worse' : 'new');
    const incident = (e) => {
      const current = e.issues.map((id) => byId.get(id)).filter((s) => s?.pile === 'new');
      const group = current.length ? groupOf(current[0].issue) : null;
      return { id: e.id, title: e.title, kind: e.kind, severity: e.severity, revision: e.revision, openedAt: e.openedAt, clearSince: e.clearSince, endedAt: e.endedAt || null, outcome: e.outcome || null,
        state: e.endedAt ? 'ended' : stateOf(e), ledger: e.ledger, issues: current.map((s) => ({ ...project(s.issue, true), ...(s.outgrown ? { outgrown: s.outgrown } : {}) })),
        seen: e.issues.length, canWiden: !!group?.wide };
    };
    const incidents = full ? triage.episodes.map(incident).sort((a, b) => rank(b.severity) - rank(a.severity) || a.openedAt.localeCompare(b.openedAt)) : [];
    const known = full ? entries.map((entry) => ({ ...entry, issues: seen.filter((s) => s.entry === entry.id && s.pile === 'known').map((s) => project(s.issue, true)),
      expected: seen.filter((s) => s.entry === entry.id && s.pile === 'expected').map((s) => project(s.issue, true)) })) : [];
    const count = (name) => incidents.filter((i) => i.state === name).length;
    const answer = { schemaVersion: 1, public: !full, at: iso(now), generatedAt: state.generatedAt, stale, fixing,
      worker: full ? { hook, seenAt: workerSeenAt === null ? null : iso(workerSeenAt) } : undefined,
      // Incidents that could not be opened because too many are open already.
      unopened: full ? triage.unopened || 0 : undefined,
      maintenance: Object.entries(object(operations) ? operations : {}).filter(([name, v]) => v?.active === true && (full || visible.has(name)))
        .map(([network, v]) => ({ network, ...(full ? { operations: Array.isArray(v.operations) ? v.operations : [] } : {}) })),
      counts: { new: full ? count('new') + count('worse') : listing(of('new'), false).length, working: count('working'), fixed: count('fixed'), needsYou: count('needs_you'), noted: count('noted'),
        known: of('known').length, expected: of('expected').length, held: of('held').length, review: of('review').length, faults: seen.length },
      incidents, ...(full ? {} : { new: listing(of('new'), false) }),
      known, knownOpen: full ? undefined : listing([...of('known'), ...of('expected')], false),
      held: listing(of('held'), full), review: listing(of('review'), full),
      ended: full ? triage.ended.slice(-50).reverse().map((e) => ({ id: e.id, title: e.title, kind: e.kind, severity: e.severity, openedAt: e.openedAt, endedAt: e.endedAt, outcome: e.outcome, ledger: e.ledger })) : [] };
    if (!full) { if (memo.size > 50) memo.clear(); memo.set(key, { at: now, value: answer }); }
    return answer;
  }

  const openEpisode = (id) => {
    const found = refresh().triage.episodes.find((e) => e.id === id);
    if (!found) throw Object.assign(new Error('No open incident has this id'), { status: 404 });
    return found;
  };
  // The patterns an incident is filed under: every fault it has now, and with
  // `wide` everything else of its kind.
  const patternsOf = (id, wide) => {
    const episode = openEpisode(id), { sorted } = refresh();
    const faults = sorted.filter((s) => s.pile === 'new' && episode.issues.includes(s.issue.id)).map((s) => s.issue);
    if (!faults.length) throw Object.assign(new Error('This incident has no open fault to file'), { status: 409 });
    // A name is taken as written, and `*` in a pattern means "anything": a
    // fault with one in its name would be filed wider than it is.
    if (faults.some((i) => [i.scope, i.target, i.code, i.evidence?.repo, i.evidence?.jobName].some((v) => typeof v === 'string' && v.includes('*'))))
      throw Object.assign(new Error('A fault of this incident has * in its name; file it with patterns written out'), { status: 409 });
    const current = faults.map(groupOf);
    // One pattern per thing named, at the highest ceiling any of its faults has.
    const unique = (list) => {
      const out = new Map();
      for (const p of list) { const key = JSON.stringify({ ...p, severity: undefined }), had = out.get(key); if (!had || rank(p.severity) > rank(had.severity)) out.set(key, p); }
      return [...out.values()];
    };
    // Checked like patterns that were written out: what is saved must load again.
    const checked = (list) => {
      if (list.length > MAX_PATTERNS) throw Object.assign(new Error(`This incident has more than ${MAX_PATTERNS} different faults; file it with patterns written out`), { status: 409 });
      try { return list.map(validPattern); } catch (e) { throw Object.assign(new Error(`A fault of this incident cannot be filed by name (${e.message}); file it with patterns written out`), { status: 409 }); }
    };
    return { title: episode.title, match: checked(unique(current.map((g) => g.exact))), covers: wide ? checked(unique(current.map((g) => g.wide).filter(Boolean))) : [] };
  };
  const total = (entries) => entries.reduce((n, e) => n + e.match.length + e.covers.length, 0);
  const roomFor = (entries) => { if (total(entries) > MAX_TOTAL_PATTERNS) throw new Error('The known list holds too many patterns; remove entries that no longer apply'); };

  // "This is known": by an incident on the page, or by patterns written out.
  // `worker`: filed by the triage worker, not by a person.
  function file(body, by, { worker = false } = {}) {
    if (!object(body)) throw new Error('a JSON object is needed');
    const now = clock(), reason = reasonOf(body.reason);
    const from = body.incident !== undefined ? patternsOf(str(body.incident), body.wide === true) : { title: str(body.title).slice(0, 300), match: patterns(body.match, 1), covers: patterns(body.covers || [], 0) };
    let until = null;
    if (body.until !== undefined && body.until !== null) {
      until = time(body.until);
      if (!until || Date.parse(until) <= now || Date.parse(until) > now + 366 * 24 * 3600_000) throw new Error('until is a time within the next year');
    }
    const entries = loadKnown();
    if (entries.length >= MAX_ENTRIES) throw new Error('The known list is full; remove entries that no longer apply');
    const entry = { id: hash(now, reason, from.match, Math.random()).slice(0, 12), title: from.title || reason.slice(0, 80), reason, match: from.match, covers: from.covers,
      standing: body.standing === true, until, by: str(by).slice(0, 39), worker: worker === true, at: iso(now), idleSince: null };
    roomFor([...entries, entry]);
    saveKnown([...entries, entry]);
    log({ event: 'triage-known-filed', entry: entry.id, by: entry.by, patterns: entry.match.length + entry.covers.length, at: entry.at });
    refresh(); changed();
    return entry;
  }
  // "This follows from that": put an incident, or patterns, under an entry as
  // expected. Whoever filed the entry, or an administrator, can amend its reason
  // in the same call; the worker cannot reword an entry that is not its own.
  function attach(id, body, by, { worker = false } = {}) {
    if (!object(body)) throw new Error('a JSON object is needed');
    const entries = loadKnown(), entry = entries.find((e) => e.id === id);
    if (!entry) throw Object.assign(new Error('No known entry has this id'), { status: 404 });
    if (worker && (body.reason !== undefined || body.standing !== undefined) && !(entry.worker && entry.by === by))
      throw Object.assign(new Error('The worker changes the reason and keeping only of entries it filed'), { status: 403 });
    let add = [];
    if (body.incident !== undefined) { const from = patternsOf(str(body.incident), body.wide === true); add = [...from.match, ...from.covers]; }
    else if (body.covers !== undefined) add = patterns(body.covers, 1);
    const have = new Set(entry.covers.map((p) => JSON.stringify(p)));
    entry.covers = [...entry.covers, ...add.filter((p) => !have.has(JSON.stringify(p)))];
    if (entry.covers.length > MAX_PATTERNS) throw new Error('This entry covers too much; file a new one');
    if (body.reason !== undefined) entry.reason = reasonOf(body.reason);
    if (body.standing !== undefined) entry.standing = body.standing === true;
    Object.assign(entry, { changedBy: str(by).slice(0, 39), changedAt: iso(clock()) });
    roomFor(entries);
    saveKnown(entries);
    log({ event: 'triage-known-changed', entry: id, by: entry.changedBy, covers: entry.covers.length, at: entry.changedAt });
    refresh(); changed();
    return entry;
  }
  function remove(id, by) {
    const entries = loadKnown();
    if (!entries.some((e) => e.id === id)) throw Object.assign(new Error('No known entry has this id'), { status: 404 });
    saveKnown(entries.filter((e) => e.id !== id));
    log({ event: 'triage-known-removed', entry: id, by: str(by).slice(0, 39), at: iso(clock()) });
    refresh(); changed();
  }

  // What the worker did about an incident. The Slack thread and the worker's
  // own thread are kept once given, so a later report need not repeat them.
  function report(id, body, by) {
    if (!object(body)) throw new Error('a JSON object is needed');
    if (!STATES.includes(body.state)) throw new Error(`state is one of ${STATES.join(', ')}`);
    if (body.summary !== undefined && (typeof body.summary !== 'string' || body.summary.length > 2000)) throw new Error('summary is text of at most 2000 characters');
    let slack;
    if (body.slack !== undefined) {
      if (!object(body.slack) || !/^[CDG][A-Z0-9]{6,14}$/.test(body.slack.channel) || !/^\d{6,12}\.\d{1,8}$/.test(body.slack.ts)) throw new Error('slack is a channel id and a message ts');
      slack = { channel: body.slack.channel, ts: body.slack.ts };
    }
    if (body.thread !== undefined && (typeof body.thread !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.thread))) throw new Error('thread is an id');
    const episode = openEpisode(id), now = clock();
    const read = body.revision === undefined ? episode.revision : body.revision;
    if (!Number.isSafeInteger(read) || read < 1 || read > episode.revision) throw new Error('revision is the one the incident was read at');
    const triage = loadTriage(), e = triage.episodes.find((x) => x.id === id), old = e.ledger;
    // A report that arrives late does not take back what a later one covered.
    const revision = Math.max(read, old?.revision ?? 0);
    e.ledger = { state: body.state, revision, summary: body.summary ?? old?.summary ?? '', slack: slack ?? old?.slack ?? null, thread: body.thread ?? old?.thread ?? null,
      by: str(by).slice(0, 39), at: iso(now), since: old?.state === body.state ? old.since || old.at : iso(now) };
    // Still unattended when the incident moved on after it was read; the wake
    // for that has been sent, so the list of those woken for stays as it is.
    triage.woken = [...new Set([...triage.woken, ...unattended(triage.episodes)])].slice(-MAX_OPEN);
    saveTriage(triage);
    log({ event: 'triage-report', incident: id, state: body.state, revision, by: e.ledger.by, at: e.ledger.at });
    refresh(); changed();
    // `revision`: where the incident is now. Higher than the ledger's: look again.
    return { ledger: e.ledger, revision: e.revision };
  }

  // Worker tokens, as digests: this host can check one and cannot use one.
  //   { "schemaVersion": 1, "workers": { "<id>": "<sha256 of its token, hex>" } }
  let cache = { key: null, workers: [] };
  const workers = () => {
    if (!workersFile) return [];
    let key;
    try { const st = statSync(workersFile); key = `${st.mtimeMs}|${st.size}|${st.ino}`; } catch { key = 'absent'; }
    if (key === cache.key) return cache.workers;
    let list = [];
    if (key !== 'absent') {
      try {
        const doc = JSON.parse(readFileSync(workersFile, 'utf8'));
        if (doc?.schemaVersion !== 1 || !object(doc.workers)) throw new Error('schemaVersion 1 and a workers object are required');
        list = Object.entries(doc.workers).map(([id, digest]) => {
          if (!/^[a-z][a-z0-9-]{0,38}$/.test(id) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('workers map an id to the sha256 of its token');
          return { id, digest: Buffer.from(digest, 'hex') };
        });
      } catch (e) { list = []; log({ event: 'triage-workers-invalid', error: String(e.message).slice(0, 200), at: iso(clock()) }); }
    }
    cache = { key, workers: list };
    return list;
  };
  // Who a bearer token belongs to, or null. No early exit.
  function workerOf(authorization) {
    const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization || '')?.[1];
    const digest = createHash('sha256').update(token || '').digest();
    let found = null;
    for (const w of workers()) if (timingSafeEqual(w.digest, digest) && token) found = w.id;
    if (found) workerSeenAt = clock();
    return found;
  }

  return { refresh, view, file, attach, remove, report, workerOf };
}
