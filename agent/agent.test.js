import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify } from './discover.js';
import { createOps, manifestFor, validateRequest } from './ops.js';
import { gatewayPublicPort } from './collector.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

const settings = structuredClone(DEFAULT_SETTINGS);
const testnet = settings.networks[0];

test('classify maps EC2 Name tags to roles, including suffixed restores and dh- hosts', () => {
  assert.deepEqual(classify('testnet', 'dn-testnet-hp-masternode-1-restore-test-2').name, 'hp-masternode-1');
  assert.equal(classify('testnet', 'dn-testnet-hp-masternode-1').role, 'validator');
  assert.equal(classify('testnet', 'dn-testnet-seed-2').role, 'seed');
  assert.equal(classify('testnet', 'dn-testnet-dashd-wallet-1').name, 'wallet-1');
  assert.equal(classify('testnet', 'dh-testnet-mixer-2').role, 'mixer');
  assert.equal(classify('testnet', 'dn-devnet-moutai-seed-1'), null);
  assert.equal(classify('devnet-moutai', 'dn-devnet-moutai-quorum-list-server-1').role, 'quorums');
  assert.equal(classify('testnet', 'testnet-platform-donor27-restore-20260726'), null);
});

test('gateway public port comes from the dashmate envoy binding', () => {
  assert.equal(gatewayPublicPort({ containers: [{ repo: 'dashpay/envoy', running: true, ports: ['10.0.0.1:9090->9090/tcp', '0.0.0.0:1443->10000/tcp'] }] }), 1443);
  assert.equal(gatewayPublicPort({ containers: [] }), null);
});

const host = (name, role, containers, extra = {}) => ({
  name, role, instanceId: `i-${String(name.length).padStart(17, '0')}${name.slice(-1)}`.slice(0, 19), publicIp: `192.0.2.${name.length}`, arch: 'arm64',
  state: 'running', tagged: true, probe: { ok: true, data: { containers: containers.map(([n, repo, running = true]) => ({ name: n, repo, running })) } }, ...extra,
});

test('manifest includes both seeds and maps dashmate containers; web/wallet are monitored only', () => {
  const state = { hosts: [
    host('hp-masternode-1', 'validator', [['dashmate_testnet-core-1', 'dashpay/dashd'], ['dashmate_testnet-drive_abci-1', 'dashpay/drive'], ['dashmate_testnet-drive_tenderdash-1', 'dashpay/tenderdash'], ['dashmate_testnet-rs_dapi-1', 'dashpay/rs-dapi'], ['dashmate_testnet-gateway-1', 'dashpay/envoy'], ['dashmate_testnet-dashmate_helper-1', 'dashpay/dashmate-helper'], ['old_helper', 'dashpay/dashmate-helper', false]]),
    host('seed-1', 'seed', [['dashd', 'dashpay/dashd'], ['tenderdash', 'dashpay/tenderdash']]),
    host('seed-2', 'seed', [['dashd', 'dashpay/dashd'], ['tenderdash', 'dashpay/tenderdash']]),
    host('masternode-1', 'masternode', [['dashd', 'dashpay/dashd']]),
    host('web-1', 'web', [['insight', 'dashpay/insight']]),
    host('masternode-2', 'masternode', [['dashd', 'dashpay/dashd']], { tagged: false }),
  ] };
  const { manifest, excluded } = manifestFor(settings, testnet, state);
  assert.deepEqual(manifest.targets.map((t) => t.name), ['hp-masternode-1', 'seed-1', 'seed-2', 'masternode-1']);
  assert.equal(manifest.targets[0].containers.helper, 'dashmate_testnet-dashmate_helper-1');
  assert.deepEqual(manifest.targets[1].containers, { core: 'dashd', tenderdash: 'tenderdash' });
  assert.deepEqual(excluded, [{ name: 'masternode-2', reason: 'missing DashNetwork tag' }]);
  assert.equal(manifest.chainType, 'testnet');
});

