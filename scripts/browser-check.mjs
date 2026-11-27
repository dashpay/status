// Renders the real frontend against fixture agent state and walks the public
// board and the operator deploy flow. No cloud, SSH or identity provider.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
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
const origin = 'http://127.0.0.1:4799';
// Wake hooks: four, as on the live console. One listener asks and stays connected, one never does.
const hooksDir = join(temp, 'hooks'), hookSecret = 'fixture-hook-secret-0123456789', hookToken = 'fixture-listener-token-0123456789abcdef';
const tokenDigest = createHash('sha256').update(hookToken).digest('hex');
mkdirSync(hooksDir);
writeFileSync(join(hooksDir, 'hooks.json'), JSON.stringify({ schemaVersion: 1, hooks: {
  'agent-directory': { source: 'github', events: ['pull_request', 'push'], listeners: { 'worker-vm': tokenDigest } },
  'platform-release': { source: 'github', events: ['release'], listeners: { 'ubuntu-server-2': tokenDigest } },
  'platform-release-jobs': { source: 'github', events: ['workflow_job'], match: [{ path: 'workflow_job.labels', pattern: '^platform-release-' }], listeners: { 'ubuntu-server-2': tokenDigest } },
  'forum-queue': { source: 'xenforo', events: ['user.insert', 'post.insert', 'thread.insert'], listeners: { 'fixture-absent-listener': 'c'.repeat(64) } } } }));
