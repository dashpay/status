import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from './collect.js';
import { networkView } from './networks.js';

test('partial observations retain unreachable targets; foreign and failed collection cannot turn green', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-observation-'));
  try {
    const n = { name: 'testnet', public: true, snapshot: join(dir, 'snapshot.json'), health: join(dir, 'health.json'),
      collection: join(dir, 'collection.json'), manifest: 'fixture', sshKey: 'private-fixture', knownHosts: 'trust-fixture' };
    const snapshot = { kind: 'ExistingSnapshot', id: 'a'.repeat(64), observedAt: new Date().toISOString(), fleet: {
      metadata: { name: 'testnet' }, targets: [{ name: 'seed-1', instanceId: 'i-fixture', role: 'seed', containers: {} }] }, nodes: { 'seed-1': { error: 'SSH timeout' } } };
    const runner = async (binary, args) => { assert.equal(args[0], 'managed-import'); writeFileSync(args.at(-1), JSON.stringify(snapshot)); return 1; };
    const partial = await collect({ binary: 'fixture' }, n, runner);
    assert.equal(partial.failed, false); assert.equal(partial.importComplete, false);
    let view = networkView(n, null, {}); assert.equal(view.nodes.length, 1); assert.equal(view.nodes[0].status, 'unknown');
    const retained = readFileSync(n.snapshot, 'utf8');
    snapshot.fleet.metadata.name = 'wrong-network'; await collect({ binary: 'fixture' }, n, runner);
    assert.equal(readFileSync(n.snapshot, 'utf8'), retained);
    view = networkView(n, null, {}); assert.equal(view.status, 'unknown'); assert.equal(view.nodes.length, 1); assert.match(view.notice, /could not be completed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
