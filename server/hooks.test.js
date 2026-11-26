import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHooks, matches, parseHooks, LISTENER_AWAY_MS, MAX_BODY, MAX_WAITS_PER_LISTENER } from './hooks.js';
import { createWeb } from './web.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

const SECRET = 'fixture-hook-secret-0123456789';
const TOKEN = 'fixture-listener-token-0123456789abcdef';
const digest = (token) => createHash('sha256').update(token).digest('hex');
const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const DELIVERY = '5d2b6b10-cb1c-11f0-9d5f-0123456789ab';
// The headers GitHub sends, lower-cased as Node hands them over.
const gh = ({ signature, event, delivery, length } = {}) => Object.fromEntries(Object.entries({ 'x-hub-signature-256': signature, 'x-github-event': event,
  'x-github-delivery': delivery, 'content-length': length }).filter(([, v]) => v !== undefined));

function fixture(hook = {}, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hooks-'));
  const dir = join(root, 'config'), dataDir = join(root, 'data');
  mkdirSync(dir); mkdirSync(dataDir);
  const write = (doc) => writeFileSync(join(dir, 'hooks.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
  write({ schemaVersion: 1, hooks: { directory: { source: 'github', listeners: { worker: digest(TOKEN) }, ...hook } } });
  writeFileSync(join(dir, 'directory.secret'), SECRET + '\n');
  const logged = [];
  const hooks = createHooks({ dir, dataDir, waitMs: 60, log: (e) => logged.push(e), ...options });
  const deliver = (body = '{"zen":"x"}', headers = {}) => hooks.receive('directory', gh({ signature: sign(body), event: 'pull_request', delivery: DELIVERY, ...headers }), Readable.from([Buffer.from(body)]));
  return { root, dir, dataDir, hooks, logged, write, deliver, wait: (after, token = TOKEN, closed) => hooks.wait('directory', `Bearer ${token}`, after, closed), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a signed delivery wakes a waiting listener, and the count survives a restart', async () => {
  const f = fixture();
  try {
    const first = await f.wait();
    assert.deepEqual(first, { status: 200, body: { hook: 'directory', listener: 'worker', seq: 0, at: null, event: null } });
    const held = f.wait('0');
    const accepted = await f.deliver();
    assert.deepEqual(accepted, { status: 202, body: { accepted: true, seq: 1 } });
    const woken = await held;
    assert.equal(woken.body.seq, 1);
    assert.equal(woken.body.event, 'pull_request');
    assert.equal(JSON.parse(readFileSync(join(f.dataDir, 'hooks', 'directory.json'), 'utf8')).seq, 1);
    assert.equal(f.logged.at(-1).event, 'hook-wake');
    assert.equal(f.logged.at(-1).listenersWaiting, 1);
    // A new process reads the count back; a listener that was away sees the difference at once.
    const again = createHooks({ dir: f.dir, dataDir: f.dataDir, waitMs: 60, log: () => {} });
    assert.equal((await again.wait('directory', `Bearer ${TOKEN}`, '0')).body.seq, 1);
  } finally { f.done(); }
});

test('a listener that is up to date is held, then told nothing changed', async () => {
  const f = fixture();
  try {
    const started = Date.now();
    const r = await f.wait('0');
    assert.ok(Date.now() - started >= 50, 'held for the wait');
    assert.equal(r.status, 200);
    assert.equal(r.body.seq, 0);
    // The listener going away ends the wait without an answer being needed.
    const gone = await f.hooks.wait('directory', `Bearer ${TOKEN}`, '0', Promise.resolve());
    assert.equal(gone.body.seq, 0);
    assert.equal(f.hooks.list()[0].listenersWaiting, 0);
  } finally { f.done(); }
});

test('a count the listener holds that this host no longer has is answered at once', async () => {
  const f = fixture({}, { waitMs: 60_000 });
  try {
    assert.equal((await f.wait('7')).body.seq, 0);
  } finally { f.done(); }
});

test('only the signature decides: the payload is never parsed', async () => {
  const f = fixture();
  try {
    assert.equal((await f.deliver('not json at all')).status, 202);
    assert.equal((await f.deliver('{}', { signature: sign('{}', 'another-secret-0123456789') })).status, 401);
    assert.equal((await f.deliver('{}', { signature: sign('{ }') })).status, 401);
    assert.equal((await f.deliver('{}', { signature: undefined })).status, 401);
    assert.equal((await f.deliver('{}', { signature: 'sha256=zz' })).status, 401);
    assert.equal((await f.deliver('{}', { event: 'Pull Request' })).status, 400);
    assert.equal((await f.deliver('{}', { delivery: 'a b' })).status, 400);
    assert.equal((await f.wait()).body.seq, 1, 'one wake: the delivery that was signed');
    // Said in the log for a hook that exists, at most once a minute.
    assert.equal(f.logged.filter((e) => e.event === 'hook-signature-rejected').length, 1);
  } finally { f.done(); }
});

test('a name that is not a hook answers exactly like a wrong signature', async () => {
  const f = fixture();
  try {
    const to = (name, headers = {}) => f.hooks.receive(name, gh({ signature: sign('{}'), event: 'push', delivery: DELIVERY, ...headers }), Readable.from([Buffer.from('{}')]));
    assert.equal((await to('directory')).status, 202, 'the probe itself is a valid delivery');
    const wrong = await to('directory', { signature: sign('{}', 'another-secret-0123456789') });
    assert.deepEqual(wrong, { status: 401, body: { error: 'Invalid signature' } });
    for (const name of ['other', '../directory', 'Directory', '', undefined]) assert.deepEqual(await to(name), wrong, String(name));
    // Nor do the unsigned headers tell them apart: they are looked at only after the signature.
    assert.deepEqual(await to('other', { event: 'Not An Event' }), wrong);
    assert.deepEqual(await to('directory', { signature: sign('x'), event: 'Not An Event' }), wrong);
    assert.equal(f.logged.some((e) => e.hook === 'other'), false, 'a guessed name is never logged');
    assert.equal((await f.wait()).body.seq, 1, 'only the valid probe woke anyone');
  } finally { f.done(); }
});

test('GitHub\'s ping and events outside the list are accepted and wake nobody', async () => {
  const f = fixture({ events: ['pull_request', 'push'] });
  try {
    assert.deepEqual((await f.deliver('{}', { event: 'ping' })).body, { accepted: true, ping: true });
    assert.deepEqual(await f.deliver('{}', { event: 'issue_comment' }), { status: 202, body: { accepted: true, ignored: true } });
    assert.equal((await f.wait()).body.seq, 0);
    assert.equal((await f.deliver('{}', { event: 'push' })).body.seq, 1);
  } finally { f.done(); }
});

test('a delivery over the limit is refused and wakes nobody', async () => {
  const f = fixture();
  try {
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const body = Readable.from(Array.from({ length: MAX_BODY / chunk.length + 1 }, () => chunk));
    assert.equal((await f.hooks.receive('directory', gh({ signature: sign('x'), event: 'push', delivery: DELIVERY }), body)).status, 413);
    // A declared length over the limit is refused before a byte is read, whatever the name.
    const unread = { [Symbol.asyncIterator]() { throw new Error('the body must not be read'); } };
    for (const name of ['directory', 'other']) assert.equal((await f.hooks.receive(name, gh({ signature: sign('x'), event: 'push', delivery: DELIVERY, length: String(MAX_BODY + 1) }), unread)).status, 413);
    assert.equal((await f.wait()).body.seq, 0);
    // Exactly the limit is taken.
    const full = Buffer.alloc(MAX_BODY, 0x62);
    assert.equal((await f.hooks.receive('directory', gh({ signature: sign(full), event: 'push', delivery: DELIVERY, length: String(MAX_BODY) }), Readable.from([full]))).status, 202);
  } finally { f.done(); }
});

test('a listener needs its own token; an unknown hook answers the same', async () => {
  const f = fixture();
  try {
    assert.equal((await f.wait(undefined, 'wrong-listener-token-0123456789abcdef')).status, 401);
    assert.equal((await f.hooks.wait('directory', undefined)).status, 401);
    assert.equal((await f.hooks.wait('directory', `Bearer ${SECRET}`)).status, 401, 'the sender\'s secret is not a listener token');
    assert.deepEqual(await f.hooks.wait('other', `Bearer ${TOKEN}`), await f.hooks.wait('directory', 'Bearer wrong-listener-token-0123456789abcdef'));
    assert.equal((await f.wait('-1')).status, 400);
    assert.equal((await f.wait('1e3')).status, 400);
    assert.equal((await f.wait('')).status, 400);
  } finally { f.done(); }
});

test('one listener holds a few requests at most, and cannot take another listener\'s place', async () => {
  const OTHER = 'second-listener-token-0123456789abcdef';
  const f = fixture({ listeners: { worker: digest(TOKEN), other: digest(OTHER) } }, { waitMs: 60_000 });
  try {
    const held = Array.from({ length: MAX_WAITS_PER_LISTENER }, () => f.wait('0'));
    await new Promise((r) => setImmediate(r));
    assert.equal((await f.wait('0')).status, 429);
    const others = f.wait('0', OTHER);
    await new Promise((r) => setImmediate(r));
    assert.equal(f.hooks.list()[0].listenersWaiting, MAX_WAITS_PER_LISTENER + 1);
    await f.deliver();
    assert.deepEqual((await Promise.all(held)).map((r) => r.body.seq), Array(MAX_WAITS_PER_LISTENER).fill(1));
    assert.equal((await others).body.listener, 'other');
    assert.equal(f.hooks.list()[0].listenersWaiting, 0);
  } finally { f.done(); }
});

test('the configuration is read again when it changes; a damaged file configures nothing', async () => {
  const f = fixture();
  try {
    assert.equal((await f.deliver()).status, 202);
    await new Promise((r) => setTimeout(r, 20));
    f.write('{ not json');
    assert.equal((await f.deliver()).status, 401);
    assert.equal((await f.wait()).status, 401);
    assert.equal(f.logged.filter((e) => e.event === 'hooks-config-invalid').length, 1, 'said once, not on every request');
    await new Promise((r) => setTimeout(r, 20));
    f.write({ schemaVersion: 1, hooks: { directory: { source: 'github', listeners: { worker: digest(TOKEN) } }, second: { source: 'github', listeners: {} } } });
    assert.equal((await f.deliver()).body.seq, 2);
    assert.deepEqual(f.hooks.list().map((h) => [h.name, h.source, h.hasSecret, h.seq]), [['directory', 'github', true, 2], ['second', 'github', false, 0]]);
    // A hook without its secret file takes no delivery, and says so in the log.
    assert.equal((await f.hooks.receive('second', gh({ signature: sign('{}'), event: 'push', delivery: DELIVERY }), Readable.from([Buffer.from('{}')]))).status, 401);
    assert.equal(f.logged.filter((e) => e.event === 'hook-secret-missing' && e.hook === 'second').length, 1);
  } finally { f.done(); }
});

test('a wake that cannot be recorded still wakes', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dataDir, 'hooks'), 'a file where the directory should be');
    const held = f.wait('0');
    assert.equal((await f.deliver()).body.seq, 1);
    assert.equal((await held).body.seq, 1);
    assert.ok(f.logged.some((e) => e.event === 'hook-state-not-saved'));
  } finally { f.done(); }
});