test('requests are validated against the network and component repositories', () => {
  const id = '6c8139ad-e92f-40da-943d-1e001efaccb5';
  assert.ok(validateRequest(settings, { id, network: 'testnet', action: 'upgrade', nodes: ['seed-2'], components: ['tenderdash'], images: { tenderdash: 'dashpay/tenderdash:1.8.2' } }));
  assert.throws(() => validateRequest(settings, { id, network: 'testnet', action: 'upgrade', nodes: ['seed-2'], components: ['tenderdash'], images: { tenderdash: 'evil/tenderdash:1' } }), /tenderdash: image must be/);
  const withMainnet = { ...settings, networks: [...settings.networks, { name: 'mainnet', displayName: 'Mainnet', tag: 'mainnet-support', chainType: 'mainnet', coreNetwork: 'main', p2pPort: 9999, public: true, deployable: false, showBalances: false, endpoints: [], observationWindow: '4m', operationTimeout: '110m' }] };
  assert.throws(() => validateRequest(withMainnet, { id, network: 'mainnet', action: 'doctor', nodes: ['seed-1'] }), /not deployable/);
  assert.throws(() => validateRequest(settings, { id, network: 'testnet', action: 'deploy', nodes: ['seed-1'], components: ['core'], images: { core: 'dashpay/dashd:23' } }), /only upgrades/);
  assert.throws(() => validateRequest(settings, { id, network: 'testnet', action: 'rm', nodes: ['x'] }), /unsupported/);
});

// Fake dashnet: writes the --out artifact each command would produce.
function fakeDashnet(calls) {
  return (binary, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => {};
    calls.push(args);
    const out = args[args.indexOf('--out') + 1];
    setImmediate(() => {
      const cmd = args[0];
      if (cmd === 'managed-import') writeFileSync(out, JSON.stringify({ id: 'a'.repeat(64), nodes: { 'seed-2': { components: { tenderdash: { image: 'dashpay/tenderdash:1.8.1', digests: ['dashpay/tenderdash@sha256:' + 'b'.repeat(64)] } } } } }));
      if (cmd === 'managed-enroll') { child.stderr.emit('data', 'runner: ' + 'c'.repeat(32) + '\nenrolled seed-2; services unchanged\n'); writeFileSync(out, '{}'); }
      if (cmd === 'managed-plan') writeFileSync(out, JSON.stringify({ id: 'd'.repeat(64), operation: 'upgrade', images: { 'seed-2': { tenderdash: 'index.docker.io/dashpay/tenderdash@sha256:' + 'e'.repeat(64) } } }));
      if (cmd === 'managed-upgrade') child.stderr.emit('data', 'managed-staging\nmanaged-applying\nmanaged target seed-2 applied\nmanaged-verifying\n');
      child.emit('close', cmd === 'managed-operation' ? 1 : 0);
    });
    return child;
  };
}

test('operation lifecycle: request -> enroll -> plan -> review -> confirm -> upgrade', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-'));
  const dirs = { data: root, private: join(root, 'private'), requests: join(root, 'req'), ops: join(root, 'ops'), work: join(root, 'work'), state: join(root, 'state') };
  const calls = [];
  const s = structuredClone(settings);
  const ops = createOps({ settings: () => s, dirs, key: { path: '/key' }, pool: { knownHosts: () => 'x\n', pins: new Proxy({}, { get: () => ({ type: 'ssh-ed25519', key: 'k' }) }) }, binary: 'dashnet', log: () => {}, spawnImpl: fakeDashnet(calls) });
  mkdirSync(dirs.state, { recursive: true });
  writeFileSync(join(dirs.state, 'testnet.json'), JSON.stringify({ hosts: [host('seed-2', 'seed', [['dashd', 'dashpay/dashd'], ['tenderdash', 'dashpay/tenderdash']])] }));
  const id = '6c8139ad-e92f-40da-943d-1e001efaccb5';
  const actor = { id: 9920871, login: 'ktechmidas' };
  writeFileSync(join(dirs.requests, `${id}.json`), JSON.stringify({ type: 'create', id, network: 'testnet', action: 'upgrade', nodes: ['seed-2'], components: ['tenderdash'], images: { tenderdash: 'dashpay/tenderdash:1.8.2' }, actor }));
  const read = () => JSON.parse(readFileSync(join(dirs.ops, `${id}.json`), 'utf8'));
  const until = async (status) => { for (let i = 0; i < 200; i++) { ops.tick(); if (read().status === status) return read(); await new Promise((r) => setTimeout(r, 5)); } throw new Error(`never reached ${status}: ${read().status} ${read().error}`); };
  let r = await until('review');
  assert.equal(r.review.changes.length, 1);
  assert.equal(r.review.changes[0].from, 'dashpay/tenderdash:1.8.1');
  assert.deepEqual(JSON.parse(readFileSync(join(dirs.work, id, '1', 'images.json'), 'utf8')), { tenderdash: 'docker.io/dashpay/tenderdash:1.8.2' });
  assert.ok(calls.some((a) => a[0] === 'managed-enroll' && a.includes('seed-2')));
  // A confirmation for a different plan is ignored.
  writeFileSync(join(dirs.requests, `${id}.confirm-a.json`), JSON.stringify({ type: 'confirm', id, network: 'testnet', planId: 'f'.repeat(64), actor }));
  ops.tick();
  assert.equal(read().status, 'review');
  writeFileSync(join(dirs.requests, `${id}.confirm-b.json`), JSON.stringify({ type: 'confirm', id, network: 'testnet', planId: r.review.planId, actor }));
  r = await until('succeeded');
  assert.deepEqual(r.progress.completed, ['seed-2']);
  const upgrade = calls.find((a) => a[0] === 'managed-upgrade');
  assert.ok(upgrade.includes('d'.repeat(64)) && upgrade.includes('4m') && upgrade.includes('110m'));
  assert.ok(readFileSync(join(dirs.ops, `${id}.log`), 'utf8').includes('managed target seed-2 applied'));
  assert.equal(readdirSync(dirs.requests).length, 0);
});

