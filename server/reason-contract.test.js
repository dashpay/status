// The evaluator (shared/evaluate.js) says what is wrong; the incident producer
// (server/incidents.js) keys cases on it. These tests tie the two together:
// a reason without a code the producer knows cannot be added unnoticed, and
// the codes give exactly the fault keys the sentences gave before they existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, deriveIssues, reconcile } from './incidents.js';
import { evaluateNetwork, projectNetwork } from '../shared/evaluate.js';
import { expectations } from '../shared/monitoring.js';
import { REASON_CODES, NOTE } from '../shared/reasons.js';
import { reasonSites } from '../shared/fixtures/reason-sites.js';

const now = Date.parse('2026-11-27T12:00:00Z');
const FAULT_LEVELS = ['warn', 'down', 'unreachable'];
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// Every flag() and reason() call of the evaluator, in the order of the source:
// its code, and the sentences the fixtures (shared/fixtures/reason-sites.js)
// must get from it. A new call needs a line here and a fixture that reaches it.
const SITES = [
  ['note', 'instance stopped'],
  ['note', 'service health not observed; EC2 state only'],
  ['probe', 'probe failed: connect ETIMEDOUT 10.0.0.9:22', 'probe failed: no result yet'],
  ['probe', 'host observation is stale'],
  ['core_rpc', 'Core RPC not answering', 'no Dash services running on host'],
  ['core_chain', 'Core on chain "main"'],
  ['core_sync', 'Core initial sync 50%'],
  ['core_lag', 'Core 20 blocks behind tip'],
  ['core_headers', 'Core headers 10 ahead of validated blocks'],
  ['chainlock_age', 'ChainLock older than 30 minutes'],
  ['chainlock_lag', 'ChainLock is behind the Core tip'],
  ['dkg', 'DKG session aborted'],
  ['peers', 'no outbound Core peers'],
  ['mn_sync', 'masternode sync not finished'],
  ['mn_ready', 'masternode status unavailable'],
  ['mn_ready', 'masternode POSE_BANNED'],
  ['pose', 'PoSe penalty 12'],
  ['wallet', 'wallet faucet balance 5', 'wallet Faucet reserve 2 balance 99.5'],
  ['platform_rpc', 'Tenderdash RPC not answering'],
  ['platform_sync', 'Tenderdash catching up'],
  ['platform_lag', 'Platform 30 blocks behind tip'],
  ['dapi', 'DAPI getStatus failed: deadline exceeded', 'DAPI getStatus failed'],
  ['dapi_query', 'DAPI Drive epoch query failed'],
  ['protocol', 'DAPI epoch and consensus protocol disagree'],
  ['chain_ids', 'DAPI and consensus chain IDs disagree'],
  ['consensus_round', 'consensus round 7'],
  ['tls', 'gateway certificate expired', 'gateway certificate expires in 10 h; renewal is not succeeding'],
  ['dapi_public', 'DAPI :443 not reachable from status host (timeout)'],
  ['p2p', 'P2P :19999 not reachable from status host (ECONNREFUSED)'],
  ['container', 'container migrate exited; one-shot completed successfully'],
  ['container', 'container api-old exited (exit 137); superseded by a running x/api container', 'container worker exited (exit 1)', 'container idle exited', 'container fresh created'],
  ['container', 'container sick unhealthy'],
  ['disk', 'disk / 91.3%', 'disk /mnt/data volume 99%'],
  ['memory', 'memory 95%'],
  ['insight', 'Insight syncing at 90', 'Insight unknown at 100'],
  ['insight_query', 'Insight block/transaction/address query failed'],
  ['faucet_queue', 'legacy faucet queue unavailable'],
  ['faucet_wait', 'legacy faucet has requests queued over one hour'],
  ['coinjoin', 'CoinJoin is enabled but not running'],
  ['service', 'prometheus functional health check failed'],
  ['note', 'grafana health not observed (authentication required)', 'elasticsearch health not observed (unavailable)'],
  ['scrapes', 'alertmanager has 2 failing scrape targets'],
  ['core_progress', 'Core height unchanged through 30 minutes of continuous observation'],
  ['platform_progress', 'Platform height unchanged through 30 minutes of continuous observation'],
  ['note', '2 container restart/replacement(s) since previous sample'],
  ['faucet_balance', 'faucet balance 3 below payout reserve'],
  ['faucet_http', 'faucet /api/status HTTP 503'],
  ['faucet_http', 'faucet HTTP 502'],
  ['quorums', 'quorum server /health HTTP 503'],
  ['quorums', 'quorum server lists no quorums'],
  ['explorer_api', 'explorer API /status HTTP 500'],
  ['explorer_runtime', 'explorer indexer restarting'],
  ['explorer_runtime', 'explorer indexer not running'],
  ['explorer_runtime', 'explorer indexer unhealthy'],
  ['explorer_runtime', 'explorer indexer health check starting'],
  ['explorer_heights', 'explorer indexing heights unavailable'],
  ['explorer_heights', 'explorer indexed height exceeds its chain height'],
  ['explorer_lag', 'explorer indexer 30 blocks behind'],
  ['mainnet', 'mainnet ChainLock unavailable'],
  ['mainnet', 'mainnet ChainLock is 2000s old'],
  ['mainnet', 'mainnet observer Platform is catching up; live chain status not yet known'],
  ['mainnet', 'mainnet PoSe census unavailable'],
  ['mainnet', 'mainnet ChainLock age unavailable'],
  ['mainnet', 'mainnet Core chain stalled'],
  ['mainnet', 'mainnet Platform chain stalled'],
  ['mainnet', 'mainnet Platform height unavailable'],
  ['mainnet', 'mainnet quorum list HTTP unavailable', 'mainnet quorum list HTTP 502'],
  ['mainnet', 'mainnet newly PoSe-banned masternodes 25 in one hour'],
  ['images', 'running images differ from the last confirmed deployment target'],
  ['note', 'image rollout in progress'],
  ['note', 'devnet creating; services start as the creation operation reaches them'],
  ['mainnet', 'mainnet observer report is stale'],
];

