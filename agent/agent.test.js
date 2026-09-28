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
  assert.throws(() => validateRequest(settings, { id, network: 'mainnet', action: 'doctor', nodes: ['seed-1'] }), /not deployable/);
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
  const dirs = { requests: join(root, 'req'), ops: join(root, 'ops'), work: join(root, 'work'), state: join(root, 'state') };
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

test('requests from non-operators are dropped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-'));
  const dirs = { requests: join(root, 'req'), ops: join(root, 'ops'), work: join(root, 'work'), state: join(root, 'state') };
  const ops = createOps({ settings: () => settings, dirs, key: { path: '/key' }, pool: { knownHosts: () => '', pins: {} }, binary: 'dashnet', log: () => {}, spawnImpl: fakeDashnet([]) });
  const id = '7c8139ad-e92f-40da-943d-1e001efaccb5';
  writeFileSync(join(dirs.requests, `${id}.json`), JSON.stringify({ type: 'create', id, network: 'testnet', action: 'doctor', nodes: ['seed-1'], actor: { id: 1, login: 'mallory' } }));
  ops.tick();
  assert.equal(existsSync(join(dirs.ops, `${id}.json`)), false);
});