test('run as soon as ready: the prepared plan is confirmed automatically and executed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-'));
  const dirs = { data: root, private: join(root, 'private'), requests: join(root, 'req'), ops: join(root, 'ops'), work: join(root, 'work'), state: join(root, 'state') };
  const calls = [];
  const ops = createOps({ settings: () => settings, dirs, key: { path: '/key' }, pool: { knownHosts: () => 'x\n', pins: new Proxy({}, { get: () => ({ type: 'ssh-ed25519', key: 'k' }) }) }, binary: 'dashnet', log: () => {}, spawnImpl: fakeDashnet(calls) });
  mkdirSync(dirs.state, { recursive: true });
  writeFileSync(join(dirs.state, 'testnet.json'), JSON.stringify({ hosts: [host('seed-2', 'seed', [['dashd', 'dashpay/dashd'], ['tenderdash', 'dashpay/tenderdash']])] }));
  const id = '8c8139ad-e92f-40da-943d-1e001efaccb5';
  const actor = { id: 9920871, login: 'ktechmidas' };
  writeFileSync(join(dirs.requests, `${id}.json`), JSON.stringify({ type: 'create', id, network: 'testnet', action: 'upgrade', nodes: ['seed-2'], components: ['tenderdash'], images: { tenderdash: 'dashpay/tenderdash:1.8.2' }, options: { autoRun: true }, actor }));
  const read = () => JSON.parse(readFileSync(join(dirs.ops, `${id}.json`), 'utf8'));
  for (let i = 0; i < 300; i++) { ops.tick(); if (existsSync(join(dirs.ops, `${id}.json`)) && ['succeeded', 'failed'].includes(read().status)) break; await new Promise((r) => setTimeout(r, 5)); }
  const r = read();
  assert.equal(r.status, 'succeeded', r.error);
  assert.ok(r.autoConfirmed && r.confirmedBy.login === 'ktechmidas' && r.review.planId, 'plan kept and confirmed on the requester\'s behalf');
  assert.ok(calls.some((a) => a[0] === 'managed-upgrade'));
  assert.match(readFileSync(join(dirs.ops, `${id}.log`), 'utf8'), /confirmed automatically/);
});

test('requests from non-operators are dropped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-'));
  const dirs = { data: root, private: join(root, 'private'), requests: join(root, 'req'), ops: join(root, 'ops'), work: join(root, 'work'), state: join(root, 'state') };
  const ops = createOps({ settings: () => settings, dirs, key: { path: '/key' }, pool: { knownHosts: () => '', pins: {} }, binary: 'dashnet', log: () => {}, spawnImpl: fakeDashnet([]) });
  const id = '7c8139ad-e92f-40da-943d-1e001efaccb5';
  writeFileSync(join(dirs.requests, `${id}.json`), JSON.stringify({ type: 'create', id, network: 'testnet', action: 'doctor', nodes: ['seed-1'], actor: { id: 1, login: 'mallory' } }));
  ops.tick();
  assert.equal(existsSync(join(dirs.ops, `${id}.json`)), false);
});

