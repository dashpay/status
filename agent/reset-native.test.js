import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReset, validateReset } from './reset.js';

test('dashnet reset is devnet-only and does not bypass native image/epoch management', () => {
  const settings = { networks: [{ name: 'devnet-sakura', chainType: 'devnet', kind: 'dashnet' }, { name: 'mainnet', chainType: 'mainnet', kind: 'dashnet' }] };
  assert.equal(validateReset(settings, { network: 'devnet-sakura' }).epoch, null);
  assert.throws(() => validateReset(settings, { network: 'mainnet' }), /devnets/);
  assert.throws(() => validateReset(settings, { network: 'devnet-sakura', images: { drive: 'dashpay/drive:new' } }), /preserves installed/);
  assert.throws(() => validateReset(settings, { network: 'devnet-sakura', options: { epochSeconds: 1 } }), /preserves installed/);
});

test('native reset binds every deployed validator, canaries all, excludes wallet, and refuses replacement hosts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-reset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { private: join(root, 'private'), state: join(root, 'state') };
  const name = 'devnet-sakura';
  const work = join(dirs.private, 'devnets', name);
  mkdirSync(work, { recursive: true }); mkdirSync(dirs.state);
  const hosts = ['validators-001', 'validators-002', 'wallet-001'].map((name, i) => ({ name, role: name.startsWith('wallet') ? 'wallet' : 'validator', instanceId: `i-${i}`, publicIp: `192.0.2.${i + 1}`, state: 'running', probe: { ok: true } }));
  const state = () => writeFileSync(join(dirs.state, `${name}.json`), JSON.stringify({ hosts }));
  state();
  writeFileSync(join(work, 'deployment.json'), JSON.stringify({ targets: hosts.map((h) => ({ ...h, sshAddress: h.publicIp })) }));
  const calls = [];
  let fail = null;
  const pool = { exec: async (host, cmd, script) => {
    const [, stage, encoded] = /python3 - (\S+) (\S+)/.exec(cmd);
    const q = JSON.parse(Buffer.from(encoded, 'base64'));
    assert.equal(q.node, host.name);
    assert.match(script, /class Reset:/);
    assert.equal(q.epochSeconds, null);
    assert.equal(q.images, undefined);
    calls.push([stage, host.name]);
    return JSON.stringify({ ok: fail !== `${stage}:${host.name}`, result: {
      ...({ baseline: { images: { drive: 'installed@sha256:123' }, epochTime: 3600, height: 100, anchor: 10, dashmate: '5.0.0-beta.1', configFormatVersion: '5.0.0', tor: { enabled: true } }, anchor: { height: 99, hash: 'ab' }, canary: { checks: { coreSectionUnchanged: true }, rendered: [] } }[stage] || {}),
    } });
  } };
  const ctx = { step: () => () => {}, save: () => {}, write: () => {} };
  const reset = createReset({ ctx, dirs, pool, getSettings: () => ({ networks: [{ name, chainType: 'devnet', coreNetwork: name, kind: 'dashnet' }] }) });
  const record = () => ({ id: 'native-reset-test', network: name, request: { network: name, action: 'platform-reset' } });
  const r = record();
  await reset.prepareReset(r);
  assert.equal(r.review.native, true);
  assert.equal(r.review.epoch.next, 3600);
  assert.deepEqual(calls.filter(([s]) => s === 'canary').map(([, h]) => h), ['validators-001', 'validators-002']);
  assert.ok(!calls.some(([s,h]) => h === 'wallet-001' || ['wipe','apply','start'].includes(s)));
  hosts[1].instanceId = 'i-replacement'; state();
  await assert.rejects(reset.executeReset(r), /targets changed/);
  await assert.rejects(reset.prepareReset(record()), /do not match/);
  hosts[1].instanceId = 'i-1'; state();
  fail = 'wipe:validators-002';
  await assert.rejects(reset.executeReset(r), /wipe failed/);
  assert.ok(!calls.some(([s]) => ['apply','start'].includes(s)));
  fail = null;
  await reset.executeReset(r);
  assert.equal(calls.filter(([s,h]) => s === 'wipe' && h === 'validators-001').length, 1);
  assert.ok(r.result.healthy);
});