test('the status of a hook: is anyone listening, and what arrived', async () => {
  let now = Date.parse('2026-11-26T12:00:00Z');
  const changed = [];
  const f = fixture({ events: ['pull_request'] }, { clock: () => now, waitMs: 60_000, onChange: (name) => changed.push(name) });
  try {
    const one = () => f.hooks.list()[0];
    // Just started, nobody has asked yet: not a fault for the first two minutes.
    assert.deepEqual([one().level, one().listeners[0].connected, one().listeners[0].lastSeenAt], ['info', false, null]);
    now += LISTENER_AWAY_MS;
    assert.equal(one().level, 'down');
    assert.match(one().reason, /Listener worker is not connected/);
    // A listener that holds a request is connected; one that asked a moment ago is too.
    const held = f.wait('0');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([one().level, one().listeners[0].waiting, one().listenersWaiting], ['ok', 1, 1]);
    await f.deliver();
    await held;
    assert.deepEqual(changed, ['directory']);
    assert.deepEqual([one().level, one().listeners[0].waiting, one().listeners[0].connected], ['ok', 0, true]);
    assert.equal(one().listeners[0].lastSeenAt, '2026-11-26T12:02:00.000Z');
    now += LISTENER_AWAY_MS - 1;
    assert.equal(one().level, 'ok');
    now += 1;
    assert.equal(one().level, 'down', 'two minutes without a request: away');
    await f.wait();
    // What arrived since the start, by outcome.
    now += 1000;
    await f.deliver('{}', { event: 'issues' });
    await f.deliver('{}', { event: 'ping' });
    assert.deepEqual(one().deliveries, { woke: 1, ignored: 2, refused: 0, lastAt: '2026-11-26T12:04:01.000Z', lastRefusedAt: null });
    // The newest delivery refused: worth a look, until a good one arrives or a day passes.
    now += 1000;
    await f.deliver('{}', { signature: sign('other') });
    assert.deepEqual([one().level, one().deliveries.refused], ['warn', 1]);
    await f.wait();
    now += 1000;
    await f.deliver();
    assert.equal(one().level, 'ok');
    assert.deepEqual(f.hooks.summary(), { hooks: 1, ok: 1, warn: 0, down: 0, starting: 0, lastWakeAt: '2026-11-26T12:04:03.000Z', lastDeliveryAt: '2026-11-26T12:04:03.000Z', woke: 2, ignored: 2, refused: 1 });
    // A name that is not a hook counts nothing, however often it is tried.
    await f.hooks.receive('other', gh({ signature: sign('{}'), event: 'push', delivery: DELIVERY }), Readable.from([Buffer.from('{}')]));
    assert.equal(f.hooks.list().length, 1);
    assert.equal(f.hooks.summary().refused, 1);
  } finally { f.done(); }
  // No secret file: down, whatever the listener does.
  const g = fixture({}, { waitMs: 20 });
  try {
    rmSync(join(g.dir, 'directory.secret'));
    await g.wait('0');
    assert.deepEqual([g.hooks.list()[0].level, g.hooks.list()[0].hasSecret], ['down', false]);
    assert.equal(g.hooks.summary().down, 1);
  } finally { g.done(); }
});