for (const name of ['agent-directory', 'platform-release', 'platform-release-jobs', 'forum-queue']) writeFileSync(join(hooksDir, `${name}.secret`), hookSecret);
// The triage worker's token, as the console holds it: a digest.
const triageToken = 'fixture-triage-worker-token-0123456789abc', triageWorkersFile = join(temp, 'triage-workers.json');
writeFileSync(triageWorkersFile, JSON.stringify({ schemaVersion: 1, workers: { infraclaw: createHash('sha256').update(triageToken).digest('hex') } }));
const app = createWeb({ dataDir, origin, hooksDir, triageWorkersFile, triageSettleMs: 0, auth: { clientId: 'fixture', clientSecret: 'fixture', fetcher }, fetcher });
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
    await page.getByRole('region', { name: 'Functional monitoring' }).waitFor();
    const search = page.getByPlaceholder('filter: name, IP, version, reason…');
    assert.ok((await search.boundingBox()).width >= 160, 'search stays usable on mobile');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'long real endpoint URLs must not widen the document');
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
  // Every healthy node starts selected; the unreachable one does not.
  await page.getByText('2 · Nodes · 6 selected').waitFor();
  await page.getByRole('button', { name: 'clear' }).click();
  await page.getByRole('row', { name: /hp-masternode-1/ }).click();
  await page.getByLabel(/^helper/).check();
  await page.getByRole('button', { name: '4.2.0-beta.5' }).click();
  await page.screenshot({ path: 'artifacts/deploy.png', fullPage: true });
  // One click: the upgrade starts as soon as its plan is ready (the default).
  await page.getByRole('button', { name: 'Upgrade now' }).click();
  await page.waitForURL('**/n/devnet-moutai/ops/*');
  const [file] = readdirSync(join(dataDir, 'requests')).filter((f) => f.endsWith('.json'));
  const q = JSON.parse(readFileSync(join(dataDir, 'requests', file), 'utf8'));
  assert.deepEqual([q.action, q.nodes, q.components, q.images, q.options.autoRun], ['upgrade', ['hp-masternode-1'], ['helper'], { helper: 'dashpay/dashmate-helper:4.2.0-beta.5' }, true]);
  rmSync(join(dataDir, 'requests', file));
  // From the network page: newer releases are offered, one click rolls them out.
  await page.goto(origin + '/n/devnet-moutai');
  await page.getByText('updates available').waitFor();
  await page.getByRole('button', { name: 'Upgrade now' }).click();
  await page.waitForURL('**/n/devnet-moutai/ops/*');
  const [one] = readdirSync(join(dataDir, 'requests')).filter((f) => f.endsWith('.json'));
  const u = JSON.parse(readFileSync(join(dataDir, 'requests', one), 'utf8'));
  assert.deepEqual([u.components, u.images, u.options.autoRun, u.nodes.sort()], [['helper'], { helper: 'dashpay/dashmate-helper:4.2.0-beta.5' }, true, ['hp-masternode-1', 'hp-masternode-2', 'hp-masternode-3', 'hp-masternode-4']]);
  rmSync(join(dataDir, 'requests', one));
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
  assert.equal(created.devnet.platformEpochSeconds, 3600, 'Platform epochs default to one hour');
  assert.equal(created.devnet.subnetId, undefined, 'placement is never sent by the browser');
  await page.goto(origin + '/settings');
  await page.getByPlaceholder('GitHub login, e.g. octocat').fill('octocat');
  await page.getByRole('button', { name: 'Look up' }).click();
  await page.getByText('The Octocat').waitFor();
  const accessForm = page.locator('form', { hasText: 'Add a GitHub user' });
  await accessForm.locator('select').selectOption('viewer');
  await accessForm.locator('.chip', { hasText: 'devnet-moutai' }).click();
  await page.getByRole('button', { name: 'Add @octocat' }).click();
  // Saved on add, with no page-wide Save: a reload keeps the new account.
  await page.getByText('saved', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save settings' }).isDisabled(), true, 'adding access leaves nothing unsaved');
  await page.reload();
  await page.getByText('@octocat').waitFor();
  const saved = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.operators.find((o) => o.login === 'octocat'), { id: 583231, login: 'octocat', role: 'viewer', networks: ['devnet-moutai'] });
  // API tokens: issued once in Settings, used by a bot with no session, revoked from the table.
  const tokenForm = page.locator('form', { hasText: 'Issue a token for a bot' });
  await tokenForm.getByPlaceholder('label, e.g. infraclaw').fill('fixture bot');
  await tokenForm.locator('select').selectOption('admin');
  await tokenForm.getByRole('button', { name: 'Issue token' }).click();
  const apiToken = (await tokenForm.locator('.select-all').innerText()).trim();
  assert.match(apiToken, /^dst_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/);
  const asBot = (path, init = {}) => fetch(origin + path, { ...init, headers: { authorization: `Bearer ${apiToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  const botMe = await (await asBot('/api/me')).json();
  assert.deepEqual([botMe.user.login, botMe.admin], ['fixture-operator', true]);
  assert.equal((await asBot('/api/tokens')).status, 403, 'a token never manages tokens');
  const tokenRow = page.getByRole('row', { name: /fixture bot/ });
  await tokenRow.waitFor();
  await page.screenshot({ path: 'artifacts/settings.png', fullPage: true });
  page.once('dialog', (d) => d.accept());
  await tokenRow.getByRole('button', { name: 'revoke' }).click();
  await page.getByText('No API tokens.').waitFor();
  assert.equal((await asBot('/api/me')).status, 401, 'revoked');
  assert.equal(await page.getByRole('button', { name: 'Save settings' }).isDisabled(), true, 'tokens leave nothing unsaved');

  // Infrastructure pages: CI runners (a reporter's push) and the AWS inventory.
  const { id: reporter } = app.ci.addReporter('mac-runner-fixture');
  const hour = (h) => new Date(Date.now() - h * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
  app.ci.ingest(reporter, { v: 1, reporter: '1', python: '3.9.6', at: hour(0),
    host: { hostname: 'fixture.lan', os: 'macOS 26.6.2', arch: 'arm64', cpus: 14, load: [2, 2, 2], memTotal: 38e9, memUsed: 20e9, uptimeSec: 86400, disks: [{ path: '/System/Volumes/Data', total: 5e11, free: 1.2e11 }], docker: null },
    runners: [{ key: '/Users/runner/actions-runner', name: 'mac-runner-fixture', pool: 'platform-repositories', kind: 'native', version: '2.337.0', listening: true, busy: true, job: { name: 'Swift SDK build', start: hour(0.1), repo: 'dashpay/platform', runId: 1, workflow: 'Tests' }, diag: { bytes: 6e9, files: 162880 } }],
    jobs: [3, 5, 9, 30].map((h, i) => ({ runner: '/Users/runner/actions-runner', runnerName: 'mac-runner-fixture', name: 'Swift SDK build', start: hour(h), end: hour(h - 0.1), result: i === 1 ? 'Failed' : 'Succeeded', repo: 'dashpay/platform', runId: 10 + i, attempt: 1, workflow: 'Tests', visibility: 'public' })) });
  // A dash-ci-pool host: a pool of single-use runners, no long-lived ones.
  const { id: poolReporter } = app.ci.addReporter('r730-fixture');
  app.ci.ingest(poolReporter, { v: 1, reporter: '2', python: '3.11.2', at: hour(0),
    host: { hostname: 'proxmox3', os: 'Debian GNU/Linux 12 (bookworm)', arch: 'x86_64', cpus: 88, load: [6, 5, 5], memTotal: 270e9, memUsed: 120e9, uptimeSec: 864000, disks: [{ path: '/', total: 9e11, free: 4e11 }], docker: null },
    runners: [],
    pools: [{ name: 'light', controller: 'r730', backend: 'proxmox-lxc', labels: ['self-hosted', 'Linux', 'X64', 'dash-x64-light'], size: 12, idle: 9, busy: 2, starting: 1, draining: false, at: hour(0),
      instances: [{ name: 'r730-light-0a1b2c', state: 'busy', since: hour(0.01) }, { name: 'r730-light-3d4e5f', state: 'busy', since: hour(0.02) }] }],
    jobs: [0.5, 1, 2, 4, 6, 20].map((h, i) => ({ runner: `r730-light-00000${i}`, runnerName: `r730-light-00000${i}`, pool: 'light', name: i % 2 ? 'Validate PR title' : 'Lint', start: hour(h), end: hour(h - 0.01), result: i === 2 ? 'Failed' : 'Succeeded', repo: 'dashpay/dash', runId: 40 + i, attempt: 1, workflow: 'CI', visibility: 'public' })) });
  mkdirSync(join(dataDir, 'aws'), { recursive: true });
  writeFileSync(join(dataDir, 'aws', 'inventory.json'), JSON.stringify({ at, tookMs: 4000, regions: ['us-west-2'], errors: [],
    instances: [{ region: 'us-west-2', az: 'us-west-2a', id: 'i-0123456789abcdef0', type: 't4g.small', state: 'running', launchTime: at, publicIp: '192.0.2.9', tags: { Name: 'dn-testnet-masternode-1', DashNetwork: 'testnet' }, volumes: ['vol-1'], vcpus: 2, memoryMiB: 2048, lifecycle: 'on-demand' }],
    volumes: [{ region: 'us-west-2', id: 'vol-1', sizeGiB: 50, type: 'gp3', state: 'in-use', attachedTo: 'i-0123456789abcdef0' }, { region: 'us-west-2', id: 'vol-2', sizeGiB: 200, type: 'gp2', state: 'available', attachedTo: null, createTime: at }],
    addresses: [], natGateways: [], loadBalancers: [], lambda: [], dynamodb: [], ecr: [{ region: 'eu-west-1', name: 'rs-dapi', images: 7770, untagged: 5402, bytes: 4.45e11, lastPush: at }], snapshots: [], cloudfront: [], s3: [],
    costs: { at, month: at.slice(0, 7), monthToDate: 3270.85, monthEndEstimate: 3503.4, lastMonth: 3109.17, byService: [{ service: 'EC2 - Other', amount: 1178.9 }, { service: 'Amazon Elastic Compute Cloud - Compute', amount: 897.3 }], daily: [{ day: at.slice(0, 10), amount: 110.2 }] } }));
  for (const [label, viewport] of [['desktop', { width: 1600, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    await page.goto(origin + '/ci');
    await page.getByText('Runner hosts').waitFor();
    const ciPage = await page.locator('body').innerText();
    assert.ok(ciPage.includes('mac-runner-fixture') && ciPage.includes('light pool') && ciPage.includes('r730-light-000000'), 'runners, pools and pool jobs');
    await page.screenshot({ path: `artifacts/ci-${label}.png`, fullPage: true });
    await page.goto(origin + '/aws');
    await page.getByText('Worth a look').waitFor();
    const text = await page.locator('body').innerText();
    assert.ok(text.includes('dn-testnet-masternode-1') && text.includes('Unattached volume') && text.includes('$3,271'));
    await page.screenshot({ path: `artifacts/aws-${label}.png`, fullPage: true });
    // Webhooks: deliveries arrive; three listeners have asked (two still hold their request, the one whose hook woke
    // was answered), the fourth was never seen.
    const deliver = (hook, event, body) => fetch(`${origin}/api/hooks/${hook}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': event,
      'x-github-delivery': '5d2b6b10-cb1c-11f0-9d5f-0123456789ab', 'x-hub-signature-256': `sha256=${createHmac('sha256', hookSecret).update(body).digest('hex')}` } });
    const listening = new AbortController();
    for (const hook of ['agent-directory', 'platform-release', 'platform-release-jobs']) {
      const { seq } = await (await fetch(`${origin}/api/hooks/${hook}/wait`, { headers: { authorization: `Bearer ${hookToken}` } })).json();
      fetch(`${origin}/api/hooks/${hook}/wait?after=${hook === 'agent-directory' ? seq + 1 : seq}`, { headers: { authorization: `Bearer ${hookToken}` }, signal: listening.signal }).catch(() => {});
    }
    assert.equal((await deliver('agent-directory', 'pull_request', '{"action":"opened"}')).status, 202);
    assert.equal((await deliver('platform-release-jobs', 'workflow_job', '{"workflow_job":{"labels":["ubuntu-24.04"]}}')).status, 202);
    assert.equal((await fetch(`${origin}/api/hooks/platform-release`, { method: 'POST', body: '{}', headers: { 'x-github-event': 'release', 'x-github-delivery': 'x', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` } })).status, 401);
    await page.goto(origin + '/webhooks');
    await page.getByText('Hooks listening').waitFor();
    await page.getByText('agent-directory').first().waitFor();
    const hooksPage = await page.locator('body').innerText();
    assert.ok(['agent-directory', 'platform-release-jobs', 'forum-queue', 'worker-vm', 'XenForo', '1 rule', 'never seen'].every((t) => hooksPage.includes(t)), 'hooks, senders, rules and listeners');
    // In the console's first two minutes a listener that has not asked yet is "starting", after that it is away.
    assert.ok(hooksPage.includes('3/4') && /fixture-absent-listener is not connected|waiting for listener fixture-absent-listener to ask again/.test(hooksPage) && hooksPage.includes('The newest delivery was refused'), 'what is wrong is said in words');
    assert.ok(!hooksPage.includes(hookSecret) && !hooksPage.includes(tokenDigest), 'no secret and no token digest on the page');
    await page.screenshot({ path: `artifacts/webhooks-${label}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: the Webhooks page does not scroll sideways`);
    listening.abort();
    await page.goto(origin + '/aws');
    await page.getByText('Worth a look').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: no horizontal page scroll`);
  }
  // Signed out: the sanitized views, nothing that names or locates a host.
  const anon = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await anon.goto(origin + '/ci');
  await anon.getByText('Public view').waitFor();
  const ciText = await anon.locator('body').innerText();
  assert.ok(ciText.includes('macOS host 1') && ciText.includes('Linux host 1 · light pool') && !ciText.includes('mac-runner-fixture') && !ciText.includes('fixture.lan') && !/r730|proxmox3/.test(ciText), 'public CI anonymised');
  await anon.screenshot({ path: 'artifacts/ci-public.png', fullPage: true });
  await anon.goto(origin + '/aws');
  await anon.getByText('Running instances by network').waitFor();
  const awsText = await anon.locator('body').innerText();
  assert.ok(!awsText.includes('192.0.2.9') && !awsText.includes('dn-testnet-masternode-1') && !awsText.includes('Worth a look'), 'public AWS has totals only');
  await anon.screenshot({ path: 'artifacts/aws-public.png', fullPage: true });
  await anon.goto(origin + '/webhooks');
  await anon.getByText('Public view: counts only').waitFor();
  const hooksPublic = await anon.locator('body').innerText();
  assert.ok(!/refused|to check/i.test(hooksPublic), 'public Webhooks page shows nothing a refused delivery moves');
  assert.ok(/hooks listening/i.test(hooksPublic) && hooksPublic.includes('3/4') && !/agent-directory|platform-release|forum-queue|worker-vm|ubuntu-server-2|pull_request|workflow_job/.test(hooksPublic), 'public Webhooks page names nothing');
  await anon.screenshot({ path: 'artifacts/webhooks-public.png', fullPage: true });

  // Triage: what monitoring reports is sorted into incidents and piles. An
  // administrator files an incident as known with a reason, the worker reports
  // on another through its own token, and without an account the page names no
  // host, repository or reason.
  const board = { generatedAt: new Date().toISOString(), outbox: [], issues: [] };
  const fault = (id, domain, scope, target, code, severity, evidence = {}, more = {}) => ({ id, domain, scope, target, code, severity, status: 'open', firstSeen: at, lastSeen: at, evidence, ...more });
  board.issues.push(
    fault('insight', 'network', 'testnet', 'private-insight', 'endpoint_failed', 'warning', { kind: 'http', status: 502 }),
    fault('core', 'network', 'testnet', 'private-host-1', 'host_health', 'critical', { reasons: ['private core is not running'] }),
    fault('held', 'network', 'testnet', 'private-host-2', 'host_health', 'warning', { reasons: ['restarting'] }, { suppressed: true }),
    fault('volume', 'aws', 'us-west-2', 'vol-private', 'idle_volume', 'info', { sizeGiB: 80 }),
    fault('gone', 'network', 'testnet', 'private-gone-host', 'host_health', 'critical', {}, { status: 'resolved', resolvedAt: at }));
  // The same job failing twice is one incident with two faults.
  for (const n of [1, 2]) board.issues.push(fault(`job-${n}`, 'ci', 'private-ci-host', `dashpay/platform/${n}/private-ci-host/1`, 'job_failed', 'warning',
    { repo: 'dashpay/platform', runId: 100 + n, attempt: 1, jobName: 'Swift SDK build', workflow: 'Tests', branch: 'private-branch', runner: 'private-ci-host' }));
  const boardFile = join(dataDir, 'incidents', 'state.json');
  const writeBoard = (generatedAt = new Date().toISOString()) => writeFileSync(boardFile, JSON.stringify({ ...board, generatedAt }));
  writeBoard();
  const boardErrors = [];
  page.on('pageerror', (error) => boardErrors.push(error.message));
  const workerSays = (id, body) => fetch(`${origin}/api/remediation/incidents/${id}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${triageToken}` } });
  for (const [label, viewport] of [['desktop', { width: 1600, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    await page.getByRole('link', { name: 'Remediation', exact: true }).click();
    await page.getByText('Agent repair:').waitFor();
    if (label === 'desktop') {
      // Two incidents from five open faults: the network and the failing job.
      await page.locator('[data-incident]').first().waitFor();
      assert.match(await page.locator('[data-triage-summary]').innerText(), /NEW\s*2/i);
      assert.equal(await page.locator('[data-incident]').count(), 2);
      const network = page.locator('[data-incident]', { hasText: 'testnet' }), job = page.locator('[data-incident]', { hasText: 'Swift SDK build' });
      assert.match(await job.innerText(), /2 faults/);
      await network.locator('summary').click();
      assert.match(await network.innerText(), /private-insight[\s\S]*private core is not running/);
      assert.ok(!(await network.innerText()).includes('private-host-2'), 'a fault held for an operation is not part of the incident');
      assert.ok(!(await page.locator('body').innerText()).includes('private-gone-host'), 'a resolved fault is in no pile');
      // A change in progress on the incident's hosts: its faults are held, stay
      // listed with the incident, and the incident can still be filed although
      // none of them is open.
      const own = board.issues.filter((i) => ['core', 'insight'].includes(i.id));
      for (const i of own) i.suppressed = true;
      writeBoard();
      const heldFaults = network.locator('[data-incident-held]');
      await heldFaults.waitFor({ timeout: 20_000 });
      await network.getByText('2 held').waitFor({ timeout: 20_000 });
      assert.match(await heldFaults.innerText(), /private-insight[\s\S]*private core is not running/);
      assert.ok(!(await heldFaults.innerText()).includes('private-host-2'), 'a fault that was held before it ever counted is not part of the incident');
      assert.ok(!/0 faults|No fault of this incident is open/.test(await network.innerText()), 'held is not "nothing open"');
      assert.equal(await network.locator('[data-known-open]').count(), 1, 'an incident with nothing but held faults can be filed');
      for (const i of own) delete i.suppressed;
      writeBoard();
      await heldFaults.waitFor({ state: 'detached', timeout: 20_000 });
      assert.match(await network.innerText(), /private-insight[\s\S]*private core is not running/);
      // The worker reports on the job through its own token; the page follows without a reload.
      const jobId = await job.getAttribute('data-incident');
      assert.equal((await workerSays(jobId, { state: 'needs_you', summary: 'Private worker report: the build needs a maintainer', slack: { channel: 'C0C5QSM5FFG', ts: '1764237600.000100' } })).status, 200);
      await page.getByText('Private worker report: the build needs a maintainer').waitFor({ timeout: 10_000 });
      assert.match(await page.locator('[data-triage-summary]').innerText(), /NEW\s*1[\s\S]*NEEDS YOU\s*1/i);
      // "Known…": a reason, and whatever else it causes on that network.
      await network.locator('[data-known-open]').click();
      assert.ok(await network.getByRole('button', { name: 'File as known' }).isDisabled(), 'no reason, no filing');
      await network.getByLabel('Why is this known?').fill('Private reason: testnet web host is being rebuilt this week');
      await network.getByLabel('and whatever else it causes on testnet').check();
      await network.getByRole('button', { name: 'File as known' }).click();
      await page.locator('[data-known]').waitFor();
      assert.equal(await page.locator('[data-incident]').count(), 1);
      assert.match(await page.locator('[data-triage-summary]').innerText(), /NEW\s*0[\s\S]*KNOWN\s*2/i);
      assert.match(await page.locator('[data-known]').innerText(), /Private reason: testnet web host is being rebuilt[\s\S]*2 open now[\s\S]*fixture-operator/);
      // Something else fails on that network: expected, not new.
      board.issues.push(fault('faucet', 'network', 'testnet', 'private-faucet', 'endpoint_failed', 'warning', { kind: 'http', status: 500 }));
      writeBoard();
      await page.getByText('1 expected').first().waitFor({ timeout: 10_000 });
      assert.match(await page.locator('[data-triage-summary]').innerText(), /NEW\s*0[\s\S]*EXPECTED\s*1/i);
      // The switch is the administrator's, and says what it does before it does it.
      page.once('dialog', (dialog) => { assert.match(dialog.message(), /Switch agent repair on\?/); dialog.accept(); });
      await page.locator('[data-repair-switch]').click();
      await page.getByText('switched on', { exact: true }).waitFor();
    }
    await page.locator('[data-known] summary').click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `artifacts/remediation-${label}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: remediation fits viewport`);
    // Reset details for the next viewport without reloading identity.
    await page.goto(origin + '/aws');
  }
  await anon.goto(origin + '/remediation');
  await anon.getByText('Public view: counts by network and area').waitFor();
  const publicBoard = await anon.locator('body').innerText();
  assert.ok(!/private|Private|Swift SDK|dashpay\/platform|fixture-operator|vol-/.test(publicBoard), 'the public page names no host, job, reason or report');
  assert.match(publicBoard, /Agent repair: switched on/);
  assert.equal(await anon.locator('[data-repair-switch]').count(), 0);
  await anon.screenshot({ path: 'artifacts/remediation-public.png', fullPage: true });
  // Actual server file watcher -> SSE -> client refresh, without navigation.
  board.issues.push(fault('alarm', 'aws', 'us-west-2', 'private-alarm', 'aws_alarm', 'warning', { state: 'ALARM' }));
  writeBoard();
  await anon.getByText('AWS · Area').first().waitFor({ timeout: 10_000 });
  await anon.setViewportSize({ width: 390, height: 844 });
  await anon.screenshot({ path: 'artifacts/remediation-public-mobile.png', fullPage: true });
  assert.ok(await anon.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'triage fits a phone');
  // Monitoring stops: the page says the list is old, and nothing is opened or closed on it.
  writeBoard('2020-01-01T00:00:00Z');
  await anon.getByText('Monitoring is stale or unavailable').waitFor({ timeout: 20_000 });
  assert.deepEqual(boardErrors, []);
  await anon.close();
  console.log(JSON.stringify({ public: 'passed', deployRequest: q.id, settings: 'user added' }));
} finally {
  await browser.close();
  app.close(); server.close();
  rmSync(temp, { recursive: true, force: true });
}
