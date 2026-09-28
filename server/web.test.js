import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeb } from './web.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

async function start(userId = 9920871, extraUsers = []) {
  const dataDir = mkdtempSync(join(tmpdir(), 'web-'));
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  writeFileSync(join(dataDir, 'state', 'testnet.json'), JSON.stringify({ generatedAt: new Date().toISOString(), hosts: [
    { name: 'seed-2', role: 'seed', state: 'running', publicIp: '192.0.2.2', instanceId: 'i-0eb19958115adb5d0', probe: { ok: true, at: new Date().toISOString(), data: { core: { chain: 'test', blocks: 10 }, containers: [] } } },
  ] }));
  if (extraUsers.length) writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...structuredClone(DEFAULT_SETTINGS), operators: [...DEFAULT_SETTINGS.operators, ...extraUsers] }));
  const github = async (url) => url.includes('access_token') ? Response.json({ access_token: 't' })
    : url.includes('/users/octocat') ? Response.json({ id: 583231, login: 'octocat', name: 'The Octocat', type: 'User', avatar_url: 'https://avatars.githubusercontent.com/u/583231' })
      : url.includes('/users/') ? new Response('{}', { status: 404 }) : Response.json({ id: userId, login: 'someone' });
  const origin = 'http://127.0.0.1';
  const app = createWeb({ dataDir, origin, auth: { clientId: 'c', clientSecret: 's', fetcher: github }, fetcher: github });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (path, opts = {}) => {
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie, origin, ...(opts.headers || {}) } });
    for (const c of r.headers.getSetCookie()) cookie = [cookie, c.split(';')[0]].filter(Boolean).join('; ');
    return r;
  };
  const login = async () => {
    const r = await req('/api/auth/github');
    const state = new URL(r.headers.get('location')).searchParams.get('state');
    await req(`/api/auth/callback?state=${state}&code=x`);
    return (await (await req('/api/session')).json()).csrf;
  };
  return { dataDir, req, login, cookie: () => cookie, close: () => { app.close(); server.close(); } };
}

test('public board needs no session and hides operator fields', async () => {
  const w = await start();
  try {
    const overview = await (await w.req('/api/overview')).json();
    assert.deepEqual(overview.networks.map((n) => n.name), ['testnet', 'devnet-moutai']);
    const n = await (await w.req('/api/networks/testnet')).json();
    assert.equal(n.hosts[0].name, 'seed-2');
    assert.equal(n.hosts[0].instanceId, undefined);
    assert.equal((await w.req('/api/networks/testnet/ops')).status, 401);
  } finally { w.close(); }
});