test('devnet requests: admin-only fields, permanent names, placement from settings', async () => {
  const { validateDevnetRequest, networkYaml, estimate } = await import('./devnets.js');
  const s = structuredClone(settings);
  const q = { id: '6c8139ad-e92f-40da-943d-1e001efaccb5', network: 'devnet-bonsai', action: 'create-devnet', devnet: { validators: 15 } };
  const d = validateDevnetRequest(s, q, {});
  assert.equal(d.validators, 15);
  assert.equal(d.subnetId, s.devnets.subnetId);
  assert.throws(() => validateDevnetRequest(s, { ...q, devnet: { subnetId: 'subnet-evil' } }, {}), /not settable/);
  assert.throws(() => validateDevnetRequest(s, { ...q, network: 'devnet-moutai' }, {}), /already exists/);
  assert.throws(() => validateDevnetRequest(s, q, { 'devnet-bonsai': { status: 'deleted' } }), /already exists/);
  assert.throws(() => validateDevnetRequest(s, { ...q, network: 'bonsai' }, {}), /devnet-<name>/);
  assert.throws(() => validateDevnetRequest(s, { ...q, devnet: { validators: 7 } }, {}), /13..25/);
  assert.throws(() => validateDevnetRequest(s, { ...q, devnet: { images: { drive: 'evil/drive:1' } } }, {}), /images.drive/);
  assert.throws(() => validateDevnetRequest(s, { ...q, devnet: { services: { faucetAmount: '1\nDASH_RPC_HOST=evil' } } }, {}), /faucetAmount/);
  assert.throws(() => validateDevnetRequest(s, { ...q, devnet: { services: { quorumServer: 'evil/image:1' } } }, {}), /quorumServer/);
  assert.throws(() => validateDevnetRequest(s, { ...q, devnet: { services: { explorerVersion: '--orphan=x' } } }, {}), /explorerVersion/);
  assert.throws(() => validateDevnetRequest(s, { ...q, devnet: { services: { dnsZoneId: 'Z1' } } }, {}), /not settable/);
  assert.throws(() => validateDevnetRequest(s, { ...q, devnet: { displayName: '<script>' } }, {}), /display name/);
  assert.equal(validateDevnetRequest(s, { ...q, devnet: { services: { faucetAmount: 25 } } }, {}).services.faucetAmount, 25);
  const yaml = networkYaml(s, 'devnet-bonsai', d, { arm64: 'ami-1', amd64: 'ami-2' });
  assert.match(yaml, /name: devnet-bonsai/);
  assert.match(yaml, /count: 15/);
  assert.match(yaml, /ipamPoolId: ipam-pool-/);
  assert.match(yaml, /drive: docker.io\/dashpay\/drive:/);
  assert.match(yaml, /acme: docker.io\/goacme\/lego:v5/, 'ACME client for trusted gateway certificates');
  assert.doesNotMatch(networkYaml(s, 'devnet-bonsai', { ...d, images: { ...d.images, acme: '' } }, { arm64: 'ami-1', amd64: 'ami-2' }), /acme:/);
  assert.throws(() => validateDevnetRequest(s, { ...q, devnet: { images: { acme: 'evil/lego:1' } } }, {}), /images.acme/);
  assert.ok(estimate(d).hourly > 0.5);
  assert.throws(() => validateRequest(s, { id: q.id, network: 'devnet-bonsai', action: 'delete-devnet', confirmName: 'devnet-bonsai' }, {}), /only devnets created/);
  assert.throws(() => validateRequest(s, { id: q.id, network: 'devnet-bonsai', action: 'delete-devnet', confirmName: 'nope' }, { 'devnet-bonsai': { status: 'ready' } }), /type devnet-bonsai/);
});

test('discovery classifies dash-network-go instances by tag', async () => {
  const { createDiscovery } = await import('./discover.js');
  const tags = (o) => Object.entries(o).map(([Key, Value]) => ({ Key, Value }));
  const client = { send: async () => ({ Reservations: [{ Instances: [
    { InstanceId: 'i-01', State: { Name: 'running' }, Architecture: 'arm64', PublicIpAddress: '68.67.122.90', Tags: tags({ Name: 'devnet-bonsai-validators-001', DashNetwork: 'devnet-bonsai', 'dashnet:managed-by': 'dash-network-go', 'dashnet:network': 'devnet-bonsai', 'dashnet:role': 'validator', 'dashnet:node': 'validators-001' }) },
    { InstanceId: 'i-02', State: { Name: 'running' }, Architecture: 'x86_64', PublicIpAddress: '68.67.122.91', Tags: tags({ Name: 'devnet-bonsai-wallet-001', DashNetwork: 'devnet-bonsai', 'dashnet:managed-by': 'dash-network-go', 'dashnet:network': 'devnet-bonsai', 'dashnet:role': 'wallet', 'dashnet:node': 'wallet-001' }) },
  ] }] }) };
  const found = await createDiscovery({ region: 'us-west-2', tagKey: 'DashNetwork' }, client)([{ name: 'devnet-bonsai', tag: 'devnet-bonsai' }]);
  assert.deepEqual(found['devnet-bonsai'].map((h) => [h.name, h.role, h.arch]), [['validators-001', 'validator', 'arm64'], ['wallet-001', 'wallet', 'amd64']]);
});

