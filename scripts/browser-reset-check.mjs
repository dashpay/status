// Native reset UI contract, against an isolated fixture server; no agent runs.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeb } from '../server/web.js';
import { legacyNetwork } from '../agent/fixtures/legacy-network.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

const root = mkdtempSync(join(tmpdir(), 'native-reset-browser-'));
mkdirSync(join(root, 'state'));
const settings = structuredClone(DEFAULT_SETTINGS);
settings.networks.push({ ...legacyNetwork, name: 'devnet-sakura', displayName: 'Sakura', chainType: 'devnet', coreNetwork: 'devnet-sakura', kind: 'dashnet', public: true, deployable: true, dashmate: true });
settings.operators.push({ id: 42, login: 'fixture', role: 'admin', networks: ['*'] });
writeFileSync(join(root, 'settings.json'), JSON.stringify(settings));
const at = new Date().toISOString();
writeFileSync(join(root, 'state/devnet-sakura.json'), JSON.stringify({ network: 'devnet-sakura', generatedAt: at, hosts: [
  { name: 'validators-001', role: 'validator', state: 'running', publicIp: '192.0.2.1', probe: { ok: true, at, data: {
    core: { chain: 'devnet-sakura', blocks: 100, headers: 100, synced: true, masternode: { state: 'READY' } },
    containers: ['drive', 'tenderdash', 'rs-dapi'].map((component) => ({ name: component, image: `index.docker.io/dashpay/${component}@sha256:${'a'.repeat(64)}`, repo: `dashpay/${component}`, running: true, state: 'running', restarts: 0 })),
  } } },
] }));
const fetcher = async (url) => url.includes('access_token') ? Response.json({ access_token: 'fixture' }) : Response.json({ id: 42, login: 'fixture' });
const origin = 'http://127.0.0.1:4798';
const app = createWeb({ dataDir: root, origin, auth: { clientId: 'fixture', clientSecret: 'fixture', fetcher }, fetcher });
const server = app.listen(4798, '127.0.0.1');
const browser = await chromium.launch();
try {
  for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/n/devnet-sakura');
    await page.getByRole('heading', { name: /Sakura/ }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Platform reset…' }).count(), 0, 'public cannot reset');
    const start = await page.request.get(origin + '/api/auth/github', { maxRedirects: 0 });
    const state = new URL(start.headers().location).searchParams.get('state');
    await page.goto(`${origin}/api/auth/callback?state=${state}&code=fixture`);
    await page.goto(origin + '/n/devnet-sakura');
    await page.getByRole('link', { name: 'Platform reset…' }).click();
    await page.getByRole('heading', { name: 'Wipe and redeploy Platform' }).waitFor();
    assert.equal(await page.locator('input[readonly]').count(), 3);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.getByRole('button', { name: 'Prepare (non-destructive)' }).click();
    await page.waitForURL('**/n/devnet-sakura/ops/*');
    const id = new URL(page.url()).pathname.split('/').at(-1);
    const q = JSON.parse(readFileSync(join(root, 'requests', `${id}.json`)));
    assert.equal(q.action, 'platform-reset');
    assert.deepEqual(q.images, {});
    assert.equal(q.options.epochSeconds, undefined);
    assert.equal(q.options.autoRun, undefined);
    assert.deepEqual(errors, []);
    await page.close();
  }
  assert.equal(readdirSync(join(root, 'requests')).length, 2, 'only preparation requests, no confirmations');
  console.log('Native reset UI: desktop/mobile admin prepare passed; public hidden; no automatic confirmation.');
} finally {
  await browser.close(); app.close(); server.closeAllConnections(); server.close(); await new Promise((resolve) => setTimeout(resolve, 250)); rmSync(root, { recursive: true, force: true });
}
