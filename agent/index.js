// dash-status agent: the only process with cloud and SSH access.
//
//   discovery (EC2 tags/names)  ->  per-host SSH probe  ->  state/<network>.json
//   requests/*.json (from web)  ->  dashnet managed-*   ->  ops/<id>.{json,log}
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadSettings, readJSON, writeAtomic } from '../shared/settings.js';
import { createDiscovery } from './discover.js';
import { createPool, loadOrCreateKey } from './ssh.js';
import { createCollector } from './collector.js';
import { createOps, manifestFor } from './ops.js';

const DATA = process.env.STATUS_DATA_DIR || '/var/lib/dash-status';
const PRIVATE = process.env.AGENT_PRIVATE_DIR || '/var/lib/dash-status-agent';
const BINARY = process.env.DASHNET_BINARY || '/usr/local/bin/dashnet';
const dirs = { state: join(DATA, 'state'), requests: join(DATA, 'requests'), ops: join(DATA, 'ops'), work: join(PRIVATE, 'work') };
for (const d of [dirs.state, dirs.requests, dirs.ops, dirs.work, join(PRIVATE, 'journal')]) mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);
let settings = loadSettings(join(DATA, 'settings.json'));
const key = loadOrCreateKey(PRIVATE);
const pool = createPool({ key, stateDir: PRIVATE, region: settings.aws.region, accountId: settings.aws.accountId, log });
const discover = createDiscovery({ region: settings.aws.region, tagKey: settings.aws.tagKey });
const collector = createCollector({ pool, stateDir: dirs.state, log });
const wake = new Set();
const ops = createOps({
  settings: () => settings, dirs, key, pool, binary: BINARY, log,
  onChange: (r, finished) => { if (finished) wake.add(r.network); },
});

let inventory = readJSON(join(PRIVATE, 'inventory.json'), { at: null, networks: {} });
const meta = { discovery: { at: inventory.at, error: null } };
const journals = {};

async function refreshInventory() {
  try {
    const found = await discover(settings.networks);
    inventory = { at: new Date().toISOString(), networks: found };
    writeAtomic(join(PRIVATE, 'inventory.json'), JSON.stringify(inventory), 0o600);
    meta.discovery = { at: inventory.at, error: null };
    log('discovery:', Object.entries(found).map(([n, h]) => `${n}=${h.length}`).join(' '));
  } catch (e) {
    meta.discovery = { at: inventory.at, error: e.message.slice(0, 300), attemptedAt: new Date().toISOString() };
    log('discovery failed:', e.message);
  }
}

// dashnet's DynamoDB journal: which targets are enrolled, and any live claim.
function readJournal(network, state) {
  if (!network.deployable) return Promise.resolve(null);
  const dir = join(PRIVATE, 'journal', network.name);
  mkdirSync(dir, { recursive: true });
  const { manifest, excluded } = manifestFor(settings, network, state);
  if (!manifest.targets.length) return Promise.resolve(null);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  const out = join(dir, `op-${Date.now()}.json`);
  return new Promise((resolve) => {
    const child = spawn(BINARY, ['managed-operation', '--manifest', join(dir, 'manifest.json'), '--timeout', '1m', '--out', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ at: new Date().toISOString(), error: e.message }));
    child.on('close', (code) => {
      const v = readJSON(out);
      rmSync(out, { force: true });
      const base = { at: new Date().toISOString(), targets: manifest.targets.map((t) => t.name), excluded };
      if (code === 0 && v) {
        const r = v.record;
        resolve({ ...base, enrolled: Object.entries(r.enrolled || {}).filter(([n, on]) => on && (!r.instances || r.instances[n] === manifest.targets.find((t) => t.name === n)?.instanceId)).map(([n]) => n),
          phase: r.phase, operationId: r.operationId || null, current: r.current || null, lastError: r.lastError || null, owner: v.owner || null });
      } else if (/not found/i.test(err)) resolve({ ...base, enrolled: [], phase: 'not-enrolled', owner: null });
      else resolve({ ...base, error: err.trim().split('\n').pop()?.slice(0, 300) || `exit ${code}` });
    });
  });
}

async function collect(network) {
  const hosts = inventory.networks[network.name] || [];
  const state = await collector.collectNetwork(network, hosts, { ...meta, journal: journals[network.name] || null, pollSeconds: settings.pollSeconds });
  journals[network.name] = await readJournal(network, state);
}

let lastDiscovery = 0;
const busy = new Set();
async function loop() {
  settings = loadSettings(join(DATA, 'settings.json'));
  if (Date.now() - lastDiscovery > settings.discoverySeconds * 1000 || !inventory.at) {
    lastDiscovery = Date.now();
    await refreshInventory();
  }
  await Promise.all(settings.networks.map(async (n) => {
    if (busy.has(n.name)) return;
    busy.add(n.name);
    try { await collect(n); } catch (e) { log(`collect ${n.name} failed:`, e.message); } finally { busy.delete(n.name); }
  }));
}

async function main() {
  log(`agent starting; key ${key.pub.split(' ').slice(0, 2).join(' ').slice(0, 40)}…`);
  let next = 0;
  setInterval(() => {
    try { ops.tick(); } catch (e) { log('ops:', e.message); }
    for (const n of wake) {
      wake.delete(n);
      const network = settings.networks.find((x) => x.name === n);
      if (network && !busy.has(n)) { busy.add(n); collect(network).catch(() => {}).finally(() => busy.delete(n)); }
    }
  }, 1000);
  for (;;) {
    const started = Date.now();
    await loop().catch((e) => log('loop:', e.message));
    next = started + settings.pollSeconds * 1000;
    await new Promise((r) => setTimeout(r, Math.max(1000, next - Date.now())));
  }
}

for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { pool.close(); process.exit(0); });
main();
