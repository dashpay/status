import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, validateSettings, operatorFor } from './settings.js';
import { evaluateNetwork, projectNetwork, tagOf } from './evaluate.js';

const settings = structuredClone(DEFAULT_SETTINGS);
const network = settings.networks[0];

test('default settings validate; bad edits are rejected with a reason', () => {
  assert.ok(validateSettings(settings));
  const bad = structuredClone(settings);
  bad.networks[2].deployable = true;
  assert.throws(() => validateSettings(bad), /mainnet workloads are not deployable/);
  const url = structuredClone(settings);
  url.networks[0].endpoints.push({ label: 'x', url: 'http://user:pw@example.com' });
  assert.throws(() => validateSettings(url), /credential-free https/);
  assert.equal(operatorFor(settings, { id: 9920871 }, 'testnet'), true);
  assert.equal(operatorFor(settings, { id: 1 }, 'testnet'), false);
});

test('tagOf reads tags and short digests', () => {
  assert.equal(tagOf('dashpay/drive:4.2.0-beta.5'), '4.2.0-beta.5');
  assert.equal(tagOf('dashpay/drive@sha256:ed5085edd04bc4da6107dfe1b9f5ae16888532de5950f32d410c90af1b224da3'), '@ed5085edd04b');
});

const evo = (name, extra = {}) => ({
  name, role: 'validator', state: 'running', publicIp: '192.0.2.1', instanceId: 'i-1', privateIp: '10.0.0.1',
  probe: { ok: true, at: new Date().toISOString(), data: {
    core: { chain: 'test', blocks: 100, chainLockHeight: 100, synced: true, masternode: { state: 'READY', posePenalty: 0 } },
    tenderdash: { height: 50, network: 'dash-testnet-51' }, dapi: { ok: true },
    containers: [{ name: 'core', repo: 'dashpay/dashd', image: 'dashpay/dashd:23', running: true }], system: { disks: [{ mount: '/', used: 10, size: 100 }], memTotal: 100, memAvailable: 50 },
    ...extra } },
});

test('evaluation gives a level with concrete reasons, and orphan containers are informational', () => {
  const lagging = evo('b', { core: { chain: 'test', blocks: 90, masternode: { state: 'READY', posePenalty: 12 } } });
  const orphan = evo('c', { containers: [{ name: 'core', repo: 'dashpay/dashd', image: 'dashpay/dashd:23', running: true }, { name: 'old', repo: 'dashpay/dashd', image: 'dashpay/dashd:22', running: false, state: 'exited', exitCode: 1 }] });
  const e = evaluateNetwork(network, { hosts: [evo('a'), lagging, orphan, { name: 'd', role: 'seed', state: 'running', publicIp: '192.0.2.4', probe: { ok: false, error: 'connect ETIMEDOUT' } }] }, settings);
  const [a, b, c, d] = e.rows;
  assert.equal(a.level, 'ok');
  assert.equal(b.level, 'warn');
  assert.deepEqual(b.reasons.map((r) => r.text), ['Core 10 blocks behind tip', 'PoSe penalty 12']);
  assert.equal(c.level, 'ok');
  assert.equal(c.reasons[0].level, 'info');
  assert.equal(d.level, 'unreachable');
  assert.equal(e.summary.core.height, 100);
  const pub = projectNetwork(network, e, { hosts: [] }, false);
  assert.equal(pub.hosts[0].instanceId, undefined);
  assert.equal(pub.hosts[3].reasons[0].text, 'host not reachable by status agent');
  const op = projectNetwork(network, e, { hosts: [] }, true);
  assert.equal(op.hosts[0].instanceId, 'i-1');
  assert.match(op.hosts[3].reasons[0].text, /ETIMEDOUT/);
});