test('hooks.json is checked strictly', () => {
  const ok = { schemaVersion: 1, hooks: { a: { source: 'github', listeners: { l: digest('x') } } } };
  assert.equal(parseHooks(ok).get('a').listeners[0].id, 'l');
  for (const bad of [null, {}, { schemaVersion: 2, hooks: {} }, { schemaVersion: 1, hooks: [] },
    { schemaVersion: 1, hooks: { 'A b': ok.hooks.a } }, { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, source: 'other' } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, events: [] } } }, { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, events: ['Push!'] } } },
    { schemaVersion: 1, hooks: { a: { source: 'github' } } }, { schemaVersion: 1, hooks: { a: { source: 'github', listeners: { l: 'plain-token' } } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: [] } } }, { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: { path: 'a', pattern: 'b' } } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: [{ path: 'a..b', pattern: 'x' }] } } }, { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: [{ path: 'a', pattern: '(' }] } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: [{ path: 'a' }] } } }, { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: [{ path: 'a', pattern: 'x', event: 'No' }] } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: [null] } } }, { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: ['a=b'] } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: Array(17).fill({ path: 'a', pattern: 'x' }) } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: [{ path: 'a', pattern: 'x'.repeat(201) }] } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: [{ path: 'a.b.c.d.e.f.g', pattern: 'x' }] } } },
    // A misspelt key is refused, not ignored: it would be a filter that does not apply.
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, matches: [{ path: 'a', pattern: 'x' }] } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: [{ path: 'a', pattern: 'x', events: 'push' }] } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, match: [{ path: 'a', pattern: 'x', flags: 'i' }] } } },
    // A rule's event must be one the hook takes, and events are named the sender's way.
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, events: ['push'], match: [{ path: 'a', pattern: 'x', event: 'release' }] } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, events: ['user.insert'] } } },
    { schemaVersion: 1, hooks: { a: { source: 'xenforo', events: ['user'], listeners: {} } } }]) {
    assert.throws(() => parseHooks(bad), /hooks\.json/);
  }
  assert.equal(parseHooks({ schemaVersion: 1, hooks: { f: { source: 'xenforo', events: ['user.insert', 'xfmg2_media.insert'], listeners: {} } } }).get('f').source, 'xenforo');
});

