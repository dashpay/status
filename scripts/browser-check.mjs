// Renders the real frontend against fixture agent state and walks the public
// board and the operator deploy flow. No cloud, SSH or identity provider.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeb } from '../server/web.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

const temp = mkdtempSync(join(tmpdir(), 'dash-status-browser-'));
const at = new Date().toISOString();
const container = (name, image, running = true) => ({ name, image, repo: image.split(/[:@]/)[0], running, state: running ? 'running' : 'exited', restarts: 0, startedAt: at, ports: [] });
const system = { load: [0.2, 0.3, 0.3], cpus: 2, memTotal: 4e9, memAvailable: 2e9, uptime: 86400 * 30, disks: [{ mount: '/', size: 5e10, used: 2e10, avail: 3e10 }], os: 'Ubuntu 22.04', kernel: '6.8' };
function state(name, chain, platform) {
  const hosts = [];
  const add = (hostName, role, data, n) => hosts.push({ name: hostName, role, state: 'running', publicIp: `192.0.2.${n}`, privateIp: `10.0.0.${n}`, instanceId: `i-PRIVATE${String(n).padStart(9, '0')}`, instanceType: 't4g.small', arch: 'arm64', az: 'us-west-2a', tagged: true, probe: { ok: true, at, ms: 900, data: { system, ...data } } });
  for (let i = 1; i <= 4; i++) add(`hp-masternode-${i}`, 'validator', {
    core: { chain, blocks: 1000, headers: 1000, chainLockHeight: 1000, subversion: '/Dash Core:23.1.8/', protocol: 70240, connections: 40, synced: true, masternode: { state: 'READY', posePenalty: 0, proTxHash: 'ab'.repeat(32), type: 'Evo' } },
    tenderdash: platform ? { height: 500, network: platform, protocolApp: 13, peers: 30, version: '1.8.1', validatorSetSize: 4, blockTime: at } : null,
    dapi: { ok: true, latencyMs: 25, dapiVersion: '4.2.0-beta.5', driveVersion: '4.2.0-beta.5' },
    containers: [container('dashmate-core-1', 'dashpay/dashd:23'), container('dashmate-drive_abci-1', 'dashpay/drive:4.2.0-beta.5'), container('dashmate-drive_tenderdash-1', 'dashpay/tenderdash:1.8.1'), container('dashmate-rs_dapi-1', 'dashpay/rs-dapi:4.2.0-beta.5'), container('dashmate-gateway-1', 'dashpay/envoy:1.30.2-impr.1'), container('dashmate-dashmate_helper-1', 'dashpay/dashmate-helper:4.2.0-beta.4')],
  }, i);
  for (let i = 1; i <= 2; i++) add(`seed-${i}`, 'seed', { core: { chain, blocks: 1000, connections: 90, connectionsIn: 80 }, tenderdash: { source: 'p2p', peers: 25, network: platform }, containers: [container('dashd', 'dashpay/dashd:23'), container('tenderdash', 'dashpay/tenderdash:1.8.1')] }, 10 + i);
  add('web-1', 'web', { core: { chain, blocks: 1000, subversion: '/Dash Core:23.0.0/' }, insight: { blocks: 1000, syncStatus: 'finished', syncPercentage: 100 }, faucet: { status: 200, latencyMs: 300, title: 'Dash Faucet' }, containers: [container('insight', 'dashpay/insight:4.0.10'), container('faucet', 'dashpay/multifaucet:0.9.2')] }, 20);
  add('wallet-1', 'wallet', { core: { chain, blocks: 1000, wallets: [{ name: 'dashd-wallet-1-faucet', trusted: 147078.24 }, { name: 'dashd-wallet-1-mno', trusted: 298406.03 }] }, containers: [container('dashd', 'dashpay/dashd:22.1.0')] }, 21);
  hosts.push({ name: 'masternode-9', role: 'masternode', state: 'running', publicIp: '192.0.2.40', instanceId: 'i-PRIVATE000000040', tagged: true, probe: { ok: false, at, ms: 12000, error: 'Timed out while waiting for handshake' } });
  return { network: name, generatedAt: at, pollSeconds: 30, discovery: { at }, endpoints: [{ label: 'Insight', url: 'https://insight.example/', status: 200, ok: true, ms: 40 }], hosts };
}

const dataDir = join(temp, 'data');
mkdirSync(join(dataDir, 'state'), { recursive: true });
writeFileSync(join(dataDir, 'state', 'testnet.json'), JSON.stringify(state('testnet', 'test', 'dash-testnet-51')));
writeFileSync(join(dataDir, 'state', 'devnet-moutai.json'), JSON.stringify(state('devnet-moutai', 'devnet-moutai', 'dash-devnet-moutai')));
const settings = structuredClone(DEFAULT_SETTINGS);
settings.operators.push({ id: 42, login: 'fixture-operator', role: 'admin', networks: ['*'] });
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));

