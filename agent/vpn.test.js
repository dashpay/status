import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from './ssh.js';
import { spawnSync } from 'node:child_process';

test('VPN SSH refuses unverified pins and never provisions on an authentication failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vpn-pool-'));
  try {
    let connected = 0;
    const connect = () => {
      connected++;
      const c = new EventEmitter(); c.end = () => {};
      process.nextTick(() => c.emit('error', Object.assign(new Error('denied'), { level: 'client-authentication' })));
      return c;
    };
    const opts = { key: { priv: '', pub: '' }, stateDir: dir, region: 'us-west-2', accountId: 'test' };
    const host = { role: 'vpn', instanceId: 'i-vpn', publicIp: '127.0.0.1' };
    await assert.rejects(createPool(opts, connect).exec(host, 'probe'), /independently verified/);
    assert.equal(connected, 0);
    writeFileSync(join(dir, 'hostkeys.json'), JSON.stringify({ 'i-vpn': { type: 'ssh-ed25519', key: 'fixture' } }));
    await assert.rejects(createPool(opts, connect).exec(host, 'probe'), (e) => e.message === 'denied' && e.level === 'client-authentication');
    assert.equal(connected, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('VPN probe requires the OpenVPN PID to own the listener and exports no socket/client identifiers', () => {
  const run = spawnSync('python3', ['-c', `
import importlib.util,json
from unittest.mock import patch
s=importlib.util.spec_from_file_location('v','deploy/vpn-observer.py');v=importlib.util.module_from_spec(s);s.loader.exec_module(v)
for pid,expected in [(123,True),(999,False)]:
 def command(args):
  return 'ActiveState=active\\nSubState=running\\nMainPID=123\\n' if args[0]=='systemctl' else 'UNCONN 0 0 0.0.0.0:1194 0.0.0.0:* users:(("openvpn",pid=%d,fd=7))'%pid
 with patch.object(v,'command',command): d=v.collect()
 assert d['services'][0]['ok'] is expected
 assert '0.0.0.0' not in json.dumps(d) and 'pid=' not in json.dumps(d)
with patch.object(v,'command',side_effect=TimeoutError()): assert v.collect()['services'][0]['ok'] is None
`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
});