test('a match rule decides from one field of the payload', () => {
  const rules = parseHooks({ schemaVersion: 1, hooks: { a: { source: 'github', listeners: {}, match: [
    { path: 'workflow_job.labels', pattern: '^release-[0-9]+$' }, { path: 'action', pattern: '^published$', event: 'release' }] } } }).get('a').match;
  assert.equal(matches(rules, 'workflow_job', { workflow_job: { labels: ['self-hosted', 'release-12'] } }), true);
  assert.equal(matches(rules, 'workflow_job', { workflow_job: { labels: ['self-hosted', 'xrelease-12'] } }), false);
  assert.equal(matches(rules, 'workflow_job', { workflow_job: { labels: 'release-12' } }), true, 'a plain value works like a list of one');
  assert.equal(matches(rules, 'release', { action: 'published' }), true);
  assert.equal(matches(rules, 'workflow_job', { action: 'published' }), false, 'a rule with an event applies to that event only');
  for (const payload of [null, 7, 'text', [], {}, { workflow_job: null }, { workflow_job: [] }, { workflow_job: { labels: [{ a: 1 }, null, true] } }]) assert.equal(matches(rules, 'workflow_job', payload), false);
  // A number is tested as written. A value too long to test is no match: cutting it could turn "release-1…-x" into one.
  const id = parseHooks({ schemaVersion: 1, hooks: { a: { source: 'github', listeners: {}, match: [{ path: 'run.id', pattern: '^12$' }] } } }).get('a').match;
  assert.equal(matches(id, 'push', { run: { id: 12 } }), true);
  assert.equal(matches(rules, 'workflow_job', { workflow_job: { labels: [`release-${'1'.repeat(300)}-x`] } }), false);
  assert.equal(matches(rules, 'workflow_job', { workflow_job: { labels: `release-${'1'.repeat(300)}` } }), false);
  // Only the start of a long list is looked at.
  assert.equal(matches(rules, 'workflow_job', { workflow_job: { labels: [...Array(199).fill('x'), 'release-1'] } }), true);
  assert.equal(matches(rules, 'workflow_job', { workflow_job: { labels: [...Array(200).fill('x'), 'release-1'] } }), false);
  // Own properties only.
  const proto = parseHooks({ schemaVersion: 1, hooks: { a: { source: 'github', listeners: {}, match: [{ path: 'constructor.name', pattern: '.' }, { path: 'toString', pattern: '.' }] } } }).get('a').match;
  assert.equal(matches(proto, 'push', {}), false);
});

