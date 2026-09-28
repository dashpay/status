import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canOperate, canSee } from './access.js';

test('wildcard access covers networks missing from the session list', () => {
  const admin = { allNetworks: true, role: 'admin', memberOf: ['testnet'], operatorOf: ['testnet'] };
  assert.equal(canSee(admin, 'devnet-new'), true);
  assert.equal(canOperate(admin, 'devnet-new'), true);
  const viewer = { allNetworks: true, role: 'viewer', memberOf: ['testnet'], operatorOf: [] };
  assert.equal(canSee(viewer, 'devnet-new'), true);
  assert.equal(canOperate(viewer, 'devnet-new'), false);
  const operator = { allNetworks: false, role: 'operator', memberOf: ['testnet'], operatorOf: ['testnet'] };
  assert.equal(canSee(operator, 'devnet-new'), false);
  assert.equal(canOperate(operator, 'testnet'), true);
  assert.equal(canSee({}, 'testnet'), false);
});
