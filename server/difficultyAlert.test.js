import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDifficultyAlert } from '../src/utils/difficultyAlert.js';

function node(overrides = {}) {
  const { status: statusOverrides = {}, ...nodeOverrides } = overrides;
  return {
    name: 'masternode-1',
    lastUpdated: 1000,
    ...nodeOverrides,
    status: {
      coreServiceStatus: 'up',
      coreHeight: 100,
      coreDifficulty: 10,
      coreBestBlockHash: '000abc',
      coreBestBlockTime: 1000,
      ...statusOverrides,
    },
  };
}

test('getDifficultyAlert returns null when the best block is recent', () => {
  const alert = getDifficultyAlert([node()], 1200 * 1000, {
    staleBlockSeconds: 300,
    difficultyThreshold: 1,
  });
  assert.equal(alert, null);
});

test('getDifficultyAlert returns null when stale block difficulty is below threshold', () => {
  const alert = getDifficultyAlert([node({ status: { coreDifficulty: 0.1 } })], 2000 * 1000, {
    staleBlockSeconds: 300,
    difficultyThreshold: 1,
  });
  assert.equal(alert, null);
});

test('getDifficultyAlert reports stale high-difficulty tips', () => {
  const alert = getDifficultyAlert([node()], 2000 * 1000, {
    staleBlockSeconds: 300,
    difficultyThreshold: 1,
  });
  assert.deepEqual(alert, {
    type: 'testnet_difficulty_stall',
    severity: 'info',
    sourceNode: 'masternode-1',
    height: 100,
    bestBlockHash: '000abc',
    bestBlockTime: 1000,
    difficulty: 10,
    ageSeconds: 1000,
  });
});

test('getDifficultyAlert uses the highest reported core height', () => {
  const alert = getDifficultyAlert([
    node({ name: 'masternode-1', status: { coreHeight: 100, coreBestBlockTime: 1000 } }),
    node({ name: 'masternode-2', status: { coreHeight: 101, coreBestBlockHash: '000def', coreBestBlockTime: 1100 } }),
  ], 2000 * 1000, {
    staleBlockSeconds: 300,
    difficultyThreshold: 1,
  });

  assert.equal(alert.sourceNode, 'masternode-2');
  assert.equal(alert.height, 101);
  assert.equal(alert.bestBlockHash, '000def');
});