test('a hook with match rules wakes for a matching payload only, and reads it only from an authentic sender', async () => {
  const f = fixture({ events: ['workflow_job'], match: [{ path: 'workflow_job.labels', pattern: '^platform-release-[0-9]+-[0-9]+-(npm|kotlin)$' }] });
  try {
    const job = (labels) => JSON.stringify({ action: 'queued', workflow_job: { id: 1, labels } });
    const ci = job(['ubuntu-24.04']), release = job(['self-hosted', 'Linux', 'X64', 'platform-release-45879746299-1-kotlin']);
    assert.deepEqual(await f.deliver(ci, { event: 'workflow_job' }), { status: 202, body: { accepted: true, ignored: true } });
    assert.equal((await f.wait()).body.seq, 0);
    assert.deepEqual(await f.deliver(release, { event: 'workflow_job' }), { status: 202, body: { accepted: true, seq: 1 } });
    assert.deepEqual(await f.deliver(release, { event: 'push' }), { status: 202, body: { accepted: true, ignored: true } }, 'the event list still comes first');
    assert.equal((await f.deliver('not json', { event: 'workflow_job' })).status, 400);
    assert.equal((await f.deliver('not json', { event: 'workflow_job', signature: sign('other') })).status, 401, 'never parsed without a valid signature');
    assert.equal((await f.deliver('{}', { event: 'ping' })).body.ping, true);
    assert.equal((await f.wait()).body.seq, 1);
  } finally { f.done(); }
});

