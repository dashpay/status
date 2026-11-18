// Renders the real frontend against fixture agent state and walks the public
// board and the operator deploy flow. No cloud, SSH or identity provider.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeb } from '../server/web.js';
import { legacyNetwork } from '../agent/fixtures/legacy-network.js';
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
  return { network: name, generatedAt: at, pollSeconds: 30, discovery: { at }, endpoints: [{ label: 'Insight', url: 'https://insight.testnet.networks.dash.org/insight/', status: 200, ok: true, ms: 40 }], hosts };
}

const dataDir = join(temp, 'data');
mkdirSync(join(dataDir, 'state'), { recursive: true });
writeFileSync(join(dataDir, 'state', 'testnet.json'), JSON.stringify(state('testnet', 'test', 'dash-testnet-51')));
writeFileSync(join(dataDir, 'state', 'devnet-moutai.json'), JSON.stringify(state('devnet-moutai', 'devnet-moutai', 'dash-devnet-moutai')));
const settings = structuredClone(DEFAULT_SETTINGS);
settings.networks.push(structuredClone(legacyNetwork));
settings.operators.push({ id: 42, login: 'fixture-operator', role: 'admin', networks: ['*'] });
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));

const fetcher = async (url) => {
  if (url.includes('access_token')) return Response.json({ access_token: 'fixture-token' });
  if (url.includes('api.github.com/users/octocat')) return Response.json({ id: 583231, login: 'octocat', name: 'The Octocat', type: 'User', avatar_url: 'data:,' });
  if (url.includes('hub.docker.com')) return Response.json({ results: [{ name: '4.2.0-beta.5', last_updated: at, images: [{ architecture: 'amd64' }, { architecture: 'arm64' }] }] });
  return Response.json({ id: 42, login: 'fixture-operator' });
};

// Focused operator controls against the actual web server and compiled React UI.
writeFileSync(join(dataDir,'devnets.json'),JSON.stringify({'devnet-native':{status:'ready',platform:'ready',public:true,upgradeScopes:['core','platform','tenderdash'],dashmate:true,images:{helper:'dashpay/dashmate-helper:4.2.0-beta.4'}}}));
writeFileSync(join(dataDir,'state','devnet-native.json'),JSON.stringify(state('devnet-native','devnet-native','dash-devnet-native')));
const origin='http://127.0.0.1:4799';
const app=createWeb({dataDir,origin,auth:{clientId:'fixture',clientSecret:'fixture',fetcher},fetcher});
const server=app.listen(4799,'127.0.0.1');
let browser;
try {
 browser=await chromium.launch();
 mkdirSync('artifacts',{recursive:true});
 for (const [label,viewport] of [['desktop',{width:1600,height:1000}],['mobile',{width:390,height:844}]]) {
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const start=await page.request.get(origin+'/api/auth/github',{maxRedirects:0});
  const token=new URL(start.headers().location).searchParams.get('state');
  await page.goto(origin+'/api/auth/callback?state='+token+'&code=fixture');
  for (const name of ['testnet','devnet-native']) {
   await page.goto(origin+'/n/'+name+'/deploy');
   await page.getByLabel(/^core/).check();
   await page.getByPlaceholder('dashpay/dashd:<tag>').fill('dashpay/dashd:24.0.2');
   await page.getByRole('combobox',{name:'Nodes at once',exact:true}).selectOption('3');
   const toggle=page.getByRole('button',{name:'Stop mining before upgrade: off',exact:true});
   await toggle.click();
   await page.getByRole('button',{name:'Stop mining before upgrade: on',exact:true}).waitFor();
   assert.ok(await page.getByText(/Automatically resumes after completion, failure or cancellation/).isVisible());
   await page.screenshot({path:`artifacts/rollout-${name}-${label}.png`,fullPage:true});
   const wide=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(wide,false,'usable without page overflow');
   await page.getByRole('button',{name:'Upgrade now',exact:true}).click();
   await page.waitForURL('**/n/'+name+'/ops/*');
   const files=readdirSync(join(dataDir,'requests'));const q=JSON.parse(readFileSync(join(dataDir,'requests',files[0]),'utf8'));
   assert.equal(q.options.concurrency,3);assert.equal(q.options.pauseMining,true);assert.equal(q.options.autoRun,true);
   assert.equal(q.network,name);assert.deepEqual(q.components,['core']);
   for(const f of files)rmSync(join(dataDir,'requests',f));
  }
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: Testnet/native deployment controls, submitted options, desktop/mobile layout; no live operations');
} finally { await browser?.close();app.close();server.close();rmSync(temp,{recursive:true,force:true}); }