test('operator sign-in queues a validated deployment request; CSRF and non-operators are refused', async () => {
  const w = await start();
  try {
    const csrf = await w.login();
    const n = await (await w.req('/api/networks/testnet')).json();
    assert.equal(n.hosts[0].instanceId, 'i-0eb19958115adb5d0');
    const body = JSON.stringify({ action: 'upgrade', nodes: ['seed-2'], components: ['tenderdash'], images: { tenderdash: 'dashpay/tenderdash:1.8.2' } });
    assert.equal((await w.req('/api/networks/testnet/ops', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 403);
    const bad = await w.req('/api/networks/testnet/ops', { method: 'POST', body: JSON.stringify({ action: 'upgrade', nodes: ['seed-2'], components: ['tenderdash'], images: { tenderdash: 'evil/x:1' } }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(bad.status, 400);
    const ok = await w.req('/api/networks/testnet/ops', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(ok.status, 202);
    const { id } = await ok.json();
    const files = readdirSync(join(w.dataDir, 'requests'));
    assert.deepEqual(files, [`${id}.json`]);
    const q = JSON.parse(readFileSync(join(w.dataDir, 'requests', files[0]), 'utf8'));
    assert.equal(q.type, 'create');
    assert.deepEqual(q.actor, { id: 9920871, login: 'someone' });
    // Settings are editable by full-access operators and validated server-side.
    const { settings } = await (await w.req('/api/settings')).json();
    settings.pollSeconds = 20;
    const saved = await w.req('/api/settings', { method: 'PUT', body: JSON.stringify({ settings }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(saved.status, 200);
    settings.operators = [{ id: 1, login: 'x', networks: ['*'] }];
    const lockout = await w.req('/api/settings', { method: 'PUT', body: JSON.stringify({ settings }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(lockout.status, 400);
  } finally { w.close(); }
});

test('signed-in non-operators get the public view only', async () => {
  const w = await start(42);
  try {
    await w.login();
    assert.equal((await w.req('/api/networks/testnet/ops')).status, 403);
    assert.equal((await w.req('/api/settings')).status, 403);
  } finally { w.close(); }
});

test('viewers read granted networks and operations but cannot deploy; admins look up GitHub users', async () => {
  const w = await start(77, [{ id: 77, login: 'viewer', role: 'viewer', networks: ['testnet'] }]);
  try {
    const csrf = await w.login();
    assert.equal((await w.req('/api/networks/testnet/ops')).status, 200);
    const n = await (await w.req('/api/networks/testnet')).json();
    assert.equal(n.hosts[0].instanceId, 'i-0eb19958115adb5d0');
    const post = await w.req('/api/networks/testnet/ops', { method: 'POST', body: JSON.stringify({ action: 'doctor', nodes: ['seed-2'] }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(post.status, 403);
    assert.equal((await w.req('/api/github/users/octocat')).status, 403);
    const me = await (await w.req('/api/me')).json();
    assert.equal(me.role, 'viewer');
    assert.deepEqual(me.operatorOf, []);
  } finally { w.close(); }
  const a = await start();
  try {
    await a.login();
    const u = await (await a.req('/api/github/users/octocat')).json();
    assert.deepEqual([u.id, u.login], [583231, 'octocat']);
    assert.equal((await a.req('/api/github/users/nobody-here')).status, 404);
    assert.equal((await a.req('/api/github/users/bad..name')).status, 400);
  } finally { a.close(); }
});

test('sessions survive a web restart', async () => {
  const w = await start();
  let cookie;
  try {
    await w.login();
    const r = await w.req('/api/me');
    assert.equal((await r.json()).role, 'admin');
    cookie = w.cookie();
  } finally { w.close(); }
  await new Promise((r) => setTimeout(r, 300));
  const again = createWeb({ dataDir: w.dataDir, origin: 'http://127.0.0.1', auth: { clientId: 'c', clientSecret: 's' } });
  const server = await new Promise((r) => { const s = again.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const me = await (await fetch(`http://127.0.0.1:${server.address().port}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.role, 'admin');
  } finally { again.close(); server.close(); }
});

test('operation ids are validated before touching the filesystem', async () => {
  const w = await start();
  try {
    await w.login();
    assert.equal((await w.req('/api/ops/..%2Fstate%2Ftestnet')).status, 404);
    assert.equal((await w.req('/api/ops/not-a-uuid/log')).status, 404);
  } finally { w.close(); }
});

test('network operators cannot confirm, cancel or resume lifecycle operations', async () => {
  const w = await start(88, [{ id: 88, login: 'op', role: 'operator', networks: ['testnet'] }]);
  try {
    const csrf = await w.login();
    const id = '0b6f3a52-6d0e-4a36-9d7e-6f1c2b3a4d5e';
    mkdirSync(join(w.dataDir, 'ops'), { recursive: true });
    writeFileSync(join(w.dataDir, 'ops', `${id}.json`), JSON.stringify({ id, network: 'testnet', status: 'review', request: { action: 'platform-reset' }, review: { planId: 'p1' }, steps: [] }));
    for (const type of ['confirm', 'cancel', 'resume']) {
      const r = await w.req(`/api/ops/${id}/${type}`, { method: 'POST', body: JSON.stringify({ planId: 'p1' }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
      assert.equal(r.status, 403, type);
    }
    assert.ok(!readdirSync(join(w.dataDir, 'requests')).length, 'no request reaches the agent');
  } finally { w.close(); }
});

test('faucet promo codes reach network members only', async () => {
  const w = await start(77, [{ id: 77, login: 'viewer', role: 'viewer', networks: ['devnet-bonsai'] }]);
  try {
    writeFileSync(join(w.dataDir, 'devnets.json'), JSON.stringify({ 'devnet-bonsai': { status: 'ready', coreNetwork: 'bonsai-g1', promoCodes: { 'EVONODE-ABCD1234': 4005 } } }));
    assert.equal((await w.req('/api/networks/devnet-bonsai/faucet-codes')).status, 401);
    const pub = JSON.stringify(await (await w.req('/api/overview')).json()) + JSON.stringify(await (await w.req('/api/networks/devnet-bonsai')).json());
    assert.ok(!pub.includes('EVONODE-ABCD1234'), 'codes never in public views');
    await w.login();
    assert.deepEqual((await (await w.req('/api/networks/devnet-bonsai/faucet-codes')).json()).codes, { 'EVONODE-ABCD1234': 4005 });
    assert.equal((await w.req('/api/networks/testnet/faucet-codes')).status, 403);
  } finally { w.close(); }
});

test('access changes save at once and survive a reload; admins cannot lock themselves out', async () => {
  const w = await start();
  try {
    const csrf = await w.login();
    const put = (id, body) => w.req(`/api/access/${id}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal((await put(583231, { login: 'octocat', role: 'admin' })).status, 200);
    const onDisk = JSON.parse(readFileSync(join(w.dataDir, 'settings.json'), 'utf8'));
    assert.deepEqual(onDisk.operators.find((o) => o.id === 583231), { id: 583231, login: 'octocat', role: 'admin', networks: ['*'] });
    assert.ok((await (await w.req('/api/settings')).json()).settings.operators.some((o) => o.id === 583231), 'visible after reload');
    assert.equal((await put(583231, { login: 'octocat', role: 'viewer', networks: ['testnet'] })).status, 200);
    assert.equal((await put(9920871, { login: 'someone', role: 'viewer', networks: ['testnet'] })).status, 400, 'own access is not changeable');
    assert.equal((await w.req('/api/access/583231', { method: 'DELETE', headers: { 'x-csrf-token': csrf } })).status, 200);
    assert.ok(!JSON.parse(readFileSync(join(w.dataDir, 'settings.json'), 'utf8')).operators.some((o) => o.id === 583231));
    assert.equal((await w.req('/api/access/583231', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' } })).status, 403, 'CSRF required');
  } finally { w.close(); }
});
