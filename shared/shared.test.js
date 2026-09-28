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
