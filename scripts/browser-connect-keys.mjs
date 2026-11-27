import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeb } from '../server/web.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
import { devnetFacts } from '../agent/devnet-config.js';
const root = mkdtempSync(join(tmpdir(), 'connect-keys-browser-'));
mkdirSync(join(root, 'devnets/devnet-sakura'), { recursive: true });
const settings = { ...structuredClone(DEFAULT_SETTINGS), operators: [...DEFAULT_SETTINGS.operators, { id: 42, login: 'fixture', role: 'operator', networks: ['devnet-sakura'] }] };
writeFileSync(join(root, 'settings.json'), JSON.stringify(settings));
writeFileSync(join(root, 'devnets.json'), JSON.stringify({ 'devnet-sakura': { status: 'ready', displayName: 'Sakura', coreNetwork: 'sakura' } }));
const h = { name: 'validators-001', role: 'validator', instanceId: 'i-fixture', peerAddress: '192.0.2.1' };
const facts = devnetFacts({ name: 'devnet-sakura', plan: { coreNetwork: 'sakura', targets: [h], platformChainId: 'sakura', miningIntervalSeconds: 10 }, record: { deployment: { nodes: {} } } });
writeFileSync(join(root, 'devnets/devnet-sakura/config.json'), JSON.stringify(facts));
const result = { network: 'devnet-sakura', verifiedAt: new Date().toISOString(), networkKeys: { sporkPrivateKey: 'FIXTURE-SPORK' }, validators: [{ name: h.name, proTxHash: 'a'.repeat(64), votingPrivateKey: 'FIXTURE-VOTE', ownerPrivateKey: 'FIXTURE-OWNER', operatorPrivateKey: 'FIXTURE-BLS', platformNodePrivateKey: 'FIXTURE-P2P' }] };
let reads = 0;
const fetcher = async url => url.includes('access_token') ? Response.json({ access_token: 'fixture' }) : Response.json({ id: 42, login: 'fixture' });
const origin = 'http://127.0.0.1:4799';
const app = createWeb({ dataDir: root, origin, auth: { clientId: 'fixture', clientSecret: 'fixture', fetcher }, keyReader: async () => { reads++; return result; } });
const server = app.listen(4799, '127.0.0.1');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport }); const errors = []; page.on('pageerror', e => errors.push(e.message));
    const start = await page.request.get(origin + '/api/auth/github', { maxRedirects: 0 });
    const state = new URL(start.headers().location).searchParams.get('state');
    await page.goto(`${origin}/api/auth/callback?state=${state}&code=fixture`);
    await page.goto(origin + '/n/devnet-sakura/connect');
    await page.getByRole('button', { name: 'Reveal private keys' }).waitFor();
    const before = reads;
    assert.equal(await page.getByRole('textbox', { name: 'Voting private key (WIF)' }).count(), 0);
    await page.getByRole('button', { name: 'Reveal private keys' }).click();
    await page.getByRole('button', { name: 'Hide keys' }).waitFor();
    assert.equal(reads, before + 1);
    await page.locator('summary').filter({ hasText: 'validators-001' }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Voting private key (WIF)' }).inputValue(), 'FIXTURE-VOTE');
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download private keys (.json)' }).click();
    assert.equal((await download).suggestedFilename(), 'devnet-sakura-private-keys.json');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no viewport overflow');
    await page.screenshot({ path: `artifacts/connect-keys-${viewport.width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Hide keys' }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Voting private key (WIF)' }).count(), 0);
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('Desktop/mobile operator reveal, download, hide, no eager key fetch and no overflow passed (synthetic keys only).');
} finally { await browser.close(); app.close(); server.closeAllConnections(); server.close(); await new Promise(r => setTimeout(r, 250)); rmSync(root, { recursive: true, force: true }); }
