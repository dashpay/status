import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConsole } from './console.js';
import { projectNetwork } from './networks.js';
import { createWorkflowService } from './workflows.js';

function fixture(dir, name = 'testnet') {
  const snapshot = { kind: 'ExistingSnapshot', id: 'a'.repeat(64), observedAt: new Date().toISOString(),
    fleet: { metadata: { name, displayName: 'Testnet' }, chainType: 'testnet', accountId: 'NEVER-PUBLIC', targets: [{ name: 'validator-1', instanceId: 'PRIVATE-ID', address: 'PRIVATE-ADDRESS', role: 'validator', containers: { core: 'PRIVATE-CONTAINER' } }] },
    nodes: { 'validator-1': { instanceId: 'PRIVATE-ID', filesHash: 'PRIVATE-FINGERPRINT', password: 'NEVER-PUBLIC', chain: { coreHeight: 123, platformHeight: 12, dapiHealthy: true, masternodeState: 'READY', platformProtocol: 13 },
      components: { core: { image: 'index.docker.io/dashpay/dashd:23', running: true, restarts: 0 } } } } };
  const path = join(dir, name + '.json'); writeFileSync(path, JSON.stringify(snapshot));
  return { n: { name, displayName: 'Testnet', snapshot: path, public: true }, snapshot };
}
test('public projection excludes all private fields and cannot infer health from an import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-console-')); try {
    const { n, snapshot } = fixture(dir); const result = projectNetwork(n, snapshot, null);
    assert.equal(result.status, 'observed'); assert.equal(result.expectedNodes, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|password|accountId|filesHash/);
    assert.equal(projectNetwork(n, snapshot, null, Date.now() + 700_000).status, 'stale');
    delete snapshot.nodes['validator-1']; assert.equal(projectNetwork(n, snapshot, null).status, 'unknown');
    assert.equal(projectNetwork(n, snapshot, null).nodes.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GitHub login grants only configured network permissions; CSRF and public/private boundaries hold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-console-'));
  const { n } = fixture(dir), secret = fixture(dir, 'private-devnet').n; secret.public = false;
  const config = { origin: 'http://127.0.0.1', networks: [n, secret], operators: { '42': { networks: ['testnet'], actions: ['doctor'] } }, operationsDir: join(dir, 'ops') };
  const app = createConsole(config, { auth: { clientId: 'fixture', clientSecret: 'fixture-secret', fetcher: async (url) => new Response(JSON.stringify(url.includes('access_token') ? { access_token: 'server-only-token' } : { id: 42, login: 'operator' })) } });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(base + '/api/networks'); const publicData = await response.json(); assert.equal(publicData.networks.length, 1); assert.doesNotMatch(JSON.stringify(publicData), /PRIVATE/);
    assert.equal((await fetch(base + '/api/networks/private-devnet')).status, 404);
    assert.equal((await fetch(base + '/api/networks/testnet/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const login = await fetch(base + '/api/auth/github', { redirect: 'manual' }); const state = new URL(login.headers.get('location')).searchParams.get('state');
    const binding = login.headers.get('set-cookie').split(';')[0]; assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await fetch(base + '/api/auth/callback?state=wrong&code=fixture', { redirect: 'manual' })).status, 400);
    const callback = await fetch(base + `/api/auth/callback?state=${state}&code=fixture`, { redirect: 'manual', headers: { Cookie: binding } }); assert.equal(callback.status, 302);
    const cookie = callback.headers.getSetCookie().find((v) => v.startsWith('dash-session=')).split(';')[0];
    response = await fetch(base + '/api/session', { headers: { Cookie: cookie } }); const session = await response.json(); assert.equal(session.user.id, 42); assert.doesNotMatch(JSON.stringify(session), /server-only-token|fixture-secret/);
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: config.origin, 'X-CSRF-Token': session.csrf };
    const post = (body, override = {}) => fetch(base + '/api/networks/testnet/preview', { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(body) });
    assert.equal((await post({ action: 'doctor' }, { Origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await post({ action: 'upgrade' })).status, 403);
    assert.equal((await post({ action: 'doctor' })).status, 200);
    assert.equal((await fetch(base + '/api/networks/private-devnet', { headers: { Cookie: cookie } })).status, 404);
    const replay = await fetch(base + `/api/auth/callback?state=${state}&code=fixture`, { redirect: 'manual', headers: { Cookie: binding } }); assert.equal(replay.status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});

test('lost workflow response is journaled, never blindly re-dispatched, and reconciles by exact request ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-console-')); try {
    const { n, snapshot } = fixture(dir); const config = { operationsDir: join(dir, 'ops'), workflow: { enabled: true } }; let dispatches = 0;
    const request = randomUUID(); const actor = { id: 42, login: 'operator' };
    const service = createWorkflowService(config, { getToken: async () => 'PRIVATE-TOKEN', fetcher: async (url, options) => {
      if (options.method === 'POST') { dispatches++; const payload = JSON.parse(options.body); assert.equal(payload.ref, 'main'); assert.equal(payload.inputs.request_id, request); throw new Error('lost response'); }
      return new Response(JSON.stringify({ workflow_runs: [{ id: 123, display_title: `testnet / doctor / ${request}`, head_branch: 'main', status: 'completed', conclusion: 'success' }] }));
    } });
    assert.equal((await service.dispatch(n, 'doctor', snapshot.id, request, actor)).status, 'unknown');
    assert.equal((await service.dispatch(n, 'doctor', snapshot.id, request, actor)).status, 'unknown'); assert.equal(dispatches, 1);
    await assert.rejects(() => service.dispatch(n, 'doctor', snapshot.id, randomUUID(), actor), /Reconcile/);
    const records = await service.reconcile('testnet'); assert.equal(records[0].conclusion, 'success'); assert.equal(records[0].runUrl, 'https://github.com/dashpay/dash-network-go/actions/runs/123');
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE-TOKEN/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
