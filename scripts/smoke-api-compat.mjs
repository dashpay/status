// Original Testnet API (legacy collector) + the new web console behind the
// production nginx routing snippet.
// Run with nginx installed; all listeners and synthetic SSH failures are local.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createWeb } from '../server/web.js';
import { checkLegacyAPI } from './check-legacy-api.mjs';
import { chromium } from 'playwright';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-api-'));
let collector, proxy, consoleServer, consoleApp, browser;
const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
};
async function port() {
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const number = listener.address().port; await new Promise((resolve) => listener.close(resolve)); return number;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 80; attempt++) {
    assert.ok(!child || child.exitCode === null, 'Fixture exited before readiness');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* startup */ }
    await delay(100);
  }
  assert.fail('Fixture did not start: ' + new URL(url).pathname);
}
try {
  const [legacyPort, consolePort, publicPort] = await Promise.all([port(), port(), port()]);
  const config = { origin: `http://127.0.0.1:${publicPort}` };
  consoleApp = createWeb({ dataDir: path.join(temp, 'data'), origin: config.origin, auth: { clientId: 'fixture-client', clientSecret: 'fixture-secret' } });
  consoleServer = consoleApp.listen(consolePort, '127.0.0.1'); await once(consoleServer, 'listening');
  const key = path.join(temp, 'fixture-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const inventory = path.join(temp, 'inventory');
  fs.writeFileSync(inventory, 'masternode-1 ansible_host=127.0.0.1 public_ip=192.0.2.1 private_ip=10.0.0.1\n');
  const snippet = fs.readFileSync('deploy/nginx-legacy-api.conf', 'utf8').replace('127.0.0.1:3002', `127.0.0.1:${legacyPort}`);
  fs.writeFileSync(path.join(temp, 'legacy-api.conf'), snippet);
  const nginxConfig = path.join(temp, 'nginx.conf');
  fs.writeFileSync(nginxConfig, `pid ${temp}/nginx.pid;
error_log ${temp}/error.log;
events {}
http {
  access_log off;
  client_body_temp_path ${temp}/client;
  proxy_temp_path ${temp}/proxy;
  fastcgi_temp_path ${temp}/fastcgi;
  uwsgi_temp_path ${temp}/uwsgi;
  scgi_temp_path ${temp}/scgi;
  server {
    listen 127.0.0.1:${publicPort};
    include ${temp}/legacy-api.conf;
    location /api/ { proxy_pass http://127.0.0.1:${consolePort}; }
    location / { proxy_pass http://127.0.0.1:${consolePort}; }
  }
}`);
  execFileSync(process.env.NGINX_BIN || 'nginx', ['-t', '-p', temp, '-c', nginxConfig], { stdio: 'pipe' });
  proxy = spawn(process.env.NGINX_BIN || 'nginx', ['-p', temp, '-c', nginxConfig, '-g', 'daemon off;'], { stdio: 'pipe' });
  await ready(config.origin + '/api/session', proxy);
  for (const token of ['', 'synthetic-fixture-token']) {
    collector = spawn(process.execPath, ['server/index.js'], { env: {
      PATH: process.env.PATH, PORT: String(legacyPort), BIND_ADDRESS: '127.0.0.1', INVENTORY_PATH: inventory,
      SSH_KEY_PATH: key, SSH_PORT: '1', POLL_INTERVAL_MS: '500', API_TOKEN: token,
    }, stdio: 'pipe' });
    await ready(`http://127.0.0.1:${legacyPort}/api/health`, collector);
    if (token) {
      for (const route of ['/api/nodes', '/api/nodes/masternode-1', '/api/proposer', '/api/events']) {
        const response = await fetch(config.origin + route, { signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 401, route + ': legacy bearer protection lost');
        await response.arrayBuffer();
      }
      assert.equal((await fetch(config.origin + '/api/config')).status, 200);
      assert.equal((await fetch(config.origin + '/api/overview')).status, 200);
    }
    const result = await checkLegacyAPI(config.origin, { expectedNodes: 1, token });
    console.log(JSON.stringify({ authentication: token ? 'bearer' : 'public', ...result }));
    // Exercise the actual frontend through the production proxy. Direct console
    // tests cannot catch mode detection accidentally reading the legacy API.
    browser ||= await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(config.origin);
    await page.getByRole('link', { name: 'Sign in with GitHub' }).waitFor();
    await page.getByRole('navigation').getByRole('link', { name: /Mainnet/ }).click();
    await page.waitForURL('**/n/mainnet');
    assert.ok((await page.locator('body').innerText()).includes('Mainnet'));
    const health = await page.evaluate(() => fetch('/api/health').then((r) => r.json()));
    assert.equal(health.totalNodes, 1);
    assert.equal(health.service, undefined, 'Original API must not become a console capability endpoint');
    assert.deepEqual(pageErrors, []);
    await page.close();
    await stop(collector); collector = null;
  }
} finally {
  await stop(collector); await stop(proxy);
  if (browser) await browser.close();
  consoleApp?.close();
  if (consoleServer) { consoleServer.closeAllConnections(); await new Promise((resolve) => consoleServer.close(resolve)); }
  fs.rmSync(temp, { recursive: true, force: true });
}
