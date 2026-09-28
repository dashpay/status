import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeb } from './web.js';

async function start(userId = 9920871) {
  const dataDir = mkdtempSync(join(tmpdir(), 'web-'));
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  writeFileSync(join(dataDir, 'state', 'testnet.json'), JSON.stringify({ generatedAt: new Date().toISOString(), hosts: [
    { name: 'seed-2', role: 'seed', state: 'running', publicIp: '192.0.2.2', instanceId: 'i-0eb19958115adb5d0', probe: { ok: true, at: new Date().toISOString(), data: { core: { chain: 'test', blocks: 10 }, containers: [] } } },
  ] }));
  const github = async (url) => url.includes('access_token') ? Response.json({ access_token: 't' }) : Response.json({ id: userId, login: 'someone' });
  const origin = 'http://127.0.0.1';
  const app = createWeb({ dataDir, origin, auth: { clientId: 'c', clientSecret: 's', fetcher: github } });
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
  return { dataDir, req, login, close: () => { app.close(); server.close(); } };
}

test('public board needs no session and hides operator fields', async () => {
  const w = await start();
  try {
    const overview = await (await w.req('/api/overview')).json();
    assert.deepEqual(overview.networks.map((n) => n.name), ['testnet', 'devnet-moutai', 'mainnet']);
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
