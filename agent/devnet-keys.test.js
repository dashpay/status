import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectKeys, keyScope } from './devnet-keys.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

test('collector scopes identities, rejects busy/deleted networks and rechecks grants', async () => {
  const root = mkdtempSync(join(tmpdir(), 'key-scope-'));
  const dataDir = join(root, 'data'), privateDir = join(root, 'agent'), work = join(privateDir, 'devnets/devnet-sakura');
  mkdirSync(work, { recursive: true }); mkdirSync(join(dataDir, 'ops'), { recursive: true });
  const write = (path, value) => writeFileSync(path, JSON.stringify(value));
  const settings = { ...structuredClone(DEFAULT_SETTINGS), operators: [...DEFAULT_SETTINGS.operators, { id: 77, login: 'fixture', role: 'operator', networks: ['devnet-sakura'] }] };
  const settingsPath = join(dataDir, 'settings.json'), registryPath = join(dataDir, 'devnets.json');
  write(settingsPath, settings); write(registryPath, { 'devnet-sakura': { status: 'ready', coreNetwork: 'sakura' } });
  write(join(work, 'deployment.json'), { id: 'plan', coreNetwork: 'sakura', targets: [
    { name: 'v1', role: 'validator', instanceId: 'i-v1', sshAddress: '192.0.2.1' }, { name: 'w1', role: 'wallet', instanceId: 'i-w1', sshAddress: '192.0.2.2' },
  ] });
  write(join(work, 'deployed.1.json'), { deployment: { planId: 'plan', nodes: { v1: { proTxHash: 'tx', operatorPublicKey: 'pub', platformNodeId: 'node' } } } });
  const args = { dataDir, privateDir, network: 'devnet-sakura', user: { id: 77 } };
  try {
    assert.equal(keyScope(dataDir, privateDir, args.network, args.user).validators.length, 1);
    assert.throws(() => keyScope(dataDir, privateDir, '../sakura', args.user));
    assert.throws(() => keyScope(dataDir, privateDir, args.network, { id: 88 }));
    const read = async host => host.role === 'wallet' ? { validators: { v1: { votingPrivateKey: 'fixture' } }, networkKeys: {} } : { operatorPrivateKey: 'fixture-bls' };
    const data = await collectKeys({ ...args, read }); assert.equal(data.validators[0].votingPrivateKey, 'fixture');
    write(join(dataDir, 'ops/running.json'), { network: args.network, status: 'running' });
    await assert.rejects(collectKeys({ ...args, read })); rmSync(join(dataDir, 'ops/running.json'));
    await assert.rejects(collectKeys({ ...args, read: async (...a) => { const value = await read(...a); write(settingsPath, { ...settings, operators: DEFAULT_SETTINGS.operators }); return value; } }));
    write(settingsPath, settings); write(registryPath, { 'devnet-sakura': { status: 'deleted' } });
    assert.throws(() => keyScope(dataDir, privateDir, args.network, args.user));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