test('roles: admins cover everything, viewers never operate, one admin must remain', async () => {
  const { memberOf, adminFor } = await import('./settings.js');
  const s = structuredClone(settings);
  s.operators.push({ id: 5, login: 'v', role: 'viewer', networks: ['devnet-moutai'] }, { id: 6, login: 'o', role: 'operator', networks: ['testnet'] });
  const v = validateSettings(s);
  assert.equal(memberOf(v, { id: 5 }, 'devnet-moutai'), true);
  assert.equal(operatorFor(v, { id: 5 }, 'devnet-moutai'), false);
  assert.equal(operatorFor(v, { id: 6 }, 'testnet'), true);
  assert.equal(operatorFor(v, { id: 6 }, 'devnet-moutai'), false);
  assert.equal(adminFor(v, { id: 9920871 }), true);
  assert.equal(adminFor(v, { id: 6 }), false);
  s.operators = [{ id: 5, login: 'v', role: 'viewer', networks: ['testnet'] }];
  assert.throws(() => validateSettings(s), /At least one admin/);
  s.operators = [{ id: 1, login: 'a', networks: ['*'] }, { id: 1, login: 'a', networks: ['*'] }];
  assert.throws(() => validateSettings(s), /listed twice/);
});

test('console devnets merge into settings and deleted ones drop out', async () => {
  const { mergeDevnets } = await import('./settings.js');
  const s = structuredClone(settings);
  const merged = mergeDevnets(s, { 'devnet-bonsai': { status: 'ready', displayName: 'Bonsai', coreNetwork: 'devnet-bonsai-g1', dns: { quorums: { host: 'quorums.bonsai.networks.dash.org' } } } });
  const n = merged.networks.find((x) => x.name === 'devnet-bonsai');
  assert.equal(n.kind, 'dashnet');
  assert.equal(n.coreNetwork, 'devnet-bonsai-g1');
  // dashnet plans name the chain without the devnet- prefix Core reports.
  assert.equal(mergeDevnets(structuredClone(settings), { 'devnet-bonsai': { status: 'ready', coreNetwork: 'bonsai-g1' } }).networks.find((x) => x.name === 'devnet-bonsai').coreNetwork, 'devnet-bonsai-g1');
  assert.equal(n.endpoints[0].url, 'https://quorums.bonsai.networks.dash.org/health');
  assert.ok(validateSettings(merged));
  const gone = mergeDevnets(structuredClone(merged), { 'devnet-bonsai': { status: 'deleted' } });
  assert.equal(gone.networks.some((x) => x.name === 'devnet-bonsai'), false);
});

test('saving settings never freezes console devnet entries', async () => {
  const { mergeDevnets, saveSettings } = await import('./settings.js');
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  const registry = { 'devnet-bonsai': { status: 'creating', coreNetwork: 'devnet-bonsai-g1' } };
  writeFileSync(join(dir, 'devnets.json'), JSON.stringify(registry));
  const saved = saveSettings(join(dir, 'settings.json'), mergeDevnets(structuredClone(settings), registry));
  assert.ok(saved.networks.some((n) => n.name === 'devnet-bonsai'), 'still merged in memory');
  assert.ok(!JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).networks.some((n) => n.name === 'devnet-bonsai'), 'not written to settings.json');
});

test('hidden balances never reach the public projection', () => {
  const s = structuredClone(settings);
  const n = { ...s.networks[2], showBalances: false };
  const host = { name: 'wallet-1', role: 'wallet', state: 'running', publicIp: '192.0.2.9', probe: { ok: true, at: new Date().toISOString(), data: {
    core: { chain: 'main', blocks: 10, wallets: [{ name: 'dashd-wallet-1-faucet', trusted: 12.34 }] }, faucet: { kind: 'dash-faucet', status: 503, state: 'low_balance', balance: 12.34, utxos: 3 }, containers: [] } } };
  const e = evaluateNetwork(n, { hosts: [host] }, s);
  const pub = JSON.stringify(projectNetwork(n, e, { hosts: [host] }, false));
  assert.ok(!pub.includes('12.34'), pub);
  assert.ok(pub.includes('balance below threshold'));
});

test('a validator without Tenderdash RPC is down, not merely behind', () => {
  const e = evaluateNetwork(network, { hosts: [evo('a'), evo('b', { tenderdash: null })] }, settings);
  assert.equal(e.rows[1].level, 'down');
});