const fetcher = async (url) => {
  if (url.includes('access_token')) return Response.json({ access_token: 'fixture-token' });
  if (url.includes('api.github.com/users/octocat')) return Response.json({ id: 583231, login: 'octocat', name: 'The Octocat', type: 'User', avatar_url: 'data:,' });
  if (url.includes('hub.docker.com')) return Response.json({ results: [{ name: '4.2.0-beta.5', last_updated: at, images: [{ architecture: 'amd64' }, { architecture: 'arm64' }] }] });
  return Response.json({ id: 42, login: 'fixture-operator' });
};
const origin = 'http://127.0.0.1:4799';
const app = createWeb({ dataDir, origin, auth: { clientId: 'fixture', clientSecret: 'fixture', fetcher }, fetcher });
const server = app.listen(4799, '127.0.0.1');
const browser = await chromium.launch();
mkdirSync('artifacts', { recursive: true });
try {
  for (const [label, viewport] of [['desktop', { width: 1600, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin);
    await page.getByText('Core height').first().waitFor();
    assert.ok((await page.locator('body').innerText()).includes('Testnet'));
    await page.screenshot({ path: `artifacts/overview-${label}.png`, fullPage: true });
    await page.goto(origin + '/n/testnet');
    await page.getByText('Seeds · 2').waitFor();
    const text = await page.locator('body').innerText();
    assert.ok(text.includes('seed-2') && text.includes('wallet-1') && text.includes('web-1'));
    assert.ok(!text.includes('i-PRIVATE') && !text.includes('10.0.0.'), 'public view must not expose instance IDs or private IPs');
    await page.screenshot({ path: `artifacts/network-${label}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  // Operator: sign in, prepare an upgrade from the form.
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const start = await page.request.get(origin + '/api/auth/github', { maxRedirects: 0 });
  const state = new URL(start.headers().location).searchParams.get('state');
  await page.goto(`${origin}/api/auth/callback?state=${state}&code=fixture`);
  await page.goto(origin + '/n/devnet-moutai/deploy');
  await page.getByText('Upgrade images').click();
  await page.getByRole('row', { name: /hp-masternode-1/ }).click();
  await page.getByLabel(/^helper/).check();
  await page.getByRole('button', { name: '4.2.0-beta.5' }).click();
  await page.screenshot({ path: 'artifacts/deploy.png', fullPage: true });
  await page.getByRole('button', { name: 'Prepare plan for review' }).click();
  await page.waitForURL('**/n/devnet-moutai/ops/*');
  const [file] = readdirSync(join(dataDir, 'requests')).filter((f) => f.endsWith('.json'));
  const q = JSON.parse(readFileSync(join(dataDir, 'requests', file), 'utf8'));
  assert.deepEqual([q.action, q.nodes, q.components, q.images], ['upgrade', ['hp-masternode-1'], ['helper'], { helper: 'dashpay/dashmate-helper:4.2.0-beta.5' }]);
  // Admin: prepare (non-destructive) a Platform wipe/redeploy of a dashmate devnet.
  await page.goto(origin + '/n/devnet-moutai/reset');
  await page.getByText('Wipe and redeploy Platform').waitFor();
  await page.screenshot({ path: 'artifacts/platform-reset.png', fullPage: true });
  await page.getByRole('button', { name: 'Prepare (non-destructive)' }).click();
  await page.waitForURL('**/n/devnet-moutai/ops/*');
  const reset = readdirSync(join(dataDir, 'requests')).map((f) => JSON.parse(readFileSync(join(dataDir, 'requests', f), 'utf8'))).find((x) => x.action === 'platform-reset');
  assert.deepEqual(reset.images, { drive: 'dashpay/drive:4.2.0-beta.5', dapi: 'dashpay/rs-dapi:4.2.0-beta.5', tenderdash: 'dashpay/tenderdash:1.8.1' });
  assert.equal(reset.options.epochSeconds, 3600);

  // Admin: prepare a new devnet from the form.
  await page.goto(origin + '/devnets/new');
  await page.getByPlaceholder('bonsai').fill('fixture');
  await page.screenshot({ path: 'artifacts/new-devnet.png', fullPage: true });
  await page.getByRole('button', { name: 'Prepare plan for review' }).click();
  await page.waitForURL('**/n/devnet-fixture/ops/*');
  const created = readdirSync(join(dataDir, 'requests')).map((f) => JSON.parse(readFileSync(join(dataDir, 'requests', f), 'utf8'))).find((x) => x.action === 'create-devnet');
  assert.equal(created.network, 'devnet-fixture');
  assert.equal(created.devnet.validators, 13);
  assert.equal(created.devnet.subnetId, undefined, 'placement is never sent by the browser');
  await page.goto(origin + '/settings');
  await page.getByPlaceholder('GitHub login, e.g. octocat').fill('octocat');
  await page.getByRole('button', { name: 'Look up' }).click();
  await page.getByText('The Octocat').waitFor();
  await page.locator('form select').selectOption('viewer');
  await page.locator('form .chip', { hasText: 'devnet-moutai' }).click();
  await page.getByRole('button', { name: 'Add @octocat' }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByText('saved').waitFor();
  const saved = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.operators.find((o) => o.login === 'octocat'), { id: 583231, login: 'octocat', role: 'viewer', networks: ['devnet-moutai'] });
  await page.screenshot({ path: 'artifacts/settings.png', fullPage: true });
  console.log(JSON.stringify({ public: 'passed', deployRequest: q.id, settings: 'user added' }));
} finally {
  await browser.close();
  app.close(); server.close();
  rmSync(temp, { recursive: true, force: true });
}
