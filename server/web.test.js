import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeb, ttlCache } from './web.js';
import { requestDevnetKeys } from './devnet-keys.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

async function start(userId = 9920871, extraUsers = [], options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'web-'));
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  writeFileSync(join(dataDir, 'state', 'testnet.json'), JSON.stringify({ generatedAt: new Date().toISOString(), hosts: [
    { name: 'seed-2', role: 'seed', state: 'running', publicIp: '192.0.2.2', instanceId: 'i-0eb19958115adb5d0', probe: { ok: true, at: new Date().toISOString(), data: { core: { chain: 'test', blocks: 10 }, containers: [] } } },
  ] }));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...structuredClone(DEFAULT_SETTINGS), operators: [...DEFAULT_SETTINGS.operators, ...extraUsers] }));
  const github = async (url) => url.includes('access_token') ? Response.json({ access_token: 't' })
    : url.includes('/users/octocat') ? Response.json({ id: 583231, login: 'octocat', name: 'The Octocat', type: 'User', avatar_url: 'https://avatars.githubusercontent.com/u/583231' })
      : url.includes('/users/') ? new Response('{}', { status: 404 }) : Response.json({ id: userId, login: 'someone' });
  const origin = 'http://127.0.0.1';
  const app = createWeb({ dataDir, origin, mainnetReportToken: 'fixture-mainnet-token', auth: { clientId: 'c', clientSecret: 's', fetcher: github }, fetcher: github, ...options });
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
  return { dataDir, base, req, login, cookie: () => cookie, close: () => { app.close(); server.close(); } };
}

test('public board needs no session and hides operator fields', async () => {
  const w = await start();
  try {
    const overview = await (await w.req('/api/overview')).json();
    assert.deepEqual(overview.networks.map((n) => n.name), ['testnet', 'mainnet']);
    const n = await (await w.req('/api/networks/testnet')).json();
    assert.equal(n.hosts[0].name, 'seed-2');
    assert.equal(n.hosts[0].instanceId, undefined);
    assert.equal((await w.req('/api/networks/testnet/ops')).status, 401);
  } finally { w.close(); }
});

