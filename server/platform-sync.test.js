import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGenesisSync, validatePlatformSyncReport } from './platform-sync.js';

const now = Date.parse('2026-11-21T01:00:00Z');
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString().replace('.000Z', 'Z');
const report = (over = {}) => ({ schema: 1, network: 'testnet', updatedAt: at(0), phase: 'syncing', hold: null, height: 400000, referenceHeight: 720000,
  progress: 0.5556, blocksPerSecond: 31.5, etaSeconds: 10158, healthy: null,
  core: { height: 1595500, headers: 1595500, syncing: false }, disk: { sizeGiB: 117.6, usedGiB: 60, freeGiB: 57.6 },
  run: { id: 'gh-123-1-testnet', network: 'testnet', requestedImage: 'auto', result: null, reason: null, startedAt: at(200),
    image: { ref: 'dashpay/drive:5.1.0-dev.2', id: 'sha256:abc', source: 'release', version: '5.1.0-dev.2', revision: 'a'.repeat(40), notes: ['x'] },
    tenderdash: '2.0.0-dev.3', restarts: { drive_abci: 0 }, bytes: { platformRx: 1500000000, platformTx: 20000, coreRx: 100, coreTx: 5, image: 62113044 } },
  lastPassed: { id: 'gh-100-1-testnet', finishedAt: at(1500), durationSeconds: 21000, height: 715000, image: { ref: 'dashpay/drive:5.1.0-dev.1', version: '5.1.0-dev.1' } },
  ...over });

test('a report keeps only the allowlisted public fields', () => {
  const r = validatePlatformSyncReport(report(), now);
  assert.deepEqual(Object.keys(r).sort(), ['blocksPerSecond', 'etaSeconds', 'generatedAt', 'healthy', 'height', 'lastPassed', 'network', 'onHold', 'phase', 'progress', 'referenceHeight', 'run']);
  assert.deepEqual(r.run.image, { ref: 'dashpay/drive:5.1.0-dev.2', version: '5.1.0-dev.2', revision: 'a'.repeat(40) });
  assert.equal(r.run.id, undefined);
  assert.equal(r.run.bytes.platformRx, 1500000000);
  assert.equal(r.lastPassed.height, 715000);
  assert.equal(r.onHold, false);
  assert.equal(JSON.stringify(r).includes('gh-123'), false);
});

test('malformed values become null, not text on a public page', () => {
  const r = validatePlatformSyncReport(report({ height: -1, progress: 7, hold: 'someone is reading the stores',
    run: { result: 'exploded', reason: 'AppHash mismatch: <script>\u0007\n' + 'x'.repeat(400), image: { ref: 'a b', version: '<b>', revision: 'zz' }, bytes: { platformRx: '5' } } }), now);
  assert.equal(r.height, null);
  assert.equal(r.progress, null);
  assert.equal(r.onHold, true);
  assert.equal(r.run.result, null);
  assert.equal(r.run.reason.length, 300);
  assert.match(r.run.reason, /^[\x20-\x7e]+$/);
  assert.deepEqual(r.run.image, { ref: null, version: null, revision: null });
  assert.equal(r.run.bytes.platformRx, null);
});

test('wrong network, schema, phase and old timestamps are refused', () => {
  for (const bad of [report({ network: 'devnet-x' }), report({ schema: 2 }), report({ phase: 'dancing' }), report({ updatedAt: at(4) }), report({ updatedAt: at(-2) }), report({ updatedAt: 'yesterday' }), null])
    assert.throws(() => validatePlatformSyncReport(bad, now));
});

test('a stored report goes stale by the clock of the reader', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'psync-'));
  mkdirSync(join(dataDir, 'state'));
  assert.equal(readGenesisSync(dataDir, 'testnet', now), null);
  writeFileSync(join(dataDir, 'state', 'platform-sync-testnet.json'), JSON.stringify(validatePlatformSyncReport(report(), now)));
  assert.equal(readGenesisSync(dataDir, 'testnet', now + 60_000).stale, false);
  assert.equal(readGenesisSync(dataDir, 'testnet', now + 16 * 60_000).stale, true);
  assert.equal(readGenesisSync(dataDir, 'mainnet', now), null);
  assert.equal(readGenesisSync(dataDir, '../settings', now), null);
});