// What server/incidents.js did until the reasons carried codes: it read the
// sentence. Kept here, and only here, as the record of which fault key each
// sentence had, so that the codes can be shown to give the same keys. A
// sentence reworded on purpose fails against it by design; the key is what
// must not move, so reword the pattern here along with the sentence.
const faultKey = (rule, subject = '') => JSON.stringify([rule, subject]);
function bySentence(text) {
  const subjects = [
    [/^disk (.+) [\d.]+%$/, 'disk'], [/^wallet (.+) balance /, 'wallet'],
    [/^container (\S+) /, 'container'], [/^P2P :(\d+) /, 'p2p'],
    [/^(.+) functional health check failed$/, 'service'], [/^(.+) has \d+ failing scrape targets$/, 'scrapes'],
  ];
  for (const [pattern, rule] of subjects) { const match = pattern.exec(text); if (match) return faultKey(rule, match[1]); }
  const rules = [
    [/^(probe failed:|host observation is stale)/, 'probe'],
    [/^(Core RPC not answering|no Dash services running)/, 'core_rpc'], [/^Core on chain /, 'core_chain'],
    [/^Core initial sync /, 'core_sync'], [/^Core \d+ blocks behind/, 'core_lag'], [/^Core headers /, 'core_headers'],
    [/^ChainLock older/, 'chainlock_age'], [/^ChainLock is behind/, 'chainlock_lag'], [/^DKG session/, 'dkg'],
    [/^no outbound Core peers/, 'peers'], [/^masternode sync/, 'mn_sync'], [/^masternode /, 'mn_ready'], [/^PoSe penalty/, 'pose'],
    [/^Tenderdash RPC/, 'platform_rpc'], [/^Tenderdash catching/, 'platform_sync'], [/^Platform \d+ blocks behind/, 'platform_lag'],
    [/^DAPI getStatus/, 'dapi'], [/^DAPI Drive epoch/, 'dapi_query'], [/^DAPI epoch and consensus protocol/, 'protocol'],
    [/^DAPI and consensus chain/, 'chain_ids'], [/^DAPI :443/, 'dapi_public'], [/^gateway certificate/, 'tls'],
    [/^consensus round /, 'consensus_round'], [/^memory /, 'memory'], [/^Insight block\/transaction/, 'insight_query'], [/^Insight /, 'insight'],
    [/^legacy faucet queue unavailable/, 'faucet_queue'], [/^legacy faucet has requests queued/, 'faucet_wait'], [/^CoinJoin /, 'coinjoin'],
    [/^Core height unchanged/, 'core_progress'], [/^Platform height unchanged/, 'platform_progress'],
    [/^faucet balance /, 'faucet_balance'], [/^faucet /, 'faucet_http'],
    [/^quorum server /, 'quorums'], [/^explorer API /, 'explorer_api'], [/^explorer indexer (not running|restarting|unhealthy|health check)/, 'explorer_runtime'],
    [/^explorer (indexing heights|indexed height)/, 'explorer_heights'], [/^explorer indexer \d+ blocks behind/, 'explorer_lag'],
    [/^mainnet /, 'mainnet'], [/^running images differ/, 'images'],
  ];
  for (const [pattern, rule] of rules) if (pattern.test(text)) return faultKey(rule);
  return faultKey('unclassified', text.slice(0, 300));
}

