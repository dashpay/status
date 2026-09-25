import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2], temp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-image-'));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let container;
fs.chmodSync(temp, 0o755);
fs.mkdirSync(path.join(temp, 'data'), { mode: 0o777 }); fs.chmodSync(path.join(temp, 'data'), 0o777);
fs.writeFileSync(path.join(temp, 'inventory'), 'masternode-1 ansible_host=127.0.0.1\n');
fs.writeFileSync(path.join(temp, 'empty-inventory'), '');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(temp, 'fixture-key')]);
fs.chmodSync(path.join(temp, 'fixture-key'), 0o644); // Synthetic fixture, removed below.
const registry = JSON.parse(fs.readFileSync('examples/networks.json'));
registry.operationsDir = '/var/lib/dash-status/operations'; registry.workflow.enabled = false;
for (const n of registry.networks) for (const k of ['snapshot', 'health', 'collection', 'plan']) n[k] = `/etc/dash-status/${n.name}-${k}.json`;
fs.writeFileSync(path.join(temp, 'networks.json'), JSON.stringify(registry));
try {
  const [inspection] = JSON.parse(docker('image', 'inspect', image));
  assert.equal(inspection.Config.User, 'node');
  assert.match(docker('run', '--rm', '--entrypoint', 'node', image, '--version'), /^v22\./);
  docker('run', '--rm', '--entrypoint', 'node', image, '-e', "const fs=require('fs');for(const p of ['/app/.env','/app/.git','/app/networks','/app/console-data'])if(fs.existsSync(p))process.exit(1)");
  const empty = spawnSync('docker', ['run', '--rm', '-v', `${temp}:/etc/dash-status:ro`, '-e', 'INVENTORY_PATH=/etc/dash-status/empty-inventory', image], { encoding: 'utf8', timeout: 10000 });
  assert.equal(empty.status, 1, 'Empty inventory must fail promptly, not spin and starve HTTP');
  assert.match(empty.stderr, /no monitored nodes/);
  for (const mode of ['legacy', 'console']) {
    const env = mode === 'legacy'
      ? ['-e', 'INVENTORY_PATH=/etc/dash-status/inventory', '-e', 'SSH_KEY_PATH=/etc/dash-status/fixture-key', '-e', 'SSH_PORT=1']
      : ['-e', 'NETWORKS_CONFIG=/etc/dash-status/networks.json'];
    container = docker('run', '-d', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16777216', '-p', '127.0.0.1::3001',
      '-v', `${temp}:/etc/dash-status:ro`, '-v', `${temp}/data:/var/lib/dash-status`, ...env, image);
    const port = docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "3001/tcp") 0).HostPort}}', container);
    const origin = `http://127.0.0.1:${port}`;
    let health;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) }); if (r.ok) { health = await r.json(); break; } } catch { /* bounded startup */ }
      await delay(500);
    }
    assert.ok(health, `${mode} did not start`);
    if (mode === 'legacy') assert.equal(health.totalNodes, 1);
    else {
      assert.equal(health.service, 'dash-network-console');
      const networks = await (await fetch(origin + '/api/networks')).json();
      assert.equal(networks.executionEnabled, false); assert.ok(networks.networks.length);
      assert.equal((await fetch(origin + '/api/networks/testnet/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    }
    const html = await (await fetch(origin)).text();
    assert.match(html, /<div id="root">/);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)];
    assert.ok(assets.length);
    for (const [, asset] of assets) assert.equal((await fetch(origin + asset)).status, 200);
    assert.equal(docker('exec', container, 'id', '-u'), '1000');
    assert.equal(docker('inspect', '--format', '{{.HostConfig.ReadonlyRootfs}}', container), 'true');
    if (mode === 'console') docker('exec', container, 'node', '-e', "require('fs').chmodSync('/var/lib/dash-status/operations',0o777)"); // Permit fixture cleanup by the CI host UID.
    docker('stop', '--time', '15', container);
    assert.equal(docker('inspect', '--format', '{{.State.ExitCode}}', container), '0');
    docker('rm', container); container = null;
    console.log(`${mode}: Node 22, non-root/read-only container, health, frontend assets and graceful shutdown verified`);
  }
} catch (error) {
  if (container) process.stderr.write(docker('logs', '--tail', '60', container) + '\n'); // Bounded synthetic output only.
  throw error;
} finally {
  if (container) docker('rm', '-f', container);
  fs.rmSync(temp, { recursive: true, force: true });
}