test('XenForo presents its secret in a header; content type and action make the event', async () => {
  const f = fixture({ source: 'xenforo', events: ['user.insert', 'user.update', 'post.insert'] });
  try {
    const xf = (headers = {}) => f.hooks.receive('directory', { 'xf-webhook-secret': SECRET, 'xf-content-type': 'user', 'xf-webhook-event': 'insert', 'xf-webhook-id': '3', ...headers },
      Readable.from([Buffer.from('{"content_type":"user","event":"insert","content_id":9,"data":{}}')]));
    assert.deepEqual(await xf(), { status: 202, body: { accepted: true, seq: 1 } });
    assert.equal(f.logged.at(-1).on, 'user.insert');
    assert.equal(f.logged.at(-1).delivery, 'xf-3');
    assert.deepEqual(await xf({ 'xf-content-type': 'thread' }), { status: 202, body: { accepted: true, ignored: true } });
    assert.equal((await xf({ 'xf-webhook-event': 'update' })).body.seq, 2);
    const wrong = await xf({ 'xf-webhook-secret': 'not-the-secret-0123456789abcdef' });
    assert.deepEqual(wrong, { status: 401, body: { error: 'Invalid signature' } });
    assert.deepEqual(await xf({ 'xf-webhook-secret': SECRET.slice(0, -1) }), wrong);
    assert.deepEqual(await xf({ 'xf-webhook-secret': undefined }), wrong);
    assert.deepEqual(await f.hooks.receive('other', { 'xf-webhook-secret': SECRET, 'xf-content-type': 'user', 'xf-webhook-event': 'insert', 'xf-webhook-id': '3' }, Readable.from([Buffer.from('{}')])), wrong);
    // A GitHub signature made with the same secret is not how this hook's sender proves itself, and the other way round.
    assert.deepEqual(await f.deliver('{}'), wrong);
    // Both proofs at once: only this hook's kind counts.
    assert.deepEqual(await xf({ 'x-hub-signature-256': sign('anything'), 'xf-webhook-secret': 'not-the-secret-0123456789abcdef' }), wrong);
    assert.equal((await xf({ 'x-hub-signature-256': sign('anything'), 'xf-webhook-event': 'update' })).status, 202);
    // A header given twice reaches us joined, or as a list: neither is the secret.
    assert.deepEqual(await xf({ 'xf-webhook-secret': `${SECRET}, ${SECRET}` }), wrong);
    assert.deepEqual(await xf({ 'xf-webhook-secret': [SECRET, SECRET] }), wrong);
    assert.equal((await f.wait()).body.seq, 3);
    assert.equal((await xf({ 'xf-webhook-event': 'Insert!' })).status, 400);
    assert.equal((await xf({ 'xf-webhook-id': undefined })).status, 400);
    assert.equal((await f.wait()).body.seq, 3);
  } finally { f.done(); }
  // The secret is 16 to 200 printable ASCII characters, as a header carries them; a file outside that opens nothing.
  for (const [stored, opens] of [['s'.repeat(15), false], ['s'.repeat(16), true], ['s'.repeat(200), true], ['s'.repeat(201), false], [`${'s'.repeat(20)} x`, false], [`${'s'.repeat(20)}ø`, false]]) {
    const h = fixture({ source: 'xenforo' });
    try {
      writeFileSync(join(h.dir, 'directory.secret'), stored);
      const r = await h.hooks.receive('directory', { 'xf-webhook-secret': stored, 'xf-content-type': 'user', 'xf-webhook-event': 'insert', 'xf-webhook-id': '1' }, Readable.from([Buffer.from('{}')]));
      assert.equal(r.status, opens ? 202 : 401, `${stored.length} characters`);
      if (!opens && stored.length >= 16 && stored.length <= 200) assert.ok(h.logged.some((e) => e.event === 'hook-secret-missing'), 'said in the log');
    } finally { h.done(); }
  }
  const g = fixture();
  try {
    assert.equal((await g.hooks.receive('directory', { 'xf-webhook-secret': SECRET, 'xf-content-type': 'user', 'xf-webhook-event': 'insert', 'xf-webhook-id': '3' }, Readable.from([Buffer.from('{}')]))).status, 401,
      'a GitHub hook does not take its secret in a header');
  } finally { g.done(); }
});

