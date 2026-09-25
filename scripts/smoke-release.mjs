// Boots the actual unpacked production bundle, without cloud/SSH/OAuth secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

const archive = path.resolve(process.argv[2]);
const checksum = fs.readFileSync(archive + '.sha256', 'utf8').split(' ')[0];
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), checksum);
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean);
assert.ok(entries.every((name) => name.startsWith('dash-status/') && !name.split('/').includes('..')));
assert.ok(!entries.some((name) => /(?:^|\/)(?:\.env|networks|console-data)(?:\/|$)/.test(name)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-smoke-'));
let child;
try {
  execFileSync('tar', ['-xzf', archive, '-C', dir]);
  const root = path.join(dir, 'dash-status');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release.json')));
  assert.equal(manifest.nodeMajor, Number(process.versions.node.split('.')[0]));
  assert.equal(manifest.architecture, process.arch === 'x64' ? 'amd64' : 'arm64');
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const config = JSON.parse(fs.readFileSync('examples/networks.json'));
  config.origin = `http://127.0.0.1:${port}`; config.operationsDir = path.join(dir, 'operations');
  for (const n of config.networks) for (const field of ['snapshot', 'health', 'collection', 'plan']) n[field] = path.join(dir, n.name + '-' + field + '.json');
  const configPath = path.join(dir, 'networks.json'); fs.writeFileSync(configPath, JSON.stringify(config));
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { PATH: process.env.PATH, NETWORKS_CONFIG: configPath, PORT: String(port), BIND_ADDRESS: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = ''; child.stderr.on('data', (d) => { diagnostics += d; });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Bundle exited: ${diagnostics}`);
    try { const res = await fetch(config.origin + '/api/health'); healthy = res.ok && (await res.json()).service === 'dash-network-console'; } catch { /* startup */ }
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(healthy, diagnostics || 'Bundle did not become healthy');
  const html = await fetch(config.origin); assert.equal(html.status, 200); assert.match(await html.text(), /<html/);
  const networks = await fetch(config.origin + '/api/networks'); assert.equal(networks.status, 200);
  assert.match(await networks.text(), /devnet-moutai/);
  console.log(`Verified production bundle ${manifest.version} ${manifest.architecture} ${manifest.revision}`);
} finally {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  fs.rmSync(dir, { recursive: true, force: true });
}
