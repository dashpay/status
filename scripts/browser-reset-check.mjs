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
    assert.equal(await page.locator('input[readonly]').count(), 0);
    await page.getByRole('textbox', { name:'drive target image', exact:true }).fill('dashpay/drive:5.0.0-beta.2');
    await page.getByRole('textbox', { name:'dapi target image', exact:true }).fill('dashpay/rs-dapi:5.0.0-beta.2');
    await page.getByRole('textbox', { name:'gateway target image', exact:true }).fill('dashpay/envoy:1.39.0-impr.1');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.getByRole('button', { name: 'Prepare (non-destructive)' }).click();
    await page.waitForURL('**/n/devnet-sakura/ops/*');
    const id = new URL(page.url()).pathname.split('/').at(-1);
    const q = JSON.parse(readFileSync(join(root, 'requests', `${id}.json`)));
    assert.equal(q.action, 'platform-reset');
    assert.equal(q.images.drive, 'dashpay/drive:5.0.0-beta.2');
    assert.equal(q.images.dapi, 'dashpay/rs-dapi:5.0.0-beta.2');
    assert.equal(q.images.helper, undefined, 'helper follows target Drive automatically');
    assert.equal(q.options.epochSeconds, undefined);
    assert.equal(q.options.autoRun, undefined);
    mkdirSync(join(root, 'ops'), { recursive: true });
    const changes = [{ user:'drive_consensus', added:['getspecialtxes'], removed:[] }, { option:'deprecatedrpc', added:['service'], removed:[] }];
    writeFileSync(join(root, 'ops', `${id}.json`), JSON.stringify({ id, network:q.network, actor:q.actor, createdAt:at, request:q, status:'review', steps:[], review:{
      kind:'platform-reset', native:true, explorer:{installed:true}, coreMigrationMode:'parallel-v1', planId:`reset-${id}`, preparedAt:at, hpmns:1, seeds:0,
      coreChain:q.network, coreHeight:100, anchor:{height:100,hash:'a'.repeat(64)}, previousAnchor:[1], current:[q.images], next:q.images,
      seedImages:[], epoch:{current:[3600],next:3600}, dashmate:['5.0.0-beta.2'], configFormat:[20], tor:[true],
      coreMigrations:{'validators-001':changes}, canary:{epochTime:3600,epochEnv:3600,coreMigration:changes,anchor:100}, rendered:['Platform and required Core RPC configuration'],
    } }));
    await page.reload();
    await page.getByRole('heading', { name:'Automatic Core compatibility migration' }).waitFor();
    await page.getByRole('heading', { name:'Explorer index recovery' }).waitFor();
    await page.getByText('drive_consensus RPC access: add getspecialtxes', { exact:true }).waitFor();
    await page.getByText('Core deprecatedrpc: add service', { exact:true }).waitFor();
    await page.getByText(/together in parallel/).waitFor();
    const confirm = page.getByRole('button', { name:'Wipe Platform and redeploy' });
    assert.equal(await confirm.isDisabled(),true);
    await page.locator('input').fill('devnet-sakura');
    assert.equal(await confirm.isEnabled(),true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const record = JSON.parse(readFileSync(join(root, 'ops', `${id}.json`)));
    Object.assign(record,{status:'running',confirmedAt:at,updatedAt:at});
    writeFileSync(join(root, 'ops', `${id}.json`),JSON.stringify(record));
    mkdirSync(join(root,'incidents'),{recursive:true});
    writeFileSync(join(root,'incidents','state.json'),JSON.stringify({generatedAt:at,issues:[],outbox:[],sources:{}}));
    const snapshot = await (await page.request.get(origin+'/api/issues')).json();
    assert.equal(snapshot.maintenance['devnet-sakura'].active,true,'broker snapshot reads operations without waiting for incident cycle');
    await page.goto(origin+'/remediation');
    await page.getByText('Operation maintenance',{exact:true}).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    record.status='succeeded';writeFileSync(join(root, 'ops', `${id}.json`),JSON.stringify(record));
    assert.deepEqual(errors, []);
    await page.close();
  }
  assert.equal(readdirSync(join(root, 'requests')).length, 2, 'only preparation requests, no confirmations');
  console.log('Native reset UI: desktop/mobile admin prepare passed; public hidden; no automatic confirmation.');
} finally {
  await browser.close(); app.close(); server.closeAllConnections(); server.close(); await new Promise((resolve) => setTimeout(resolve, 250)); rmSync(root, { recursive: true, force: true });
}
