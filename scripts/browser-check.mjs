import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsole } from '../server/console.js';

const temp = mkdtempSync(join(tmpdir(), 'dash-console-browser-'));
const images = { core: 'dashpay/dashd:23', tenderdash: 'dashpay/tenderdash:1.8.0', drive: 'dashpay/drive:4.2.0-beta.3', dapi: 'dashpay/rs-dapi:4.2.0-beta.3', gateway: 'dashpay/envoy:1.39.0-impr.1' };
function fixture(name, title, count, seedFailure = false) {
  const snapshot = { kind: 'ExistingSnapshot', id: 'a'.repeat(64), observedAt: new Date().toISOString(),
    fleet: { metadata: { name, displayName: title }, chainType: name === 'testnet' ? 'testnet' : 'devnet', targets: [] }, nodes: {} };
  for (let i = 0; i < count; i++) {
    const node = i === count - 1 ? 'seed-1' : `hp-masternode-${i + 1}`;
    const target = { name: node, instanceId: `PRIVATE-ID-${i}`, address: 'PRIVATE-ADDRESS', role: i === count - 1 ? 'seed' : 'validator', containers: images };
    snapshot.fleet.targets.push(target);
    snapshot.nodes[node] = { instanceId: target.instanceId, error: seedFailure && node === 'seed-1' ? 'SSH unavailable' : '',
      chain: { coreHeight: 1952341, platformHeight: 92413, platformProtocol: 13, dapiHealthy: true, masternodeState: 'READY' },
      components: Object.fromEntries(Object.entries(images).map(([component, image]) => [component, { image, running: true, restarts: 0 }])) };
  }
  const path = join(temp, name + '.json'), health = join(temp, name + '-health.json');
  writeFileSync(path, JSON.stringify(snapshot));
  writeFileSync(health, JSON.stringify({ healthy: !seedFailure, observedAt: snapshot.observedAt, snapshot }));
  return { name, displayName: title, description: name === 'testnet' ? 'The shared proving ground for Dash Core and Platform.' : 'Rapid iteration. Real consensus. The next generation of Dash Platform.', public: true,
    snapshot: path, health, endpoints: [{ label: 'Developer documentation', url: 'https://docs.dash.org/' }] };
}
const networks = [fixture('testnet', 'Testnet', 30, true), fixture('devnet-moutai', 'Moutai', 14)];
const source = JSON.parse((await import('node:fs')).readFileSync(networks[1].snapshot));
networks[1].plan = join(temp, 'plan.json');
writeFileSync(networks[1].plan, JSON.stringify({ kind: 'ExistingOperation', operation: 'upgrade', scope: 'platform', id: 'b'.repeat(64), snapshot: source,
  images: { 'hp-masternode-1': { drive: 'dashpay/drive:4.2.0-beta.4', dapi: 'dashpay/rs-dapi:4.2.0-beta.4' } } }));
const config = { origin: 'http://127.0.0.1', networks, operationsDir: join(temp, 'ops'), workflow: { enabled: true },
  operators: { '42': { networks: ['devnet-moutai'], actions: ['upgrade', 'doctor'] } } };
let dispatched;
const app = createConsole(config, {
  auth: { clientId: 'browser-fixture', clientSecret: 'fixture-secret', fetcher: async (url) => new Response(JSON.stringify(url.includes('access_token') ? { access_token: 'fixture-token' } : { id: 42, login: 'fixture-operator' })) },
  workflows: { getToken: async () => 'fixture-token', fetcher: async (url, options) => {
    if (options.method === 'POST') { dispatched = JSON.parse(options.body); return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify({ workflow_runs: [] }));
  } },
});
const server = app.listen(0, '127.0.0.1'); await new Promise((accept) => server.once('listening', accept));
config.origin = `http://127.0.0.1:${server.address().port}`;
const screenshots = process.env.DASHNET_SCREENSHOT_DIR || 'artifacts'; mkdirSync(screenshots, { recursive: true });
let browser, page;
try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(config.origin); await page.getByRole('heading', { name: 'Explore networks' }).waitFor();
  await page.getByRole('heading', { name: 'Moutai' }).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE-ID|PRIVATE-ADDRESS|fixture-secret/);
  await page.screenshot({ path: join(screenshots, 'console-public.png'), fullPage: true });
  await page.getByRole('heading', { name: 'Testnet' }).click();
  await page.locator('tbody tr').last().waitFor();
  assert.equal(await page.locator('tbody tr').count(), 30);
  assert.match(await page.locator('tbody tr').last().innerText(), /seed-1[\s\S]*Unknown/);
  assert.equal(await page.getByRole('heading', { name: 'Manage this network' }).count(), 0);
  await page.route('**/api/auth/github', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const state = new URL(response.headers().location).searchParams.get('state');
    return route.fulfill({ response, status: 302, headers: { ...response.headers(), location: config.origin + '/api/auth/callback?code=fixture&state=' + state } });
  });
  await page.getByRole('link', { name: 'Operator sign in' }).click();
  await page.getByText('fixture-operator', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Moutai' }).click();
  await page.getByRole('heading', { name: 'Manage this network' }).waitFor();
  await page.getByRole('button', { name: 'Upgrade', exact: true }).click();
  await page.getByRole('region', { name: 'Review operation' }).waitFor();
  assert.match(await page.getByRole('region', { name: 'Review operation' }).innerText(), /Core is preserved/);
  await page.screenshot({ path: join(screenshots, 'console-operator.png'), fullPage: true });
  await page.getByRole('button', { name: 'Launch reviewed operation' }).click();
  await page.getByText('submitted', { exact: true }).waitFor();
  assert.equal(dispatched.inputs.confirm, 'b'.repeat(64)); assert.equal(dispatched.ref, 'main');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('link', { name: 'Operator sign in' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Manage this network' }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(config.origin);
  await page.getByRole('heading', { name: 'Moutai' }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: join(screenshots, 'console-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browser proof passed: public redaction, unresolved target, OAuth-bound login, scoped review/dispatch, logout and mobile layout. Fixtures only; no real workflow dispatched.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(screenshots, 'console-failure.png'), fullPage: true });
    console.error('Browser fixture failed at', new URL(page.url()).pathname, (await page.locator('body').innerText()).slice(0, 300));
  }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise((accept) => server.close(accept)); rmSync(temp, { recursive: true, force: true });
}