test('a truncated DAPI gRPC-web reply fails fast instead of hanging', async () => {
  const { dapiCheck } = await import('./collector.js');
  const http = await import('node:http');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/grpc-web+proto' }); res.end(Buffer.from([0, 0, 0, 0, 10, 0x0a, 8, 8])); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const started = Date.now();
    const r = await dapiCheck(`http://127.0.0.1:${server.address().port}/`, 2000);
    assert.equal(r.ok, false);
    assert.ok(Date.now() - started < 2000);
  } finally { server.close(); }
});

test('cancel during a running operation ends it as cancelled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-'));
  const dirs = { data: root, private: join(root, 'private'), requests: join(root, 'req'), ops: join(root, 'ops'), work: join(root, 'work'), state: join(root, 'state') };
  const slow = (binary, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const t = setTimeout(() => { writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({ id: 'a'.repeat(64), nodes: { 'seed-2': {} } })); child.emit('close', 0); }, 300);
    child.kill = () => { clearTimeout(t); setImmediate(() => child.emit('close', null, 'SIGTERM')); };
    return child;
  };
  const ops = createOps({ settings: () => settings, dirs, key: { path: '/key' }, pool: { knownHosts: () => 'x\n', pins: new Proxy({}, { get: () => ({ type: 'ssh-ed25519', key: 'k' }) }) }, binary: 'dashnet', log: () => {}, spawnImpl: slow });
  mkdirSync(dirs.state, { recursive: true });
  writeFileSync(join(dirs.state, 'testnet.json'), JSON.stringify({ hosts: [host('seed-2', 'seed', [['dashd', 'dashpay/dashd'], ['tenderdash', 'dashpay/tenderdash']])] }));
  const id = '8c8139ad-e92f-40da-943d-1e001efaccb5', actor = { id: 9920871, login: 'ktechmidas' };
  writeFileSync(join(dirs.requests, `${id}.json`), JSON.stringify({ type: 'create', id, network: 'testnet', action: 'doctor', nodes: ['seed-2'], actor }));
  const read = () => JSON.parse(readFileSync(join(dirs.ops, `${id}.json`), 'utf8'));
  ops.tick();
  for (let i = 0; i < 100 && read().status !== 'preparing'; i++) { ops.tick(); await new Promise((r) => setTimeout(r, 5)); }
  writeFileSync(join(dirs.requests, `${id}.cancel-a.json`), JSON.stringify({ type: 'cancel', id, network: 'testnet', actor }));
  ops.tick();
  for (let i = 0; i < 200 && !['cancelled', 'failed', 'succeeded'].includes(read().status); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(read().status, 'cancelled');
});

