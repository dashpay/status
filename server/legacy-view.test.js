import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supplementLegacy } from './legacy-view.js';
import { networkView } from './networks.js';

test('legacy supplement retains fixed targets, validates identity and age, and cannot claim managed health', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-legacy-'));
  try {
    const now = Date.now();
    const n = { name: 'testnet', legacySnapshot: join(dir, 'legacy.json'), legacyTargets: [
      { name: 'hp-masternode-1', type: 'hp', host: 'PRIVATE-ONE' },
      { name: 'masternode-1', type: 'mn', host: 'PRIVATE-TWO' },
      { name: 'masternode-2', type: 'mn', host: 'PRIVATE-THREE' }] };
    const source = { kind: 'LegacyStatusObservation', network: 'testnet', observedAt: new Date(now).toISOString(), nodes: [
      { name: 'masternode-1', type: 'mn', host: 'PRIVATE-TWO', lastUpdated: now, health: 'healthy', status: { coreHeight: 100, coreServiceStatus: 'up' } }] };
    const save = () => writeFileSync(n.legacySnapshot, JSON.stringify(source)); save();
    const baseline = { status: 'unknown', nodes: [{ name: 'hp-masternode-1', status: 'unknown', services: [] }], notice: 'Managed health unavailable' };
    let result = supplementLegacy(n, baseline, now, false);
    assert.equal(result.expectedNodes, 3); assert.equal(result.status, 'unknown');
    assert.equal(result.nodes[1].status, 'observed'); assert.equal(result.nodes[2].status, 'unknown');
    assert.equal(result.nodes[1].dapi, 'not-applicable'); assert.equal(result.nodes[1].services[0].restarts, null);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|address|host/);
    source.nodes[0].host = 'FOREIGN'; save(); assert.equal(supplementLegacy(n, baseline, now, false).nodes[1].status, 'unknown');
    source.nodes[0].host = 'PRIVATE-TWO'; source.nodes[0].lastUpdated = now - 200_000; save();
    assert.equal(supplementLegacy(n, baseline, now, false).nodes[1].status, 'stale');
    source.nodes[0].lastUpdated = now; source.failed = true; save();
    assert.equal(supplementLegacy(n, baseline, now, false).nodes[1].status, 'unknown');
    source.failed = false; source.nodes[0].health = 'warning'; save();
    assert.equal(supplementLegacy(n, baseline, now, false).nodes[1].status, 'degraded');
    source.network = 'other'; save(); assert.equal(supplementLegacy(n, baseline, now, false).nodes[1].status, 'stale');
    const missing = networkView({ ...n, snapshot: join(dir, 'missing'), expectedTargets: [{ name: 'seed-1', role: 'seed' }] }, null, {}, now);
    assert.equal(missing.expectedNodes, 4); assert.equal(missing.nodes[0].name, 'seed-1'); assert.equal(missing.nodes[0].status, 'unknown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resource meters use fresh same-host numeric readings only, preserving managed health and public redaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-resources-'));
  try {
    const now = Date.now(), t = { name: 'hp-masternode-1', type: 'hp', host: 'PRIVATE-ONE' };
    const n = { name: 'testnet', legacySnapshot: join(dir, 'legacy.json'), legacyTargets: [t] };
    const row = { ...t, health: 'healthy', lastUpdated: now, status: { masternodeState: 'READY', posePenalty: 0, password: 'PRIVATE' }, system: { cpuPercent: 5.5, memPercent: 42, diskPercent: 73, privateField: 'PRIVATE' } };
    const report = { kind: 'LegacyStatusObservation', network: n.name, observedAt: new Date(now).toISOString(), nodes: [row] };
    const baseline = { status: 'degraded', nodes: [{ name: t.name, status: 'degraded', masternodeState: 'POSE_BANNED', services: [] }] };
    const targets = [{ name: t.name, address: t.host }];
    const read = (view = baseline, managed = targets) => { writeFileSync(n.legacySnapshot, JSON.stringify(report)); return supplementLegacy(n, view, now, false, managed); };
    let result = read();
    assert.deepEqual(result.nodes[0].resources, { cpuPercent: 5.5, memPercent: 42, diskPercent: 73 });
    assert.equal(result.nodes[0].status, 'degraded'); assert.equal(result.nodes[0].masternodeState, 'POSE_BANNED');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|privateField|password/);
    row.system = { cpuPercent: '5', memPercent: -1, diskPercent: 101 }; result = read();
    assert.deepEqual(result.nodes[0].resources, {});
    row.system = { cpuPercent: 10 }; row.lastUpdated = now - 200_000;
    assert.equal(read().nodes[0].resources, undefined);
    row.lastUpdated = now; report.failed = true;
    assert.equal(read().nodes[0].resources, undefined);
    report.failed = false;
    assert.equal(read(baseline, [{ name: t.name, address: 'OTHER-HOST' }]).nodes[0].resources, undefined);
    assert.equal(read({ ...baseline, nodes: [{ ...baseline.nodes[0], status: 'unknown' }] }).nodes[0].resources, undefined);
    report.nodes.push(row); assert.equal(read().nodes[0].resources, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