test('over HTTP: a delivery reaches a listener holding a request, before any body parser or API token', async () => {
  // A listener token that looks like a console API token still belongs to the hook.
  const LOOKALIKE = `dst_0a1b2c3d_${'A'.repeat(43)}`;
  const f = fixture({ listeners: { worker: digest(TOKEN), lookalike: digest(LOOKALIKE) } });
  writeFileSync(join(f.dataDir, 'settings.json'), JSON.stringify(structuredClone(DEFAULT_SETTINGS)));
  const app = createWeb({ dataDir: f.dataDir, origin: 'http://127.0.0.1', hooksDir: f.dir, hookWaitMs: 5000, auth: { clientId: 'c', clientSecret: 's', fetcher: async () => Response.json({}) } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const listen = (after) => fetch(`${base}/api/hooks/directory/wait${after === undefined ? '' : `?after=${after}`}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const first = await listen();
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal((await first.json()).seq, 0);
    const held = listen(0);
    await new Promise((r) => setTimeout(r, 50));
    const body = JSON.stringify({ action: 'opened', number: 1 });
    const post = (headers) => fetch(`${base}/api/hooks/directory`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': DELIVERY, ...headers } });
    assert.equal((await post({ 'x-hub-signature-256': sign(body + ' ') })).status, 401);
    const accepted = await post({ 'x-hub-signature-256': sign(body) });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true, seq: 1 });
    assert.equal((await (await held).json()).seq, 1);
    assert.equal((await fetch(`${base}/api/hooks/directory/wait?after=1&after=2`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 400);
    assert.equal((await fetch(`${base}/api/hooks/directory/wait`)).status, 401);
    // Without an account: counts, and nothing that names a hook, a listener or an event.
    const open = await (await fetch(`${base}/api/hooks`)).json();
    assert.equal(open.public, true);
    assert.deepEqual(open.hooks, []);
    assert.equal(open.summary.hooks, 1);
    assert.equal(open.summary.woke, 1);
    assert.equal(open.summary.refused, 1);
    assert.equal(/directory|worker|lookalike|pull_request/.test(JSON.stringify(open)), false);
    assert.equal((await (await fetch(`${base}/api/hooks/directory/wait`, { headers: { authorization: `Bearer ${LOOKALIKE}` } })).json()).listener, 'lookalike');
    // A hook that exists and one that does not cannot be told apart from outside.
    const probe = async (name, headers = {}) => { const r = await fetch(`${base}/api/hooks/${name}`, { method: 'POST', body: '{}', headers }); return [r.status, await r.text()]; };
    assert.deepEqual(await probe('unknown'), await probe('directory'));
    assert.deepEqual(await probe('unknown', { 'x-hub-signature-256': sign('x') }), await probe('directory', { 'x-hub-signature-256': sign('x') }));
    assert.equal((await probe('unknown'))[0], 401);
    // A listener that goes away frees its place.
    const gone = new AbortController();
    const left = fetch(`${base}/api/hooks/directory/wait?after=1`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: gone.signal }).catch(() => 'aborted');
    await new Promise((r) => setTimeout(r, 50));
    gone.abort();
    assert.equal(await left, 'aborted');
    await new Promise((r) => setTimeout(r, 50));
    const session = await fetch(`${base}/api/hooks/directory/wait?after=1`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(200) }).catch(() => 'held');
    assert.equal(session, 'held', 'a new request is held, not refused');
  } finally { app.close(); server.close(); f.done(); }
});