test('platform reset: review from non-destructive stages; a failed wipe stops before apply', async () => {
  const { createReset } = await import('./reset.js');
  const root = mkdtempSync(join(tmpdir(), 'reset-'));
  const dirs = { private: join(root, 'p'), state: join(root, 'state') };
  mkdirSync(dirs.state, { recursive: true });
  const mk = (name, role) => ({ name, role, state: 'running', publicIp: `192.0.2.${name.length}`, instanceId: `i-${name}`, probe: { ok: true } });
  writeFileSync(join(dirs.state, 'devnet-moutai.json'), JSON.stringify({ hosts: [mk('hp-masternode-1', 'validator'), mk('hp-masternode-2', 'validator'), mk('seed-1', 'seed'), mk('web-1', 'web')] }));
  const calls = [];
  let failWipeOn = 'hp-masternode-2';
  const pool = { exec: async (h, cmd) => {
    const stage = cmd.split(' ')[4];
    calls.push(`${stage}:${h.name}`);
    const result = { baseline: { images: { drive: 'dashpay/drive:1' }, anchor: 10, epochTime: 3600, dashmate: 'dm', configFormatVersion: '4.2.0', tor: { enabled: false }, height: 100, tenderdashImage: 'dashpay/tenderdash:1' },
      anchor: { height: 99, hash: 'ab' }, canary: { checks: { epochTime: 3600, epochEnv: '3600', coreSectionUnchanged: true, anchor: 99 }, rendered: ['dynamic-compose.yml'] } }[stage] || {};
    const ok = !(stage === 'wipe' && h.name === failWipeOn);
    return JSON.stringify({ ok, stage, result, error: ok ? undefined : 'boom' });
  } };
  const records = [];
  const r = { id: 'x1', network: 'devnet-moutai', steps: [], request: { network: 'devnet-moutai', images: { drive: 'dashpay/drive:2', dapi: 'dashpay/rs-dapi:2', tenderdash: 'dashpay/tenderdash:2' }, options: {} } };
  const ctx = { step: () => () => {}, save: (x) => records.push(x.status), write: () => {} };
  const reset = createReset({ ctx, dirs, pool, getSettings: () => settings });
  await reset.prepareReset(r);
  assert.equal(r.review.hpmns, 2);
  assert.equal(r.review.seeds, 1);
  assert.equal(r.review.anchor.height, 99);
  assert.ok(!calls.some((c) => c.includes('web-1')), 'web hosts are never targets');
  assert.ok(calls.includes('canary:hp-masternode-1') && !calls.some((c) => /^(wipe|apply|start)/.test(c)), 'prepare is non-destructive');
  await assert.rejects(reset.executeReset(r), /wipe failed on hp-masternode-2/);
  assert.ok(!calls.some((c) => /^(apply|start)/.test(c)), 'nothing applied after a failed wipe');
  assert.ok(!calls.includes('wipe:seed-1'), 'seed is reset only after every HPMN wiped');
  failWipeOn = null;
  await reset.executeReset(r);
  assert.equal(calls.filter((c) => c === 'wipe:hp-masternode-1').length, 1, 'successful targets are not wiped twice on resume');
  assert.ok(calls.includes('verify:seed-1') && r.result.healthy === true);
  // Per-host results are recorded as each host finishes.
  assert.ok(r.stages.start['hp-masternode-2'].ok && r.stages.verify['seed-1'].ok);
});

