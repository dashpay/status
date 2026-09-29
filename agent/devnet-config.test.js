import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigWriter, devnetFacts } from './devnet-config.js';
import { devnetFiles } from '../shared/devnet-files.js';

const plan = {
  coreNetwork: 'fixture-g1', platformChainId: 'dash-devnet-fixture-g1', genesisTime: '2026-09-29T16:53:39Z', initialProtocolVersion: 14,
  miningIntervalSeconds: 10, premineHeight: 4032, platformEpochSeconds: 3600, gatewayTls: { issuer: 'letsencrypt' },
  targets: [
    { name: 'validators-001', role: 'validator', architecture: 'arm64', instanceId: 'i-0000000000000001', sshAddress: '198.51.100.1', peerAddress: '198.51.100.1', privateAddress: '10.42.0.1' },
    { name: 'validators-002', role: 'validator', architecture: 'arm64', instanceId: 'i-0000000000000002', sshAddress: '198.51.100.2', peerAddress: '198.51.100.2', privateAddress: '10.42.0.2' },
    { name: 'wallet-001', role: 'wallet', architecture: 'amd64', instanceId: 'i-0000000000000003', sshAddress: '198.51.100.3', peerAddress: '198.51.100.3', privateAddress: '10.42.0.3' },
  ],
};
const record = { deployment: { sporkAddress: 'yW9FNATqCFwrN3rrF6FNXy8seZK7v7RAXi', genesisCoreHeight: 4245, coreGenesis: 'ab'.repeat(32),
  nodes: { 'validators-001': { proTxHash: '33'.repeat(32), operatorPublicKey: 'cd'.repeat(48), platformNodeId: 'dd'.repeat(20) } } } };
const lock = { images: [{ component: 'drive', requested: 'docker.io/dashpay/drive:4.2.0-beta.7', pinned: 'index.docker.io/dashpay/drive@sha256:' + 'f'.repeat(64) }] };
const reg = { displayName: 'Fixture', walletAddress: 'yLNcvdRAjZiCa6BVp5KbBgQBt6nEDBugSA', dns: { faucet: { url: 'https://faucet.fixture.networks.dash.org/' } } };

test('connection facts and files follow the legacy dash-network-configs outputs', () => {
  const f = devnetFacts({ name: 'devnet-fixture', reg, plan, record, lock });
  assert.equal(f.core.chain, 'devnet-fixture-g1');
  assert.deepEqual(f.core.seeds, ['198.51.100.3:20001', '198.51.100.1:20001', '198.51.100.2:20001']);
  assert.deepEqual(f.platform.dapi, ['https://198.51.100.1:1443', 'https://198.51.100.2:1443']);
  const [conf, inventory, yml] = devnetFiles(f);
  assert.equal(conf.name, 'devnet-fixture.conf');
  for (const line of ['devnet=fixture-g1', '[devnet]', 'llmqplatform=llmq_devnet_platform', 'powtargetspacing=10', 'minimumdifficultyblocks=1000000',
    'sporkaddr=yW9FNATqCFwrN3rrF6FNXy8seZK7v7RAXi', 'port=20001', 'addnode=198.51.100.3:20001']) assert.ok(conf.text.split('\n').includes(line), line);
  assert.match(inventory.text, /^validators-001 public_ip=198\.51\.100\.1 private_ip=10\.42\.0\.1 instance_id=i-0000000000000001 arch=arm64 protx=3{64} node_id=d{40}$/m);
  assert.match(inventory.text, /\[hp_masternodes\]\nvalidators-001\nvalidators-002\n/);
  assert.match(yml.text, /epoch_time: 3600/);
  assert.match(yml.text, /validator_set_quorum:\n {4}llmqType: 107/);
  assert.match(yml.text, /drive:\n {4}requested: "docker\.io\/dashpay\/drive:4\.2\.0-beta\.7"/);
  assert.match(yml.text, /faucet_address: "yLNcvdRAjZiCa6BVp5KbBgQBt6nEDBugSA"/);
  assert.ok(!/private|secret|password/i.test(yml.text.replace('private keys stay on the hosts', '')), 'no secrets in the files');
});

test('the agent writes facts for live console devnets and rewrites them when the sources change', () => {
  const root = mkdtempSync(join(tmpdir(), 'devnet-config-'));
  const privateDir = join(root, 'private'), dataDir = join(root, 'data'), work = join(privateDir, 'devnets', 'devnet-fixture');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'deployment.json'), JSON.stringify(plan));
  writeFileSync(join(work, 'deployed.2026-09-29T16-53-39-092Z.json'), JSON.stringify({ deployment: { ...record.deployment, sporkAddress: 'yOld' } }));
  writeFileSync(join(work, 'deployed.2026-09-29T17-00-53-089Z.json'), JSON.stringify(record));
  writeFileSync(join(work, 'lock.json'), JSON.stringify(lock));
  const registry = { 'devnet-fixture': { status: 'ready', ...reg }, 'devnet-gone': { status: 'deleted' }, 'devnet-early': { status: 'creating' } };
  const refresh = createConfigWriter({ privateDir, dataDir, registry: () => registry });
  refresh();
  const out = join(dataDir, 'devnets', 'devnet-fixture', 'config.json');
  const first = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(first.core.sporkAddress, 'yW9FNATqCFwrN3rrF6FNXy8seZK7v7RAXi', 'newest deployment record');
  const at = statSync(out).mtimeMs;
  refresh();
  assert.equal(statSync(out).mtimeMs, at, 'unchanged sources are not rewritten');
  writeFileSync(join(work, 'deployment.json'), JSON.stringify({ ...plan, platformEpochSeconds: 600 }));
  utimesSync(join(work, 'deployment.json'), new Date(), new Date(Date.now() + 5000));
  refresh();
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).platform.epochSeconds, 600);
});
