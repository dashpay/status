import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHpStatus, parseTenderdashInfo } from './parser.js';

const blockchainJson = JSON.stringify({
  chain: 'test',
  blocks: 1000,
  initialblockdownload: false,
  verificationprogress: 0.99995,
  size_on_disk: 5 * 1024 ** 3,
});

const masternodeJson = JSON.stringify({
  state: 'READY',
  proTxHash: 'abc',
  dmnState: { PoSePenalty: 0, lastPaidHeight: 999, PoSeBanHeight: -1 },
});

const networkInfoJson = JSON.stringify({ subversion: '/Dash Core:23.0.2/' });

test('parseHpStatus marks platform warning when only /block returned data', () => {
  const tdInfo = parseTenderdashInfo(JSON.stringify({
    currentProposer: 'p1',
    nextProposer: 'p2',
    platformHeight: 12345,
    statusError: 'connection refused',
  }));
  const status = parseHpStatus(blockchainJson, masternodeJson, tdInfo, networkInfoJson);
  assert.equal(status.platformStatus, 'warning');
  assert.equal(status.platformBlockHeight, 12345);
});

test('parseHpStatus marks platform error when only /net_info returned data', () => {
  const tdInfo = parseTenderdashInfo(JSON.stringify({
    platformPeers: 8,
    proposerError: 'x',
    statusError: 'y',
  }));
  const status = parseHpStatus(blockchainJson, masternodeJson, tdInfo, networkInfoJson);
  assert.equal(status.platformStatus, 'error');
  assert.equal(status.platformPeers, 8);
});

test('parseHpStatus marks platform syncing when /status reports catching_up', () => {
  const tdInfo = parseTenderdashInfo(JSON.stringify({
    platformHeight: 12345,
    platformNetwork: 'dash-testnet',
    platformCatchingUp: true,
  }));
  const status = parseHpStatus(blockchainJson, masternodeJson, tdInfo, networkInfoJson);
  assert.equal(status.platformStatus, 'syncing');
});

test('parseHpStatus marks platform up when /status reports caught up', () => {
  const tdInfo = parseTenderdashInfo(JSON.stringify({
    platformHeight: 12345,
    platformNetwork: 'dash-testnet',
    platformPeers: 4,
    platformCatchingUp: false,
  }));
  const status = parseHpStatus(blockchainJson, masternodeJson, tdInfo, networkInfoJson);
  assert.equal(status.platformStatus, 'up');
});

test('parseHpStatus marks platform error when no Tenderdash endpoint produced data', () => {
  const tdInfo = parseTenderdashInfo(JSON.stringify({
    proposerError: 'x',
    statusError: 'y',
    netInfoError: 'z',
  }));
  const status = parseHpStatus(blockchainJson, masternodeJson, tdInfo, networkInfoJson);
  assert.equal(status.platformStatus, 'error');
});

test('parseHpStatus marks platform error on whole-blob error', () => {
  const tdInfo = parseTenderdashInfo(JSON.stringify({ error: 'tenderdash-unavailable' }));
  const status = parseHpStatus(blockchainJson, masternodeJson, tdInfo, networkInfoJson);
  assert.equal(status.platformStatus, 'error');
});

test('parseHpStatus leaves platformStatus null when tdInfo missing', () => {
  const status = parseHpStatus(blockchainJson, masternodeJson, null, networkInfoJson);
  assert.equal(status.platformStatus, null);
});

test('parseHpStatus extracts coreVersion from getnetworkinfo subversion', () => {
  const status = parseHpStatus(blockchainJson, masternodeJson, null, networkInfoJson);
  assert.equal(status.coreVersion, '23.0.2');
});

test('parseHpStatus falls back gracefully when networkInfo absent', () => {
  const status = parseHpStatus(blockchainJson, masternodeJson, null, '');
  assert.equal(status.coreVersion, undefined);
});

test('parseHpStatus tolerates dashmate banner noise around getnetworkinfo JSON', () => {
  const noisy = `Attaching to core\n${networkInfoJson}\n`;
  const status = parseHpStatus(blockchainJson, masternodeJson, null, noisy);
  assert.equal(status.coreVersion, '23.0.2');
});

test('parseHpStatus preserves coreSize and posePenalty from dash-cli JSON', () => {
  const status = parseHpStatus(blockchainJson, masternodeJson, null, networkInfoJson);
  assert.equal(status.coreSize, '5.0 GB');
  assert.equal(status.posePenalty, 0);
});

// Contract boundary: scripts/dashmon-check.sh is responsible for unwrapping
// Tenderdash's JSON-RPC envelope ({jsonrpc, id, result}) and emitting a flat
// assembly object. parseTenderdashInfo only sees that post-unwrap blob -- it
// must NOT silently accept raw-envelope input, otherwise a regression in the
// collector would go undetected here.
test('parseTenderdashInfo ignores raw JSON-RPC envelope shape (collector must unwrap)', () => {
  const envelope = JSON.stringify({
    jsonrpc: '2.0',
    id: -1,
    result: {
      currentProposer: 'p1',
      platformHeight: 12345,
      platformNetwork: 'dash-testnet',
      platformCatchingUp: false,
      platformPeers: 4,
    },
  });
  const tdInfo = parseTenderdashInfo(envelope);
  assert.equal(tdInfo.currentProposer, null);
  assert.equal(tdInfo.platformHeight, null);
  assert.equal(tdInfo.platformNetwork, null);
  assert.equal(tdInfo.platformPeers, null);
});