test('a devnet Core + Platform upgrade runs Core first, then plans and runs Platform from the result', async () => {
  const { createDevnets } = await import('./devnets.js');
  const root = mkdtempSync(join(tmpdir(), 'dn-'));
  const dirs = { data: root, private: join(root, 'p'), state: join(root, 'state') };
  const dir = join(dirs.private, 'devnets', 'devnet-x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'deployment.json'), '{}');
  writeFileSync(join(dir, 'network.yaml'), 'images:\n  core: docker.io/dashpay/dashd:23.1.7\n  drive: docker.io/dashpay/drive:4.2.0-beta.5\n');
  writeFileSync(join(dir, 'dashnet'), '#!/bin/sh\n', { mode: 0o755 });
  const calls = [];
  const dashnet = async (r, args, opts) => {
    assert.equal(opts.bin, r.artifacts.bin, 'every upgrade call uses the planning binary snapshot');
    calls.push([args[0], args.includes('--scope') ? args[args.indexOf('--scope') + 1] : '']);
    const out = args[args.indexOf('--out') + 1];
    if (args[0] === 'resolve') writeFileSync(out, '{}');
    if (args[0] === 'upgrade-plan') {
      const scope = args[args.indexOf('--scope') + 1];
      const candidate = readFileSync(args[args.indexOf('--network') + 1], 'utf8');
      // Platform is planned from the network file that already carries the new Core.
      if (scope === 'platform') assert.match(candidate, /dashd:23\.1\.8/);
      writeFileSync(out, JSON.stringify({ id: `${scope}`.padEnd(64, '0'), scope, from: { v: { core: 'a', drive: 'a' } }, to: { v: { core: scope === 'core' ? 'b' : 'a', drive: scope === 'core' ? 'a' : 'b' } } }));
    }
    return 0;
  };
  const r = { id: 'u1', network: 'devnet-x', steps: [], actor: { login: 'k' }, request: { components: ['core', 'drive'], images: { core: 'dashpay/dashd:23.1.8', drive: 'dashpay/drive:4.2.0-beta.6' } } };
  const d = createDevnets({ ctx: { dashnet, step: () => () => {}, save: () => {}, write: () => {}, pinBinary: () => 'dashnet' }, dirs, key: { path: '/k' }, pool: {}, getSettings: () => settings, region: 'us-west-2', log: () => {} });
  await d.prepareUpgrade(r);
  assert.equal(r.review.scope, 'core + platform');
  assert.equal(r.review.changes[0].component, 'core', 'the reviewed plan is the Core rollout');
  assert.deepEqual(r.review.then[0].images, { drive: 'dashpay/drive:4.2.0-beta.6' });
  await d.executeUpgrade(r);
  assert.deepEqual(calls.map((c) => c.join(':')), ['resolve:', 'upgrade-plan:core', 'upgrade:', 'resolve:', 'upgrade-plan:platform', 'upgrade:']);
  const current = readFileSync(join(dir, 'network-current.yaml'), 'utf8');
  assert.match(current, /dashd:23\.1\.8/);
  assert.match(current, /drive:4\.2\.0-beta\.6/);
  // A resumed operation does not repeat a finished phase.
  await d.executeUpgrade(r);
  assert.equal(calls.filter((c) => c[0] === 'upgrade').length, 2);
});

test('a devnet moves to a newer dashnet only when its plans bind the same node and bootstrap recipes', async () => {
  const { createDevnets } = await import('./devnets.js');
  const root = mkdtempSync(join(tmpdir(), 'pin-'));
  const dirs = { data: root, private: join(root, 'p'), state: join(root, 'state') };
  const dir = join(dirs.private, 'devnets', 'devnet-x');
  mkdirSync(dir, { recursive: true });
  const fake = (version, node) => `#!/bin/sh\ncase "$1" in version) echo ${version};; recipes) echo '{"node":"${node}","bootstrap":"b"}';; upgrade-plan) echo 'or core (Core only, every node)' >&2;; *) exit 0;; esac\n`;
  const V = (date, c) => `${date}-${c.repeat(40)}`;
  writeFileSync(join(dir, 'dashnet'), fake(V('20260928T120000Z', 'a'), 'n1'), { mode: 0o755 });
  writeFileSync(join(root, 'current'), fake(V('20260928T190000Z', 'b'), 'n1'), { mode: 0o755 });
  writeFileSync(join(dir, 'deployment.json'), JSON.stringify({ recipeSha256: 'n1' }));
  writeFileSync(join(dir, 'bootstrap-plan.json'), JSON.stringify({ recipeSha256: 'b' }));
  writeFileSync(join(root, 'devnets.json'), JSON.stringify({ 'devnet-x': { status: 'ready' } }));
  const logs = [];
  const d = createDevnets({ ctx: { dashnet: async () => 0, step: () => () => {}, save: () => {}, write: (id, l) => logs.push(l), pinBinary: () => join(dir, 'dashnet'), binary: join(root, 'current') }, dirs, key: { path: '/k' }, pool: {}, getSettings: () => settings, region: 'us-west-2', log: () => {} });
  const r = { id: 'd1', network: 'devnet-x', steps: [] };
  await d.doctor(r).catch(() => {});
  assert.match(readFileSync(join(dir, 'dashnet'), 'utf8'), /20260928T190000Z/, 'compatible newer binary adopted');
  assert.ok(logs.some((l) => /dashnet 20260928T120 -> 20260928T190/.test(l)));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'devnets.json'), 'utf8'))['devnet-x'].upgradeScopes, ['platform', 'tenderdash', 'core']);
  // A different node recipe means the new binary would refuse the plan: keep the pin.
  writeFileSync(join(dir, 'dashnet'), fake(V('20260928T120000Z', 'a'), 'n1'), { mode: 0o755 });
  writeFileSync(join(root, 'current'), fake(V('20260929T000000Z', 'c'), 'n2'), { mode: 0o755 });
  await d.doctor(r).catch(() => {});
  assert.match(readFileSync(join(dir, 'dashnet'), 'utf8'), /20260928T120000Z/, 'incompatible binary not adopted');
  // An older build (agent rollback) never replaces a newer pin.
  writeFileSync(join(root, 'current'), fake(V('20260927T000000Z', 'd'), 'n1'), { mode: 0o755 });
  await d.doctor(r).catch(() => {});
  assert.match(readFileSync(join(dir, 'dashnet'), 'utf8'), /20260928T120000Z/, 'no downgrade');
});

