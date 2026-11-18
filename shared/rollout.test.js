import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedRollout, rolloutArgs, rolloutFor, trackRollout } from './rollout.js';
import { manifestFor, validateRequest } from '../agent/ops.js';
import { DEFAULT_SETTINGS } from './settings.js';

test('rollout input validation and exact plan binding', () => {
  assert.equal(rolloutFor({ action: 'upgrade' }), null);
  for (const concurrency of [0, 17, 1.5, '2', null]) assert.throws(() => rolloutFor({ action: 'upgrade', options: { concurrency } }));
  assert.throws(() => rolloutFor({ action: 'doctor', options: { concurrency: 2 } }));
  assert.throws(() => rolloutFor({ action: 'upgrade', options: { pauseMining: 'yes' } }));
  const r = rolloutFor({ action: 'upgrade', options: { concurrency: 3, pauseMining: true } });
  assert.deepEqual(rolloutArgs(r, ['miner-1', 'miner-2']), ['--concurrency', '3', '--pause-mining', '--miners', 'miner-1,miner-2']);
  const plan = { rollout: { ...r, miners: ['miner-1', 'miner-2'] } };
  assert.equal(reviewedRollout(plan, r, plan.rollout.miners).resumeMining, 'automatic');
  for (const bad of [{}, { rollout: { ...plan.rollout, concurrency: 1 } }, { rollout: { ...plan.rollout, miners: ['miner-1'] } }]) assert.throws(() => reviewedRollout(bad, r, plan.rollout.miners));
  assert.equal(reviewedRollout({ rollout: { concurrency: 1 } }, { concurrency: 1, pauseMining: false }, []).pauseMining, false);
});

test('progress keeps every concurrent node until its own verified completion', () => {
  for (const native of [false, true]) {
    const p = { completed: [] };
    const line = (name, done) => native ? `upgrade ${name} ${done ? 'verified; whole fleet healthy' : 'applying'}` : `managed target ${name} ${done ? 'applied' : 'applying'}`;
    trackRollout(p, line('node-1', false), native); trackRollout(p, line('node-2', false), native);
    assert.deepEqual(p.active, ['node-1', 'node-2']);
    trackRollout(p, line('node-1', true), native); trackRollout(p, line('node-1', true), native);
    assert.deepEqual(p.active, ['node-2']); assert.deepEqual(p.completed, ['node-1']);
    trackRollout(p, line('node-2', true), native); assert.equal(p.current, null);
  }
});

test('legacy mining inventory includes only exact owned Testnet miners', () => {
  const settings = structuredClone(DEFAULT_SETTINGS), network = settings.networks.find((n) => n.name === 'testnet');
  const h = (name, extra = {}) => ({ name, role: 'miner', tagged: true, state: 'running', publicIp: '192.0.2.1', instanceId: 'i-123', arch: 'amd64', probe: { data: { containers: [{ name: 'dashd', repo: 'dashpay/dashd', running: true }] } }, ...extra });
  const state = { hosts: [h('miner-1'), h('miner-2'), h('miner-3'), h('miner-1', { duplicate: true })] };
  const { manifest } = manifestFor(settings, network, state);
  assert.deepEqual(manifest.targets.map((t) => [t.name, t.role, t.miningService]), [['miner-1', 'core', 'dashd-generate-miner.service'], ['miner-2', 'core', 'dashd-generate-miner.service']]);
  assert.equal(manifestFor(settings, { ...network, chainType: 'devnet' }, state).manifest.targets.length, 0);
  const q = { id: '6c8139ad-e92f-40da-943d-1e001efaccb5', network: 'testnet', action: 'upgrade', nodes: ['masternode-1'], components: ['core'], images: { core: 'dashpay/dashd:24.0.2' }, options: { concurrency: 4, pauseMining: true } };
  assert.equal(validateRequest(settings, q).rollout.concurrency, 4);
});