// The fixtures as the board evaluates them (`web`) and as the incident
// producer does (no lifecycle: a devnet being built is still looked at).
const fixtures = reasonSites(now);
const evaluate = (n, web) => evaluateNetwork(web ? n : { ...n, lifecycle: undefined }, fixtures.states[n.name], fixtures.settings, now, {},
  expectations(fixtures.operations.filter((op) => op.network === n.name), now));
const rowsOf = (web) => fixtures.settings.networks.flatMap((n) => evaluate(n, web).rows.map((row) => ({ network: n.name, ...row })));
const produced = rowsOf(true).flatMap((row) => row.reasons);

test('every flag() and reason() call of the evaluator names a code the incident producer knows', () => {
  const source = read('../shared/evaluate.js');
  const calls = source.match(/\b(?:flag|reason)\(/g), coded = [...source.matchAll(/\b(?:flag|reason)\('([a-z0-9_]+)', /g)].map((m) => m[1]);
  // flag() hands its arguments to reason(): the one call without a literal code.
  assert.equal(source.split('reason(...fact)').length, 2);
  assert.equal(calls.length, coded.length + 1, 'a flag() or reason() call does not start with a literal code');
  for (const code of coded) assert.ok(code === NOTE || Object.hasOwn(REASON_CODES, code), `${code} is not in shared/reasons.js`);
  // No reason is put on a host any other way.
  const added = source.match(/reasons\.(?:push|unshift|splice)\((?:reason\(')?/g);
  assert.deepEqual(added.filter((a) => !a.endsWith("reason('")), ['reasons.push('], 'a reason is added without reason()');
  assert.ok(source.includes('reasons.push(r);'));
  assert.deepEqual(coded, SITES.map(([code]) => code), 'SITES lists the calls of shared/evaluate.js in order: add the new call, and a fixture that reaches it');
  // The proofs of recovery are keyed by the same names.
  for (const [, rule] of read('./incidents.js').matchAll(/\bprove\('([a-z0-9_]+)'/g)) assert.ok(Object.hasOwn(REASON_CODES, rule), `proof of ${rule} matches no reason code`);
});

test('the fixtures reach every call, and each reason says what it is about', () => {
  for (const r of produced) {
    assert.ok(r.code === NOTE || Object.hasOwn(REASON_CODES, r.code), `no known code: ${r.text}`);
    const subject = Object.hasOwn(REASON_CODES, r.code) && REASON_CODES[r.code] !== null;
    assert.deepEqual(Object.keys(r), subject ? ['level', 'text', 'code', 'subject'] : ['level', 'text', 'code'], r.text);
    if (subject) assert.equal(typeof r.subject, 'string', r.text);
    // A note is never a fault: what counts against a host has a rule.
    if (FAULT_LEVELS.includes(r.level)) assert.notEqual(r.code, NOTE, r.text);
  }
  const seen = new Set(produced.map((r) => JSON.stringify([r.code, r.text])));
  const listed = new Set(SITES.flatMap(([code, ...sentences]) => sentences.map((s) => JSON.stringify([code, s]))));
  for (const [code, ...sentences] of SITES) assert.ok(sentences.length, `${code}: no sentence listed`);
  assert.deepEqual([...listed].filter((s) => !seen.has(s)), [], 'listed in SITES, not produced by the fixtures');
  assert.deepEqual([...seen].filter((s) => !listed.has(s)), [], 'produced by the fixtures, not listed in SITES');
  assert.deepEqual(Object.keys(REASON_CODES).filter((code) => !produced.some((r) => r.code === code)), [], 'codes no fixture produces');
});

test('each code gives the fault key its sentence gave before', () => {
  for (const r of produced) assert.equal(classify(r), bySentence(r.text), r.text);
  // Data that is not a coded reason keeps the old answer for a fact nobody recognises.
  for (const odd of [{ level: 'warn', text: 'something new' }, { level: 'warn', text: 'disk / 91%', code: 'no_such_code', subject: '/' }, 'something new'])
    assert.equal(classify(odd), faultKey('unclassified', odd.text || odd));
  assert.equal(classify({ text: 'x'.repeat(400) }), faultKey('unclassified', 'x'.repeat(300)));
});

test('the incident producer files the faults it filed before', () => {
  const derived = deriveIssues({ ...fixtures, now });
  const issues = derived.issues.filter((i) => i.code === 'host_health');
  const faulty = rowsOf(false).filter((row) => FAULT_LEVELS.includes(row.level) && derived.sources[`network:${row.network}`].fresh);
  assert.deepEqual(issues.map((i) => `${i.scope}/${i.target}`), faulty.map((row) => `${row.network}/${row.host.name}`));
  assert.equal(issues.length, 23);
  for (const [n, issue] of issues.entries()) {
    // The evidence as it was built from sentences alone.
    const reasons = faulty[n].reasons.filter((r) => FAULT_LEVELS.includes(r.level));
    const faults = [...new Set(reasons.map((r) => bySentence(r.text)))].sort();
    const faultLevels = Object.fromEntries(faults.map((f) => [f, reasons.some((r) => bySentence(r.text) === f && r.level !== 'warn') ? 'critical' : 'warning']));
    const { reasonFaults, ...evidence } = issue.evidence;
    assert.deepEqual(evidence, { level: faulty[n].level, generation: evidence.generation, instanceId: faulty[n].host.instanceId, faults, faultLevels, reasons: reasons.map((r) => r.text) }, issue.target);
    assert.deepEqual(reasonFaults, reasons.map((r) => bySentence(r.text)), issue.target);
    assert.ok(!faults.some((f) => f.startsWith('["unclassified"')), issue.target);
  }
  // Every rule is among them: none of the codes fell through to "unclassified".
  const keys = new Set(issues.flatMap((i) => i.evidence.faults.map((f) => JSON.parse(f)[0])));
  assert.deepEqual(Object.keys(REASON_CODES).filter((code) => !keys.has(code)), []);
});

test('a fault that is no longer reported keeps its sentence by the key stored beside it', () => {
  const derive = (ms, edit = () => {}) => { const f = reasonSites(ms); edit(f.states.testnet.hosts.find((h) => h.name === 'services-1')); return deriveIssues({ ...f, now: ms }); };
  const down = (h) => { h.probe = { ok: false, at: h.probe.at, error: 'timeout' }; };
  const of = (state) => state.issues.find((i) => i.code === 'host_health' && i.target === 'services-1');
  const first = reconcile(null, derive(now), now), before = of(first).evidence;
  // The host stops answering: nothing proves its faults over, so all stay.
  const next = of(reconcile(structuredClone(first), derive(now + 30_000, down), now + 30_000));
  assert.deepEqual(next.evidence.reasons, ['probe failed: timeout', ...before.reasons]);
  assert.deepEqual(next.evidence.reasonFaults, ['["probe",""]', ...before.reasonFaults]);
  assert.deepEqual(next.evidence.faults, [...before.faults, '["probe",""]'].sort());

  // A case stored by the release before this one has the sentences and the
  // fault keys, not which is which. Its faults, their levels, its severity and
  // its events are the same; the sentences of faults that are no longer
  // reported are dropped, since nothing says which fault each belonged to.
  const old = structuredClone(first);
  for (const i of old.issues) delete i.evidence?.reasonFaults;
  for (const e of old.outbox) delete e.issue.evidence?.reasonFaults;
  const upgraded = reconcile(old, derive(now + 30_000, down), now + 30_000), same = reconcile(structuredClone(first), derive(now + 30_000, down), now + 30_000);
  assert.deepEqual(of(upgraded).evidence, { ...next.evidence, reasons: ['probe failed: timeout'], reasonFaults: ['["probe",""]'] });
  assert.deepEqual([of(upgraded).severity, of(upgraded).revision, of(upgraded).quiet], [next.severity, next.revision, next.quiet]);
  assert.deepEqual(upgraded.outbox.map((e) => [e.eventId, e.transition]), same.outbox.map((e) => [e.eventId, e.transition]));
  assert.deepEqual(upgraded.issues.map((i) => [i.id, i.status, i.severity, i.evidence?.faults]), same.issues.map((i) => [i.id, i.status, i.severity, i.evidence?.faults]));
});

test('the browser gets the level and the sentence of a reason, nothing else', () => {
  for (const n of fixtures.settings.networks) for (const operator of [true, false]) {
    const view = projectNetwork(n, evaluate(n, true), fixtures.states[n.name], operator);
    for (const h of view.hosts) for (const r of h.reasons) assert.deepEqual(Object.keys(r), ['level', 'text'], `${n.name}/${h.name}`);
    assert.ok(!JSON.stringify(view.hosts.map((h) => h.reasons)).includes('"subject"'));
  }
});