test('mainnet observer report is token-scoped and appears as limited signals', async () => {
  const w = await start();
  try {
    const body = JSON.stringify({ network: 'mainnet', generatedAt: new Date().toISOString(), probeMs: 42,
      core: { chain: 'main', blocks: 200, headers: 200, chainLockHeight: 200, blockTime: Math.floor(Date.now() / 1000), synced: true },
      platform: { height: 300, blockTime: new Date().toISOString(), network: 'evo1', catchingUp: false },
      quorumServer: { status: 200, latencyMs: 12, quorums: 10, banned: 2, enabled: 100 },
      mainnet: { chainLockAgeSeconds: 4, bigBans: 2, coreStall: false, platformStall: false } });
    assert.equal((await w.req('/api/mainnet/report', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 401);
    const report = await w.req('/api/mainnet/report', { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-mainnet-token' } });
    assert.equal(report.status, 202);
    const mainnet = await (await w.req('/api/networks/mainnet')).json();
    assert.equal(mainnet.summary.mainnet.platformHeight, 300);
    assert.equal(mainnet.summary.mainnet.bigBans, 2);
    assert.equal(mainnet.hosts[0].mainnet.quorumServer.quorums, 10);
    assert.equal(mainnet.hosts[0].instanceId, undefined);
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
    // A page-wide save never changes access (it has its own endpoints), so a
    // stale or edited operator list cannot lock admins out or revert a grant.
    settings.operators = [{ id: 1, login: 'x', networks: ['*'] }];
    const stale = await w.req('/api/settings', { method: 'PUT', body: JSON.stringify({ settings }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(stale.status, 200);
    assert.ok((await stale.json()).settings.operators.some((o) => o.id === 9920871), 'operators kept from disk');
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
    assert.equal(me.allNetworks, false);
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
    const me = await r.json();
    assert.equal(me.role, 'admin');
    assert.equal(me.allNetworks, true, 'wildcard access covers devnets created after the session loaded');
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

test('CI: admins issue reporter tokens; reporters post with them; infrastructure pages need access', async () => {
  const w = await start();
  try {
    // Signed out: the sanitized views.
    assert.equal((await (await w.req('/api/ci')).json()).public, true);
    assert.equal((await w.req('/api/aws')).status, 404, 'no inventory yet');
    const csrf = await w.login();
    const created = await w.req('/api/ci/reporters', { method: 'POST', body: JSON.stringify({ label: 'ubuntu-server-2' }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(created.status, 201);
    const { id, token, url } = await created.json();
    assert.equal(url, 'http://127.0.0.1/api/ci/report');
    const body = JSON.stringify({ v: 1, at: '2026-09-29T12:00:00Z', host: { hostname: 'ubuntu-server-2', cpus: 32, load: [0.2, 0.5, 2.4], disks: [] }, runners: [{ key: 'dash-ci-runner', name: 'ubuntu-server-2', kind: 'docker', listening: true, busy: false }],
      jobs: Array.from({ length: 250 }, (_, i) => ({ runner: 'dash-ci-runner', runnerName: 'ubuntu-server-2', name: `job ${i} ${'x'.repeat(200)}`, start: new Date(Date.now() - i * 60_000).toISOString().replace(/\.\d+Z/, 'Z'), result: 'Succeeded' })) });
    const post = (auth) => w.req('/api/ci/report', { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: auth } });
    assert.equal((await post('Bearer dcr_nope_0000000000000')).status, 401);
    const ok = await post(`Bearer ${token}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { accepted: 250 });
    const huge = JSON.stringify({ v: 1, host: {}, runners: [], pad: 'x'.repeat(1_100_000) });
    assert.equal((await w.req('/api/ci/report', { method: 'POST', body: huge, headers: { 'content-type': 'application/json' } })).status, 401);
    assert.equal((await w.req('/api/ci/report', { method: 'POST', body: huge, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } })).status, 413);
    const s = await (await w.req('/api/ci')).json();
    assert.equal(s.runners[0].name, 'ubuntu-server-2');
    assert.equal(s.reporters[0].id, id);
    assert.equal((await w.req('/api/aws')).status, 404);
    writeFileSync(join(w.dataDir, 'aws', 'inventory.json'), JSON.stringify({ at: 'now', regions: ['us-west-2'], errors: [],
      instances: [{ region: 'us-west-2', id: 'i-0123456789abcdef0', type: 't4g.small', state: 'running', arch: 'arm64', publicIp: '192.0.2.9', tags: { Name: 'dn-testnet-masternode-1', DashNetwork: 'testnet' }, vcpus: 2, memoryMiB: 2048 }],
      volumes: [{ region: 'us-west-2', id: 'vol-1', sizeGiB: 50, type: 'gp3' }], addresses: [{ region: 'us-west-2', publicIp: '192.0.2.9' }], natGateways: [], loadBalancers: [{ region: 'us-west-2', name: 'testnet-alb', type: 'application', dns: 'testnet-alb.elb.amazonaws.com' }],
      lambda: [{ name: 'killdate' }], dynamodb: [], ecr: [{ name: 'rs-dapi', images: 10, bytes: 1e9 }], snapshots: [], cloudfront: [{ aliases: ['quorums.testnet.networks.dash.org'] }], s3: [{ name: 'dash-terraform-state' }],
      costs: { at: 'now', month: '2026-09', monthToDate: 3270.85, monthEndEstimate: 3503.4, lastMonth: 3109.17, byService: [{ service: 'EC2 - Other', amount: 1178.9 }], daily: [] } }));
    assert.equal((await (await w.req('/api/aws')).json()).at, 'now');
    assert.equal((await (await w.req('/api/aws')).json()).instances[0].publicIp, '192.0.2.9', 'members see the inventory');
    assert.equal((await w.req(`/api/ci/reporters/${id}`, { method: 'DELETE', headers: { 'x-csrf-token': csrf } })).status, 200);
    // Signed out: resource breakdowns only; the live board keeps costs private.
    await w.req('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } });
    const pub = await (await w.req('/api/aws')).json();
    assert.equal(pub.public, true);
    assert.deepEqual(pub.byNetwork, [{ label: 'testnet', count: 1, vcpus: 2, memoryGiB: 2 }]);
    assert.equal(pub.costs, undefined);
    const text = JSON.stringify(pub);
    for (const leak of ['192.0.2.9', 'i-0123456789abcdef0', 'dn-testnet-masternode-1', 'testnet-alb', 'elb.amazonaws', 'killdate', 'rs-dapi', 'quorums.testnet', 'dash-terraform-state', 'vol-1'])
      assert.ok(!text.includes(leak), `leaked ${leak}`);
    assert.equal((await post(`Bearer ${token}`)).status, 401);
  } finally { w.close(); }
});

test('console devnet connection files reach members only', async () => {
  const w = await start();
  try {
    const reg = { 'devnet-fixture': { status: 'ready', displayName: 'Fixture', coreNetwork: 'devnet-fixture-g1' } };
    writeFileSync(join(w.dataDir, 'devnets.json'), JSON.stringify(reg));
    mkdirSync(join(w.dataDir, 'devnets', 'devnet-fixture'), { recursive: true });
    writeFileSync(join(w.dataDir, 'devnets', 'devnet-fixture', 'config.json'), JSON.stringify({ name: 'devnet-fixture', displayName: 'Fixture',
      core: { devnet: 'fixture-g1', chain: 'devnet-fixture-g1', port: 20001, blockSeconds: 10, minimumDifficultyBlocks: 1000000, highSubsidyBlocks: 500, highSubsidyFactor: 100,
        llmq: { chainlocks: 'llmq_devnet', instantsendDip0024: 'llmq_devnet_dip0024', platform: 'llmq_devnet_platform', mnhf: 'llmq_devnet' }, sporkAddress: 'ySpork', seeds: ['198.51.100.1:20001'] },
      platform: { chainId: 'dash-devnet-fixture-g1', initialProtocolVersion: 14, epochSeconds: 3600, quorums: { validatorSet: {}, chainLock: {}, instantLock: {} }, dapi: ['https://198.51.100.1:1443'] },
      services: {}, faucetAddress: null, images: [], hosts: [{ name: 'validators-001', role: 'validator', instanceId: 'i-1', arch: 'arm64', publicIp: '198.51.100.1', privateIp: '10.42.0.1' }] }));
    assert.equal((await w.req('/api/networks/devnet-fixture/config')).status, 401);
    await w.login();
    const r = await (await w.req('/api/networks/devnet-fixture/config')).json();
    assert.deepEqual(r.files.map((f) => f.name), ['devnet-fixture.conf', 'devnet-fixture.inventory', 'devnet-fixture.yml']);
    assert.match(r.files[0].text, /^devnet=fixture-g1$/m);
    assert.equal((await w.req('/api/networks/testnet/config')).status, 404, 'managed networks have no console connection files');
  } finally { w.close(); }
});

test('issue API is additive, fails visibly when stale, and limits private detail to admins', async () => {
  const w = await start();
  try {
    assert.equal((await w.req('/api/issues')).status, 503);
    mkdirSync(join(w.dataDir, 'incidents'), { recursive: true });
    const issues = [{ id: 'a'.repeat(24), domain: 'network', scope: 'testnet', target: 'PRIVATE-HOST', code: 'host_health', severity: 'critical', status: 'open', evidence: { key: 'PRIVATE-EVIDENCE' } },
      { id: 'b'.repeat(24), domain: 'network', scope: 'hidden-network', target: 'PRIVATE', code: 'host_health', severity: 'critical', status: 'open' }];
    writeFileSync(join(w.dataDir, 'incidents', 'state.json'), JSON.stringify({ generatedAt: new Date().toISOString(), issues, sources: {}, outbox: [] }));
    const anonymous = await w.req('/api/issues'); assert.equal(anonymous.status, 200);
    const text = await anonymous.text(); assert.ok(!text.includes('PRIVATE')); assert.ok(!text.includes('hidden-network'));
    const invalid = await w.req('/api/issues', { headers: { authorization: 'Bearer invented' } });
    assert.ok(!(await invalid.text()).includes('PRIVATE'));
    await w.login(); const full = await (await w.req('/api/issues')).json();
    assert.equal(full.issues[0].evidence.key, 'PRIVATE-EVIDENCE'); assert.equal(full.delivery.pending, 0);
  } finally { w.close(); }
});

test('remediation board notes require administrator access', async () => {
  const w = await start();
  try {
    const at = new Date().toISOString();
    writeFileSync(join(w.dataDir, 'incidents', 'state.json'), JSON.stringify({ generatedAt: at, outbox: [],
      issues: [{ id: 'a'.repeat(24), domain: 'network', scope: 'testnet', target: 'PRIVATE-HOST', code: 'host_health', severity: 'critical', status: 'open' }],
      delivery: { receiver: { remediation: { schemaVersion: 1, generatedAt: at, enabled: true, cases: [
        { issueId: 'a'.repeat(24), workerState: 'completed', lastResponse: { outcome: 'blocked', summary: 'PRIVATE-NOTE' } },
      ] } } } }));
    const anonymous = await w.req('/api/remediation'); assert.equal(anonymous.status, 200);
    assert.doesNotMatch(await anonymous.text(), /PRIVATE/);
    const invalid = await w.req('/api/remediation', { headers: { authorization: 'Bearer invented' } });
    assert.doesNotMatch(await invalid.text(), /PRIVATE/);
    await w.login(); const full = await (await w.req('/api/remediation')).json();
    assert.equal(full.public, false); assert.equal(full.cases[0].summary, 'PRIVATE-NOTE');
    assert.equal(full.cases[0].stage, 'blocked');
  } finally { w.close(); }
});

test('private keys require network operator and CSRF, not admin; grants reload immediately', async () => {
  for (const role of ['operator', 'viewer']) {
    let reads = 0;
    const w = await start(777, [{ id: 777, login: 'keys', role, networks: ['devnet-sakura'] }], { keyReader: async () => { reads++; return { fixturePrivateKey: 'fixture-only' }; } });
    try {
      writeFileSync(join(w.dataDir, 'devnets.json'), JSON.stringify({ 'devnet-sakura': { status: 'ready' }, 'devnet-other': { status: 'ready' } }));
      const path = '/api/networks/devnet-sakura/keys';
      assert.equal((await w.req(path, { method: 'POST' })).status, 401);
      const csrf = await w.login(), headers = { 'x-csrf-token': csrf };
      assert.equal((await w.req(path, { method: 'POST' })).status, 403);
      assert.equal((await w.req('/api/networks/devnet-other/keys', { method: 'POST', headers })).status, 403);
      assert.equal((await w.req(path, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
      const response = await w.req(path, { method: 'POST', headers });
      assert.equal(response.status, role === 'operator' ? 200 : 403);
      assert.equal(reads, role === 'operator' ? 1 : 0);
      if (role === 'operator') {
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.equal((await response.json()).fixturePrivateKey, 'fixture-only');
        const settings = JSON.parse(readFileSync(join(w.dataDir, 'settings.json')));
        settings.operators = settings.operators.filter(x => x.id !== 777);
        writeFileSync(join(w.dataDir, 'settings.json'), JSON.stringify(settings));
        assert.equal((await w.req(path, { method: 'POST', headers })).status, 403);
        assert.equal(reads, 1);
      }
    } finally { w.close(); }
  }
});

test('key route excludes Mainnet/Testnet and suppresses internal errors', async () => {
  let reads = 0;
  const w = await start(9920871, [], { keyReader: async () => { reads++; throw Error('secret fixture must never escape'); } });
  try {
    const csrf = await w.login(), headers = { 'x-csrf-token': csrf };
    for (const network of ['mainnet', 'testnet']) assert.equal((await w.req(`/api/networks/${network}/keys`, { method: 'POST', headers })).status, 404);
    assert.equal(reads, 0);
    writeFileSync(join(w.dataDir, 'devnets.json'), JSON.stringify({ 'devnet-sakura': { status: 'ready' } }));
    const response = await w.req('/api/networks/devnet-sakura/keys', { method: 'POST', headers });
    assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('secret fixture'));
  } finally { w.close(); }
});

test('key route names a missing key service instead of blaming the devnet', async () => {
  // Default reader, no socket configured: what a web container rolled without the keys overlay sees.
  const w = await start(9920871, [], { keySocket: '' });
  try {
    const csrf = await w.login(), headers = { 'x-csrf-token': csrf };
    writeFileSync(join(w.dataDir, 'devnets.json'), JSON.stringify({ 'devnet-sakura': { status: 'ready' } }));
    const response = await w.req('/api/networks/devnet-sakura/keys', { method: 'POST', headers });
    assert.equal(response.status, 503);
    const { error } = await response.json();
    assert.match(error, /key service is not running/); assert.doesNotMatch(error, /must be idle/);
  } finally { w.close(); }
});

test('key reader marks an absent or unreachable socket, and only that, as a service fault', async () => {
  await assert.rejects(requestDevnetKeys('', 'devnet-sakura', { id: 1 }), { code: 'key-service-down' });
  await assert.rejects(requestDevnetKeys(join(tmpdir(), `absent-${process.pid}-keys.sock`), 'devnet-sakura', { id: 1 }), { code: 'key-service-down' });
});

test('remediation switch and queue clear are administrator-only, CSRF-protected and default to off', async () => {
  const post = (w, path, body, csrf) => w.req(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(csrf ? { 'x-csrf-token': csrf } : {}) } });
  const stored = (w) => JSON.parse(readFileSync(join(w.dataDir, 'remediation-control.json'), 'utf8'));
  const w = await start();
  try {
    assert.equal((await post(w, '/api/remediation/dispatch', { enabled: true })).status, 401);
    assert.equal((await post(w, '/api/remediation/clear')).status, 401);
    const csrf = await w.login();
    assert.equal((await (await w.req('/api/remediation')).json()).control.requested, 'off');
    assert.equal((await post(w, '/api/remediation/dispatch', { enabled: true })).status, 403, 'a session without the CSRF token is refused');
    assert.equal((await post(w, '/api/remediation/dispatch', { enabled: 'yes' }, csrf)).status, 400);
    assert.equal((await post(w, '/api/remediation/dispatch', { enabled: true }, csrf)).status, 200);
    assert.deepEqual([stored(w).seq, stored(w).dispatch, stored(w).updatedBy], [1, 'on', 'someone']);
    assert.equal((await post(w, '/api/remediation/clear', undefined, csrf)).status, 200);
    assert.deepEqual([stored(w).seq, stored(w).clearSeq, stored(w).dispatch], [2, 2, 'on']);
    const view = await (await w.req('/api/remediation')).json();
    assert.deepEqual([view.control.requested, view.control.applied, view.control.changedBy], ['on', null, 'someone']);
    assert.equal((await post(w, '/api/remediation/dispatch', { enabled: false }, csrf)).status, 200);
    assert.equal(stored(w).dispatch, 'off');
    // The file is lost while the worker is on at a sequence the new file is far below.
    mkdirSync(join(w.dataDir, 'incidents'), { recursive: true });
    writeFileSync(join(w.dataDir, 'incidents', 'state.json'), JSON.stringify({ generatedAt: new Date().toISOString(), issues: [], sources: {}, outbox: [],
      delivery: { lastAckAt: new Date().toISOString(), receiver: { control: { seq: 9, dispatch: 'on', clearSeq: 4, localEnabled: true } } } }));
    rmSync(join(w.dataDir, 'remediation-control.json'));
    const lost = (await (await w.req('/api/remediation')).json()).control;
    assert.deepEqual([lost.requested, lost.reset], ['off', true], 'the board shows OFF and says the setting was lost');
    assert.equal((await post(w, '/api/remediation/dispatch', { enabled: false }, csrf)).status, 200);
    assert.deepEqual([stored(w).seq, stored(w).dispatch, stored(w).clearSeq], [11, 'off', 4], 'the command is numbered above the worker, and no clear rides along');
    rmSync(join(w.dataDir, 'remediation-control.json'));
    assert.equal((await post(w, '/api/remediation/clear', undefined, csrf)).status, 200);
    assert.deepEqual([stored(w).seq, stored(w).dispatch, stored(w).clearSeq], [11, 'off', 11], 'a clear after the loss is not stale either, and does not switch on');
    assert.equal((await (await w.req('/api/remediation')).json()).control.reset, false);
  } finally { w.close(); }
  const member = await start(42);
  try {
    const csrf = await member.login();
    assert.equal((await post(member, '/api/remediation/dispatch', { enabled: true }, csrf)).status, 403);
    assert.equal((await post(member, '/api/remediation/clear', undefined, csrf)).status, 403);
    assert.equal((await (await member.req('/api/remediation')).json()).control.changedBy, undefined);
  } finally { member.close(); }
});

test('Actions queue: signed org webhook in, public and member views out', async () => {
  const w = await start(9920871, [], { ciQueue: { secret: 'hook-secret' } });
  try {
    const send = (event, payload, secret = 'hook-secret') => {
      const body = JSON.stringify(payload);
      return w.req('/api/ci/github-webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': event,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } });
    };
    const job = (id, name, priv) => ({ action: 'queued', organization: { login: 'dashpay' }, repository: { full_name: name, private: priv },
      workflow_job: { id, run_id: id, status: 'queued', name: 'lint', workflow_name: 'CI', labels: ['dash-x64-light'], created_at: new Date().toISOString(), head_branch: 'feat/a' } });
    assert.equal((await send('ping', { zen: 'hi' })).status, 200);
    assert.equal((await send('workflow_job', job(1, 'dashpay/dash', false), 'wrong')).status, 401);
    assert.equal((await send('workflow_job', job(1, 'dashpay/dash', false))).status, 200);
    assert.equal((await send('workflow_job', job(2, 'dashpay/hotfix', true))).status, 200);
    assert.equal((await send('workflow_run', { action: 'requested' })).status, 202);
    const pub = await (await w.req('/api/ci/queue')).json();
    assert.equal(pub.public, true);
    assert.deepEqual(pub.waiting.map((j) => j.repo), ['dashpay/dash']);
    assert.equal(pub.waiting[0].branch, undefined);
    await w.login();
    const full = await (await w.req('/api/ci/queue')).json();
    assert.equal(full.public, false);
    assert.deepEqual(full.waiting.map((j) => j.repo).sort(), ['dashpay/dash', 'dashpay/hotfix']);
    const cap = await (await w.req('/api/ci/queue/capacity?window=24h')).json();
    assert.deepEqual([cap.public, cap.window], [false, '24h']);
    assert.deepEqual(cap.labels.map((g) => g.labels), [['dash-x64-light']]);
  } finally { w.close(); }
  const anon = await start(9920871, [], { ciQueue: { secret: 'hook-secret' } });
  try {
    const cap = await (await anon.req('/api/ci/queue/capacity?window=14d')).json();
    assert.deepEqual([cap.public, cap.window], [true, '14d']);
  } finally { anon.close(); }
});

test('Actions queue webhook is off without a secret', async () => {
  const w = await start();
  try {
    assert.equal((await w.req('/api/ci/github-webhook', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-github-event': 'ping' } })).status, 404);
    assert.deepEqual((await (await w.req('/api/ci/queue')).json()).configured, { webhook: false, sweep: null });
  } finally { w.close(); }
});

test('Actions queue: private changes are announced to members only', async () => {
  const w = await start(9920871, [], { ciQueue: { secret: 'hook-secret' } });
  const streams = [];
  try {
    const send = (id, priv) => {
      const body = JSON.stringify({ action: 'queued', organization: { login: 'dashpay' }, repository: { full_name: priv ? 'dashpay/hotfix' : 'dashpay/dash', private: priv },
        workflow_job: { id, run_id: id, status: 'queued', name: 'lint', workflow_name: 'CI', labels: ['x'], created_at: new Date().toISOString() } });
      return w.req('/api/ci/github-webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'workflow_job', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'hook-secret').update(body).digest('hex')}` } });
    };
    // Collects the event types one stream receives.
    const listen = async (cookie) => {
      const ctl = new AbortController();
      const r = await w.req('/api/stream', { headers: cookie ? {} : { cookie: '' }, signal: ctl.signal });
      const seen = [];
      (async () => { try { for await (const chunk of r.body) for (const m of String(Buffer.from(chunk)).matchAll(/^event: (\S+)/gm)) seen.push(m[1]); } catch { /* aborted */ } })();
      streams.push(ctl);
      return seen;
    };
    const anon = await listen(false);
    await w.login();
    const member = await listen(true);
    const settle = () => new Promise((r) => setTimeout(r, 1300)); // notices are debounced by 1 s
    await send(1, true);
    await settle();
    assert.deepEqual([member.includes('ci-queue'), anon.includes('ci-queue')], [true, false]);
    await send(2, false);
    await settle();
    assert.equal(anon.includes('ci-queue'), true);
  } finally { for (const s of streams) s.abort(); w.close(); }
});

test('a deleted devnet no longer blocks its name in the new-devnet form', async () => {
  const w = await start();
  try {
    writeFileSync(join(w.dataDir, 'devnets.json'), JSON.stringify({ 'devnet-sakura': { status: 'deleted' }, 'devnet-bonsai': { status: 'ready' }, 'devnet-stuck': { status: 'deleting' } }));
    await w.login();
    const { existing } = await (await w.req('/api/devnets/defaults')).json();
    assert.equal(existing.includes('devnet-sakura'), false);
    assert.ok(existing.includes('devnet-bonsai') && existing.includes('devnet-stuck') && existing.includes('testnet'));
  } finally { w.close(); }
});

test('public projection cache keeps its 15 s lifetime and evicts expired keys on insert', () => {
  let now = 0, calls = 0;
  const cached = ttlCache(() => now);
  for (const at of ['a', 'b']) for (const view of ['public', 'signed-in']) cached(`aws|${view}|${at}`, () => ++calls);
  assert.equal(cached('aws|public|a', () => ++calls), 1, 'a live entry is reused');
  now = 14_999;
  assert.equal(cached('ci', () => ++calls), 5);
  assert.equal(cached.size(), 5, 'nothing is evicted before it expires');
  now = 15_000;
  assert.equal(cached('aws|public|c', () => ++calls), 6);
  assert.equal(cached.size(), 2, 'entries from the previous inventory are gone');
  assert.equal(cached('ci', () => ++calls), 5);
  cached.delete('ci');
  assert.equal(cached('ci', () => ++calls), 7);
});

// A bot: no cookie jar, no Origin header, only the bearer token.
const bot = (w, token) => (path, opts = {}) => fetch(w.base + path, { ...opts, headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) } });
const issueToken = async (w, csrf, body) => {
  const r = await w.req('/api/tokens', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
  return { status: r.status, ...(await r.json()) };
};

test('API tokens: an admin issues one; a bot queues and confirms operations with it, without a session or CSRF', async () => {
  const w = await start();
  try {
    assert.equal((await w.req('/api/tokens')).status, 401, 'signed out');
    const csrf = await w.login();
    assert.equal((await w.req('/api/tokens', { method: 'POST', body: JSON.stringify({ label: 'infraclaw', role: 'admin' }), headers: { 'content-type': 'application/json' } })).status, 403, 'CSRF required to issue');
    assert.equal((await issueToken(w, csrf, { label: '', role: 'admin' })).status, 400);
    assert.equal((await issueToken(w, csrf, { label: 'x', role: 'root' })).status, 400);
    assert.equal((await issueToken(w, csrf, { label: 'x', role: 'operator', networks: [] })).status, 400);
    assert.equal((await issueToken(w, csrf, { label: 'x', role: 'operator', networks: ['testnet'], expiresDays: 0 })).status, 400);
    const issued = await issueToken(w, csrf, { label: 'infraclaw', role: 'admin', networks: ['testnet'] });
    assert.equal(issued.status, 201);
    assert.match(issued.token, /^dst_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual([issued.role, issued.networks, issued.owner], ['admin', ['*'], { id: 9920871, login: 'someone' }]);
    // Only the hash is kept, and the list never returns the token.
    const stored = readFileSync(join(w.dataDir, 'api-tokens.json'), 'utf8');
    // The secret is base64url and may itself contain or start with an underscore.
    const secret = issued.token.slice(`dst_${issued.id}_`.length);
    assert.equal(secret.length, 43);
    assert.ok(!stored.includes(issued.token) && !stored.includes(secret));
    const listed = await (await w.req('/api/tokens')).json();
    assert.deepEqual(listed.tokens.map((t) => [t.id, t.label, t.token]), [[issued.id, 'infraclaw', undefined]]);

    const call = bot(w, issued.token);
    const me = await (await call('/api/me')).json();
    assert.deepEqual(me.user, { id: 9920871, login: 'someone', token: issued.id });
    assert.deepEqual([me.role, me.admin, me.allNetworks], ['admin', true, true]);
    assert.equal((await (await call('/api/networks/testnet')).json()).hosts[0].instanceId, 'i-0eb19958115adb5d0', 'member detail');
    const body = JSON.stringify({ action: 'upgrade', nodes: ['seed-2'], components: ['tenderdash'], images: { tenderdash: 'dashpay/tenderdash:1.8.2' } });
    assert.equal((await bot(w)('/api/networks/testnet/ops', { method: 'POST', body })).status, 401, 'no token, no session');
    const queued = await call('/api/networks/testnet/ops', { method: 'POST', body });
    assert.equal(queued.status, 202);
    const { id } = await queued.json();
    const q = JSON.parse(readFileSync(join(w.dataDir, 'requests', `${id}.json`), 'utf8'));
    assert.deepEqual(q.actor, { id: 9920871, login: 'someone', token: issued.id }, 'the account, and the token it acted through; never the grant');
    // Review, then confirm with the plan id, as the console does.
    mkdirSync(join(w.dataDir, 'ops'), { recursive: true });
    writeFileSync(join(w.dataDir, 'ops', `${id}.json`), JSON.stringify({ id, network: 'testnet', status: 'review', review: { planId: 'plan-1' }, request: { action: 'upgrade' }, createdAt: new Date().toISOString() }));
    assert.equal((await (await call(`/api/ops/${id}`)).json()).status, 'review');
    assert.equal((await call(`/api/ops/${id}/confirm`, { method: 'POST', body: JSON.stringify({ planId: 'stale' }) })).status, 409);
    assert.equal((await call(`/api/ops/${id}/confirm`, { method: 'POST', body: JSON.stringify({ planId: 'plan-1' }) })).status, 202);
    const confirm = readdirSync(join(w.dataDir, 'requests')).find((f) => f.startsWith(`${id}.confirm-`));
    assert.deepEqual(JSON.parse(readFileSync(join(w.dataDir, 'requests', confirm), 'utf8')).actor, { id: 9920871, login: 'someone', token: issued.id });
    assert.ok((await (await w.req('/api/tokens')).json()).tokens[0].lastUsedAt, 'use is recorded');

    // A presented token is that token or nothing: a wrong one never falls back to the browser session.
    const wrong = `${issued.token.slice(0, -1)}${issued.token.endsWith('A') ? 'B' : 'A'}`;
    assert.equal((await w.req('/api/me', { headers: { authorization: `Bearer ${wrong}` } })).status, 401);
    assert.equal((await bot(w, 'dst_nope')('/api/overview')).status, 401);
    // Revoked: dead at once.
    assert.equal((await w.req('/api/tokens/ffffffff', { method: 'DELETE', headers: { 'x-csrf-token': csrf } })).status, 404);
    assert.equal((await w.req(`/api/tokens/${issued.id}`, { method: 'DELETE', headers: { 'x-csrf-token': csrf } })).status, 200);
    assert.equal((await call('/api/me')).status, 401);
    assert.equal((await call('/api/networks/testnet/ops', { method: 'POST', body })).status, 401);
  } finally { w.close(); }
});

test('API tokens operate networks only: no settings, access, tokens, remediation or private keys', async () => {
  const w = await start();
  try {
    const csrf = await w.login();
    writeFileSync(join(w.dataDir, 'devnets.json'), JSON.stringify({ 'devnet-palmatum': { status: 'ready', coreNetwork: 'palmatum-g1' } }));
    const { token } = await issueToken(w, csrf, { label: 'admin bot', role: 'admin' });
    const call = bot(w, token);
    const { settings } = await (await call('/api/settings')).json();
    assert.ok(settings.networks.length, 'settings are readable');
    const refused = [
      ['PUT', '/api/settings', { settings }], ['PUT', '/api/access/583231', { login: 'octocat', role: 'admin' }], ['DELETE', '/api/access/9920871'],
      ['GET', '/api/tokens'], ['POST', '/api/tokens', { label: 'more', role: 'admin' }], ['DELETE', '/api/tokens/00000000'],
      ['POST', '/api/remediation/dispatch', { enabled: true }], ['POST', '/api/remediation/clear'], ['POST', '/api/ci/reporters', { label: 'h' }],
      ['POST', '/api/networks/devnet-palmatum/keys'],
    ];
    for (const [method, path, body] of refused) {
      // Even with the admin's own cookie and CSRF value attached, a token request stays a token request.
      const r = await w.req(path, { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-csrf-token': csrf } });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.match((await r.json()).error, /signed-in account/, `${method} ${path}`);
    }
    assert.equal(Object.keys(JSON.parse(readFileSync(join(w.dataDir, 'api-tokens.json'), 'utf8'))).length, 1);
    assert.equal((await call('/api/auth/logout', { method: 'POST' })).status, 403);
    // Admin tokens do manage devnet lifecycle and Platform resets, which is what a bot is for.
    const reset = await call('/api/networks/devnet-palmatum/ops', { method: 'POST', body: JSON.stringify({ action: 'platform-reset', images: { drive: 'dashpay/drive:5.0.3' }, options: { genesisProtocolVersion: 14 } }) });
    assert.equal(reset.status, 202);
  } finally { w.close(); }
});

test('API tokens: an admin token changes the versions a new devnet starts with, and nothing else in the settings', async () => {
  const w = await start(9920871, [{ id: 77, login: 'op', role: 'operator', networks: ['*'] }]);
  try {
    const path = '/api/settings/devnet-versions';
    const send = (call, body, headers = {}) => call(path, { method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
    const file = () => JSON.parse(readFileSync(join(w.dataDir, 'settings.json'), 'utf8'));
    const insight = { services: { insightImage: 'dashpay/insight:4.0.12' } };
    assert.equal((await send(bot(w), insight)).status, 401, 'signed out, no token');
    const csrf = await w.login();
    // A settings file as a running console has it: a block and a key this code
    // does not know, and console devnets that live in devnets.json, not in it.
    writeFileSync(join(w.dataDir, 'settings.json'), JSON.stringify({ ...file(), remediation: { ignoredCiJobs: [] }, keptForLater: { a: 1 } }));
    writeFileSync(join(w.dataDir, 'devnets.json'), JSON.stringify({ 'devnet-palmatum': { status: 'ready', coreNetwork: 'palmatum-g1' }, 'devnet-gone': { status: 'deleted' } }));
    const before = file();
    assert.equal(before.devnets.services.insightImage, 'dashpay/insight:4.0.11', 'the built-in default reads Core 24 blocks');
    const admin = bot(w, (await issueToken(w, csrf, { label: 'admin bot', role: 'admin' })).token);
    const operator = bot(w, (await issueToken(w, csrf, { label: 'operator bot', role: 'operator', networks: ['*'] })).token);
    const viewer = bot(w, (await issueToken(w, csrf, { label: 'viewer bot', role: 'viewer', networks: ['*'] })).token);
    for (const call of [operator, viewer]) {
      const r = await send(call, insight);
      assert.equal(r.status, 403);
      assert.match((await r.json()).error, /Only admins/);
    }

    // Only the listed version keys, only as strings, and only values the settings would accept from the page.
    const refused = [
      {}, [], { images: {} , operators: [{ id: 1, login: 'x', role: 'admin', networks: ['*'] }] }, { settings: { devnets: {} } },
      { vpcId: 'vpc-0abc' }, { validators: 25 }, { services: { faucetRef: 'a'.repeat(40) } }, { services: { faucetFunding: 1 } }, { services: { epochSeconds: 60 } },
      { images: { miner: 'dashpay/dashd:24' } }, { images: ['dashpay/dashd:24'] }, { services: 'dashpay/insight:4.0.12' }, { services: { insightImage: 4 } },
      { services: { insightImage: 'evil/insight:4.0.12' } }, { services: { insightImage: 'dashpay/insight' } }, { images: { core: 'dashpay/drive:5.0.3' } },
      { services: { explorerVersion: 'latest; rm -rf /' } }, { services: { quorumServer: 'dashpay/insight:4.0.12' } },
      { services: { explorerVersion: `${'1'.repeat(40)}.0.0` } }, { images: { acme: '' } }, { images: { acme: '  ' } }, { services: { insightImage: '' } },
      '{"services":{"__proto__":"dashpay/insight:4.0.12"}}', '{"__proto__":{"insightImage":"dashpay/insight:4.0.12"}}', '{"constructor":{}}',
    ];
    for (const body of refused) assert.equal((await send(admin, body)).status, 400, JSON.stringify(body));
    assert.deepEqual(file(), before, 'a refused request writes nothing');

    const r = await send(admin, { images: { core: ' dashpay/dashd:24.0.3 ' }, services: { insightImage: 'dashpay/insight:4.0.12', explorerVersion: before.devnets.services.explorerVersion } });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.deepEqual(out.changed, [
      { key: 'images.core', from: before.devnets.images.core, to: 'dashpay/dashd:24.0.3' },
      { key: 'services.insightImage', from: 'dashpay/insight:4.0.11', to: 'dashpay/insight:4.0.12' },
    ], 'a value that is already set is not a change');
    assert.deepEqual([out.devnets.images.core, out.devnets.services.insightImage], ['dashpay/dashd:24.0.3', 'dashpay/insight:4.0.12']);
    const after = file();
    assert.deepEqual([after.devnets.images.core, after.devnets.services.insightImage], ['dashpay/dashd:24.0.3', 'dashpay/insight:4.0.12']);
    const restored = structuredClone(after);
    restored.devnets.images.core = before.devnets.images.core;
    restored.devnets.services.insightImage = before.devnets.services.insightImage;
    assert.deepEqual(restored, before, 'users, networks, thresholds and every other devnet default are as they were');
    assert.equal((await (await admin('/api/settings')).json()).settings.devnets.services.insightImage, 'dashpay/insight:4.0.12', 'what the next new devnet reads');

    // The same request again changes nothing and says so.
    const again = await (await send(admin, insight)).json();
    assert.deepEqual(again.changed, []);
    // A signed-in admin may use it too, with the CSRF value like any other write.
    const back = { images: { core: before.devnets.images.core }, services: { insightImage: 'dashpay/insight:4.0.11' } };
    assert.equal((await send(w.req, back)).status, 403, 'CSRF required for a session');
    assert.equal((await send(w.req, back, { 'x-csrf-token': csrf, origin: 'https://elsewhere.example' })).status, 403, 'and the console as Origin');
    const viaSession = await send(w.req, back, { 'x-csrf-token': csrf });
    assert.equal(viaSession.status, 200);
    assert.deepEqual(file(), before);
    // Everything else in the settings still needs the signed-in account.
    const full = await admin('/api/settings', { method: 'PUT', body: JSON.stringify({ settings: before }) });
    assert.equal(full.status, 403);
    assert.match((await full.json()).error, /signed-in account/);

    // A Settings page opened before a bot's change does not put the old version back when it saves something else...
    const page = (await (await w.req('/api/settings')).json()).settings;
    assert.equal((await send(admin, insight)).status, 200);
    const put = (settings, loadedDevnets) => w.req('/api/settings', { method: 'PUT', body: JSON.stringify({ settings, loadedDevnets }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    const edited = structuredClone(page);
    edited.thresholds.diskWarnPercent = 70;
    assert.equal((await put(edited, page.devnets)).status, 200);
    assert.deepEqual([file().thresholds.diskWarnPercent, file().devnets.services.insightImage], [70, 'dashpay/insight:4.0.12']);
    // ...and a version edited on that page is the admin's choice and is saved.
    edited.devnets.services.insightImage = 'dashpay/insight:4.0.13';
    assert.equal((await put(edited, page.devnets)).status, 200);
    assert.equal(file().devnets.services.insightImage, 'dashpay/insight:4.0.13');

    // The account behind the token is demoted: the token no longer changes defaults.
    const good = file();
    writeFileSync(join(w.dataDir, 'settings.json'), JSON.stringify({ ...good, operators: [{ id: 77, login: 'op', role: 'admin', networks: ['*'] }, { id: 9920871, login: 'someone', role: 'operator', networks: ['*'] }] }));
    assert.equal((await send(admin, back)).status, 403);
    // A damaged settings file is never replaced by defaults plus the change.
    writeFileSync(join(w.dataDir, 'settings.json'), '{ not json');
    assert.equal((await send(admin, back)).status, 503);
    assert.equal((await send(w.req, back, { 'x-csrf-token': csrf })).status, 503);
    assert.equal(readFileSync(join(w.dataDir, 'settings.json'), 'utf8'), '{ not json');
  } finally { w.close(); }
});

test('API tokens narrow their account: role, networks, expiry, and the account losing access', async () => {
  let now = Date.now();
  const w = await start(9920871, [{ id: 77, login: 'op', role: 'operator', networks: ['testnet'] }], { clock: () => now });
  try {
    const csrf = await w.login();
    writeFileSync(join(w.dataDir, 'devnets.json'), JSON.stringify({ 'devnet-palmatum': { status: 'ready', coreNetwork: 'palmatum-g1', public: false } }));
    const doctor = JSON.stringify({ action: 'doctor', nodes: ['seed-2'] });
    const viewer = bot(w, (await issueToken(w, csrf, { label: 'viewer', role: 'viewer', networks: ['testnet'] })).token);
    assert.equal((await viewer('/api/networks/testnet/ops')).status, 200);
    assert.equal((await viewer('/api/networks/testnet/ops', { method: 'POST', body: doctor })).status, 403);
    assert.equal((await viewer('/api/networks/devnet-palmatum')).status, 404, 'a private network outside the grant stays hidden');
    assert.deepEqual((await (await viewer('/api/settings')).json()).settings.networks.map((n) => n.name), ['testnet']);

    const operator = bot(w, (await issueToken(w, csrf, { label: 'testnet operator', role: 'operator', networks: ['testnet'], expiresDays: 2 })).token);
    assert.deepEqual((await (await operator('/api/me')).json()).operatorOf, ['testnet']);
    assert.equal((await operator('/api/networks/testnet/ops', { method: 'POST', body: doctor })).status, 202);
    assert.equal((await operator('/api/networks/devnet-palmatum/ops', { method: 'POST', body: doctor })).status, 403, 'not granted');
    const wide = bot(w, (await issueToken(w, csrf, { label: 'all networks', role: 'operator', networks: ['*'] })).token);
    assert.equal((await wide('/api/networks/devnet-palmatum/ops', { method: 'POST', body: JSON.stringify({ action: 'platform-reset' }) })).status, 403, 'lifecycle needs an admin token');
    assert.equal((await wide('/api/devnets', { method: 'POST', body: JSON.stringify({ name: 'devnet-new' }) })).status, 403);
    now += 2 * 86400_000;
    assert.equal((await operator('/api/me')).status, 401, 'expired');
    assert.equal((await wide('/api/me')).status, 200, 'no expiry');

    // The issuing admin is demoted by another admin: its tokens follow at once.
    const s = JSON.parse(readFileSync(join(w.dataDir, 'settings.json'), 'utf8'));
    s.operators = [{ id: 77, login: 'op', role: 'admin', networks: ['*'] }, { id: 9920871, login: 'someone', role: 'operator', networks: ['testnet'] }];
    writeFileSync(join(w.dataDir, 'settings.json'), JSON.stringify(s));
    const me = await (await wide('/api/me')).json();
    assert.deepEqual([me.role, me.operatorOf, me.allNetworks], ['operator', ['testnet'], false]);
    assert.equal((await wide('/api/networks/devnet-palmatum/ops', { method: 'POST', body: doctor })).status, 403);
    s.operators = [{ id: 77, login: 'op', role: 'admin', networks: ['*'] }];
    writeFileSync(join(w.dataDir, 'settings.json'), JSON.stringify(s));
    assert.equal((await wide('/api/me')).status, 401, 'account removed');
    assert.equal((await viewer('/api/networks/testnet/ops')).status, 401);
  } finally { w.close(); }
});

test('API tokens: a presented token is enforced on the session routes, and never authorized by default settings', async () => {
  const w = await start();
  try {
    const csrf = await w.login();
    const { token } = await issueToken(w, csrf, { label: 'bot', role: 'admin' });
    // The browser's own cookie is attached to every one of these.
    const withToken = (path, t, opts = {}) => w.req(path, { ...opts, headers: { authorization: `Bearer ${t}`, 'x-csrf-token': csrf, ...(opts.headers || {}) } });
    assert.equal((await withToken('/api/session', 'dst_nope')).status, 401, 'a wrong token does not fall back to the session');
    assert.equal((await withToken('/api/session', token)).status, 403);
    assert.equal((await withToken('/api/auth/logout', token, { method: 'POST' })).status, 403);
    assert.equal((await withToken('/api/auth/github', token)).status, 403);
    assert.equal((await (await w.req('/api/session')).json()).user.id, 9920871, 'the browser session survived');

    // Unreadable or invalid settings: loadSettings falls back to defaults that name an admin.
    const saved = readFileSync(join(w.dataDir, 'settings.json'), 'utf8');
    for (const broken of ['{ not json', JSON.stringify({ ...JSON.parse(saved), pollSeconds: 1 })]) {
      writeFileSync(join(w.dataDir, 'settings.json'), broken);
      const r = await bot(w, token)('/api/me');
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /settings unavailable/);
      assert.equal((await bot(w, token)('/api/networks/testnet/ops', { method: 'POST', body: JSON.stringify({ action: 'doctor', nodes: ['seed-2'] }) })).status, 503);
    }
    rmSync(join(w.dataDir, 'settings.json'));
    assert.equal((await bot(w, token)('/api/me')).status, 503, 'no settings file');
    assert.equal((await bot(w)('/api/overview')).status, 200, 'the public board still answers');
    writeFileSync(join(w.dataDir, 'settings.json'), saved);
    assert.equal((await bot(w, token)('/api/me')).status, 200);
  } finally { w.close(); }
});

test('API tokens: CI and AWS detail only for a grant that covers every network', async () => {
  const w = await start();
  try {
    const csrf = await w.login();
    mkdirSync(join(w.dataDir, 'aws'), { recursive: true });
    writeFileSync(join(w.dataDir, 'aws', 'inventory.json'), JSON.stringify({ at: 'now', regions: ['us-west-2'], errors: [],
      instances: [{ region: 'us-west-2', id: 'i-0123456789abcdef0', type: 't4g.small', state: 'running', arch: 'arm64', publicIp: '192.0.2.9', tags: { Name: 'dn-devnet-secret-1', DashNetwork: 'devnet-secret' }, vcpus: 2, memoryMiB: 2048 }],
      volumes: [], addresses: [], natGateways: [], loadBalancers: [], lambda: [], dynamodb: [], ecr: [], snapshots: [], cloudfront: [], s3: [],
      costs: { at: 'now', month: '2026-11', monthToDate: 100, monthEndEstimate: 200, lastMonth: 150, byService: [], daily: [] } }));
    const narrow = bot(w, (await issueToken(w, csrf, { label: 'testnet only', role: 'operator', networks: ['testnet'] })).token);
    const wide = bot(w, (await issueToken(w, csrf, { label: 'everything', role: 'viewer', networks: ['*'] })).token);
    const aws = await (await narrow('/api/aws')).json();
    assert.equal(aws.public, true);
    assert.equal(aws.costs, undefined, 'no spend for a narrowed token');
    for (const leak of ['192.0.2.9', 'i-0123456789abcdef0', 'dn-devnet-secret-1']) assert.ok(!JSON.stringify(aws).includes(leak), `leaked ${leak}`);
    assert.equal((await (await narrow('/api/ci')).json()).public, true);
    assert.equal((await (await narrow('/api/ci/queue')).json()).public, true);
    const all = await (await wide('/api/aws')).json();
    assert.equal(all.instances[0].publicIp, '192.0.2.9');
    assert.equal((await (await wide('/api/ci')).json()).public, undefined);
    // The browser account keeps its view, and the anonymous cache is not poisoned by either.
    assert.equal((await (await w.req('/api/aws')).json()).instances[0].id, 'i-0123456789abcdef0');
    assert.equal((await (await bot(w)('/api/aws')).json()).costs, undefined);
  } finally { w.close(); }
});

test('API tokens: an open operation log and event stream end when the token is revoked', async () => {
  const w = await start();
  try {
    const csrf = await w.login();
    const issued = await issueToken(w, csrf, { label: 'stream', role: 'admin' });
    const id = '6c8139ad-e92f-40da-943d-1e001efaccb5';
    mkdirSync(join(w.dataDir, 'ops'), { recursive: true });
    writeFileSync(join(w.dataDir, 'ops', `${id}.json`), JSON.stringify({ id, network: 'testnet', status: 'running', request: { action: 'upgrade' }, createdAt: new Date().toISOString() }));
    writeFileSync(join(w.dataDir, 'ops', `${id}.log`), 'first line\n');
    const text = new TextDecoder();
    // Reads until the server ends the stream; fails the test if it is still open after the limit.
    const drain = async (response, limitMs) => {
      const reader = response.body.getReader();
      let seen = '';
      const timeout = setTimeout(() => reader.cancel('still open'), limitMs);
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; seen += text.decode(value); } } finally { clearTimeout(timeout); }
      return seen;
    };
    const log = await bot(w, issued.token)(`/api/ops/${id}/log`);
    const events = await bot(w, issued.token)('/api/stream');
    assert.equal(log.status, 200); assert.equal(events.status, 200);
    const logDone = drain(log, 8000), eventsDone = drain(events, 8000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await w.req(`/api/tokens/${issued.id}`, { method: 'DELETE', headers: { 'x-csrf-token': csrf } })).status, 200);
    writeFileSync(join(w.dataDir, 'ops', `${id}.log`), 'first line\nwritten after the token was revoked\n');
    // The event stream is checked on its next event: an operation change is one.
    writeFileSync(join(w.dataDir, 'ops', `${id}.json`), JSON.stringify({ id, network: 'testnet', status: 'succeeded', request: { action: 'upgrade' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    const [logText, eventText] = await Promise.all([logDone, eventsDone]);
    assert.match(logText, /first line/);
    assert.ok(!logText.includes('written after the token was revoked'), 'nothing after revocation');
    assert.match(logText, /event: error\ndata: \{"error":"API token unknown, revoked or expired"\}/);
    assert.match(eventText, /event: error/);
    assert.ok(!eventText.includes('"status":"succeeded"'), 'no event after revocation');
  } finally { w.close(); }
});

test('the public Webhooks answer cannot be used to find hook names by guessing', async () => {
  const hooksDir = mkdtempSync(join(tmpdir(), 'web-hooks-'));
  writeFileSync(join(hooksDir, 'hooks.json'), JSON.stringify({ schemaVersion: 1, hooks: { 'agent-directory': { source: 'github', events: ['pull_request'], listeners: { 'worker-vm': 'a'.repeat(64) } } } }));
  writeFileSync(join(hooksDir, 'agent-directory.secret'), 'fixture-hook-secret-0123456789\n');
  let now = Date.now();
  const w = await start(9920871, [], { hooksDir, clock: () => now });
  try {
    const look = async () => { const answer = await (await fetch(`${w.base}/api/hooks`)).json(); delete answer.at; return answer; };
    const probe = (name) => fetch(`${w.base}/api/hooks/${name}`, { method: 'POST', body: '{}', headers: { 'x-github-event': 'push', 'x-github-delivery': 'x', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` } });
    const before = await look();
    for (const name of ['agent-directory', 'agent-directory', 'nothing-here']) assert.equal((await probe(name)).status, 401);
    now += 20_000; // past the few seconds the public answer is kept
    assert.deepEqual(await look(), before, 'refusals of a real name move nothing a stranger can read');
    // A real delivery is seen at once, not when the kept answer runs out.
    const body = '{"action":"opened"}';
    assert.equal((await fetch(`${w.base}/api/hooks/agent-directory`, { method: 'POST', body, headers: { 'x-github-event': 'pull_request', 'x-github-delivery': 'x',
      'x-hub-signature-256': `sha256=${createHmac('sha256', 'fixture-hook-secret-0123456789').update(body).digest('hex')}` } })).status, 202);
    assert.equal((await look()).summary.woke, 1);
    // They did happen, and an account with access sees them.
    await w.login();
    const full = await (await w.req('/api/hooks')).json();
    assert.deepEqual([full.hooks[0].deliveries.refused, full.summary.refused, full.hooks[0].level], [2, 2, 'info']);
  } finally { w.close(); rmSync(hooksDir, { recursive: true, force: true }); }
});

test('the Webhooks page: an account with access sees the hooks by name, everyone else counts', async () => {
  const hooksDir = mkdtempSync(join(tmpdir(), 'web-hooks-'));
  writeFileSync(join(hooksDir, 'hooks.json'), JSON.stringify({ schemaVersion: 1, hooks: {
    'agent-directory': { source: 'github', events: ['pull_request'], listeners: { 'worker-vm': 'a'.repeat(64) } },
    'forum-queue': { source: 'xenforo', events: ['user.insert'], listeners: { 'ubuntu-server-2': 'b'.repeat(64) } } } }));
  writeFileSync(join(hooksDir, 'agent-directory.secret'), 'fixture-hook-secret-0123456789\n');
  const named = (body) => /agent-directory|forum-queue|worker-vm|ubuntu-server-2|pull_request|user\.insert/.test(JSON.stringify(body));
  // An admin, an operator of one network, and an account that was never granted anything.
  const admin = await start(9920871, [], { hooksDir });
  const operator = await start(88, [{ id: 88, login: 'op', role: 'operator', networks: ['testnet'] }], { hooksDir });
  const stranger = await start(4242, [], { hooksDir });
  try {
    const anonymous = await (await fetch(`${admin.base}/api/hooks`)).json();
    assert.equal(anonymous.public, true);
    assert.deepEqual(anonymous.hooks, []);
    assert.deepEqual([anonymous.summary.hooks, anonymous.summary.down, anonymous.summary.starting], [2, 1, 1], 'one has no secret file, one waits for its listener');
    assert.equal(named(anonymous), false, 'nothing that names a hook, a listener or an event');
    assert.deepEqual(Object.keys(anonymous.summary).sort(), ['down', 'hooks', 'ignored', 'lastDeliveryAt', 'lastWakeAt', 'listening', 'startedAt', 'starting', 'woke'], 'no refusals and no warn: a stranger could move those');
    const answer = await fetch(`${admin.base}/api/hooks`);
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    assert.match(answer.headers.get('vary') || '', /Cookie/);

    const csrf = await admin.login();
    const full = await (await admin.req('/api/hooks')).json();
    assert.equal(full.public, false);
    assert.deepEqual(full.hooks.map((h) => [h.name, h.source, h.level, h.listeners[0].id]), [['agent-directory', 'github', 'info', 'worker-vm'], ['forum-queue', 'xenforo', 'down', 'ubuntu-server-2']]);
    assert.equal(/secret-0123456789|aaaaaaaa|bbbbbbbb/.test(JSON.stringify(full)), false, 'no secret and no token digest, for anyone');

    await operator.login();
    const member = await (await operator.req('/api/hooks')).json();
    assert.equal(member.public, false, 'any account with access, as on the CI and AWS pages');
    assert.equal(member.hooks.length, 2);

    await stranger.login();
    const none = await (await stranger.req('/api/hooks')).json();
    assert.equal(none.public, true);
    assert.equal(named(none), false);

    // An admin token for every network reads it as its account does; one narrowed to a network does not.
    const all = await issueToken(admin, csrf, { label: 'all', role: 'admin', networks: ['*'] });
    const narrow = await issueToken(admin, csrf, { label: 'narrow', role: 'operator', networks: ['testnet'] });
    assert.equal((await (await bot(admin, all.token)('/api/hooks')).json()).hooks.length, 2);
    assert.equal((await (await bot(admin, narrow.token)('/api/hooks')).json()).public, true);
  } finally { admin.close(); operator.close(); stranger.close(); rmSync(hooksDir, { recursive: true, force: true }); }
});