test('a resumed upgrade moves to a newer dashnet only when the reviewed plan still accepts it', async () => {
  const { createDevnets } = await import('./devnets.js');
  const root = mkdtempSync(join(tmpdir(), 'snap-'));
  const dirs = { data: root, private: join(root, 'p'), state: join(root, 'state') };
  const dir = join(dirs.private, 'devnets', 'devnet-x');
  mkdirSync(dir, { recursive: true });
  const fake = (version, upgrade) => `#!/bin/sh\ncase "$1" in version) echo ${version};; recipes) echo '{"node":"n1","bootstrap":"b","upgrade":"${upgrade}"}';; *) exit 0;; esac\n`;
  const V = (date, c) => `${date}-${c.repeat(40)}`;
  writeFileSync(join(dir, 'deployment.json'), JSON.stringify({ recipeSha256: 'n1' }));
  writeFileSync(join(dir, 'network.yaml'), 'images:\n  core: docker.io/dashpay/dashd:23.1.7\n');
  writeFileSync(join(dir, 'upgrade-0.json'), JSON.stringify({ id: 'p'.repeat(64), scope: 'core', recipeSha256: 'u1', from: {}, to: {} }));
  writeFileSync(join(dir, 'candidate-0.yaml'), 'images:\n  core: docker.io/dashpay/dashd:23.1.8\n');
  const snap = join(dir, 'dashnet.upgrade-t');
  writeFileSync(snap, fake(V('20260928T120000Z', 'a'), 'u1'), { mode: 0o755 });
  const binary = join(root, 'current');
  const used = [];
  const d = createDevnets({ ctx: { dashnet: async (r, args, opts) => { used.push(readFileSync(opts.bin, 'utf8')); return 0; }, step: () => () => {}, save: () => {}, write: () => {}, pinBinary: () => snap, binary }, dirs, key: { path: '/k' }, pool: {}, getSettings: () => settings, region: 'us-west-2', log: () => {} });
  const r = () => ({ id: 'u', network: 'devnet-x', steps: [], review: { planId: 'p'.repeat(64) }, artifacts: { ts: 't', bin: snap, phases: [{ scope: 'core', components: ['core'], plan: 'upgrade-0.json', planId: 'p'.repeat(64), candidate: 'candidate-0.yaml' }] }, request: { components: ['core'], images: {} } });
  // A newer build with a different upgrade recipe would be refused by the plan: keep the snapshot.
  writeFileSync(binary, fake(V('20260929T000000Z', 'b'), 'u2'), { mode: 0o755 });
  await d.executeUpgrade(r());
  assert.match(used.pop(), /20260928T120000Z/);
  // Same upgrade and node recipes, newer build: the resume uses it.
  writeFileSync(binary, fake(V('20260929T000000Z', 'b'), 'u1'), { mode: 0o755 });
  await d.executeUpgrade(r());
  assert.match(used.pop(), /20260929T000000Z/);
});

test('service images are prebuilt on the wallet host without the chain, best effort', async () => {
  const { prebuildServices } = await import('./services.js');
  const dplan = { coreNetwork: 'console-9-g1', platformChainId: 'dash-devnet-console-9', ports: {},
    targets: [{ name: 'wallet-001', role: 'wallet', instanceId: 'i-0aaaaaaaaaaaaaaa1', sshAddress: '198.51.100.9' },
      { name: 'validators-001', role: 'validator', instanceId: 'i-0aaaaaaaaaaaaaaa2', sshAddress: '198.51.100.10', peerAddress: '198.51.100.10', privateAddress: '10.0.0.10' }] };
  const d = { displayName: 'Console 9', dnsSuffix: 'networks.dash.org', services: { quorumServer: 'dashpay/quorum-list-server:0.7.0', insightImage: 'dashpay/insight:4.0.10', explorerVersion: '2.5.3', faucetRef: 'b'.repeat(40) } };
  const lines = [], calls = [];
  const pool = { exec: async (h, cmd) => {
    calls.push([h.name, cmd]);
    const run = cmd.match(/python3 \/opt\/devnet-services\/services\.py (\S+)/);
    if (!run) return '';
    const cfg = JSON.parse(Buffer.from(run[1], 'base64').toString());
    assert.equal(cfg.prebuildOnly, true);
    assert.equal(cfg.hosts.explorer, 'explorer.console-9.networks.dash.org');
    return JSON.stringify({ faucetImage: 'devnet-faucet:x', frontendImage: 'devnet-explorer-frontend:y', pulled: 6 });
  } };
  await prebuildServices({ r: { id: 'op' }, write: (_, l) => lines.push(l), dplan, d, name: 'devnet-console-9', pool });
  assert.ok(calls.every(([n]) => n === 'wallet-001'), 'only the wallet host');
  assert.match(lines.at(-1), /built devnet-faucet:x and devnet-explorer-frontend:y, pulled 6 images/);
  const failing = { exec: async () => { throw new Error('ssh: connection reset'); } };
  await prebuildServices({ r: { id: 'op' }, write: (_, l) => lines.push(l), dplan, d, name: 'devnet-console-9', pool: failing });
  assert.match(lines.at(-1), /connection reset; the install builds them instead/);
});
