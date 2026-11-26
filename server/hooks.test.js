import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHooks, parseHooks, MAX_BODY } from './hooks.js';
import { createWeb } from './web.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

const SECRET = 'fixture-hook-secret-0123456789';
const TOKEN = 'fixture-listener-token-0123456789abcdef';
const digest = (token) => createHash('sha256').update(token).digest('hex');
const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const DELIVERY = '5d2b6b10-cb1c-11f0-9d5f-0123456789ab';

function fixture(hook = {}, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hooks-'));
  const dir = join(root, 'config'), dataDir = join(root, 'data');
  mkdirSync(dir); mkdirSync(dataDir);
  const write = (doc) => writeFileSync(join(dir, 'hooks.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
  write({ schemaVersion: 1, hooks: { directory: { source: 'github', listeners: { worker: digest(TOKEN) }, ...hook } } });
  writeFileSync(join(dir, 'directory.secret'), SECRET + '\n');
  const logged = [];
  const hooks = createHooks({ dir, dataDir, waitMs: 60, log: (e) => logged.push(e), ...options });
  const deliver = (body = '{"zen":"x"}', headers = {}) => hooks.receive('directory', { signature: sign(body), event: 'pull_request', delivery: DELIVERY, ...headers }, Readable.from([Buffer.from(body)]));
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
    assert.equal((await f.hooks.receive('other', { signature: sign('{}'), event: 'push', delivery: DELIVERY }, Readable.from([Buffer.from('{}')]))).status, 404);
    assert.equal((await f.hooks.receive('../directory', { signature: sign('{}'), event: 'push', delivery: DELIVERY }, Readable.from([Buffer.from('{}')]))).status, 404);
    assert.equal((await f.wait()).body.seq, 1, 'one wake: the delivery that was signed');
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
    assert.equal((await f.hooks.receive('directory', { signature: sign('x'), event: 'push', delivery: DELIVERY }, body)).status, 413);
    assert.equal((await f.wait()).body.seq, 0);
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

test('no more than eight listeners are held on one hook', async () => {
  const f = fixture({}, { waitMs: 60_000 });
  try {
    const held = Array.from({ length: 8 }, () => f.wait('0'));
    await new Promise((r) => setImmediate(r));
    assert.equal((await f.wait('0')).status, 429);
    await f.deliver();
    assert.deepEqual((await Promise.all(held)).map((r) => r.body.seq), Array(8).fill(1));
  } finally { f.done(); }
});

test('the configuration is read again when it changes; a damaged file configures nothing', async () => {
  const f = fixture();
  try {
    assert.equal((await f.deliver()).status, 202);
    await new Promise((r) => setTimeout(r, 20));
    f.write('{ not json');
    assert.equal((await f.deliver()).status, 404);
    assert.equal((await f.wait()).status, 401);
    assert.equal(f.logged.filter((e) => e.event === 'hooks-config-invalid').length, 1, 'said once, not on every request');
    await new Promise((r) => setTimeout(r, 20));
    f.write({ schemaVersion: 1, hooks: { directory: { source: 'github', listeners: { worker: digest(TOKEN) } }, second: { source: 'github', listeners: {} } } });
    assert.equal((await f.deliver()).body.seq, 2);
    assert.deepEqual(f.hooks.list().map((h) => [h.name, h.signed, h.seq]), [['directory', true, 2], ['second', false, 0]]);
    // A hook without its secret file takes no delivery.
    assert.equal((await f.hooks.receive('second', { signature: sign('{}'), event: 'push', delivery: DELIVERY }, Readable.from([Buffer.from('{}')]))).status, 404);
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

test('hooks.json is checked strictly', () => {
  const ok = { schemaVersion: 1, hooks: { a: { source: 'github', listeners: { l: digest('x') } } } };
  assert.equal(parseHooks(ok).get('a').listeners[0].id, 'l');
  for (const bad of [null, {}, { schemaVersion: 2, hooks: {} }, { schemaVersion: 1, hooks: [] },
    { schemaVersion: 1, hooks: { 'A b': ok.hooks.a } }, { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, source: 'other' } } },
    { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, events: [] } } }, { schemaVersion: 1, hooks: { a: { ...ok.hooks.a, events: ['Push!'] } } },
    { schemaVersion: 1, hooks: { a: { source: 'github' } } }, { schemaVersion: 1, hooks: { a: { source: 'github', listeners: { l: 'plain-token' } } } }]) {
    assert.throws(() => parseHooks(bad), /hooks\.json/);
  }
});

test('over HTTP: a delivery reaches a listener holding a request, before any body parser or API token', async () => {
  const f = fixture();
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
    assert.equal((await fetch(`${base}/api/hooks`)).status, 403, 'the list is for admins');
    assert.equal((await fetch(`${base}/api/hooks/unknown`, { method: 'POST', body: '{}' })).status, 404);
  } finally { app.close(); server.close(); f.done(); }
});
