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
const dirs = { data: DATA, private: PRIVATE, state: join(DATA, 'state'), requests: join(DATA, 'requests'), ops: join(DATA, 'ops'), work: join(PRIVATE, 'work') };
for (const d of [dirs.state, dirs.requests, dirs.ops, dirs.work, join(PRIVATE, 'journal')]) mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);
let settings = loadSettings(join(DATA, 'settings.json'));
const key = loadOrCreateKey(PRIVATE);
const pool = createPool({ key, stateDir: PRIVATE, region: settings.aws.region, accountId: settings.aws.accountId, log });
let discover = createDiscovery({ region: settings.aws.region, tagKey: settings.aws.tagKey });
let awsKey = JSON.stringify([settings.aws.region, settings.aws.tagKey]);
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
    setTimeout(() => child.kill('SIGKILL'), 90_000).unref();
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

const journalAt = new Map();
async function collect(network) {
  const hosts = inventory.networks[network.name] || [];
  const state = await collector.collectNetwork(network, hosts, { ...meta, journal: journals[network.name] || null, pollSeconds: settings.pollSeconds });
  // The journal changes only with operations: read it every few minutes, not every probe.
  if (network.kind !== 'dashnet' && Date.now() - (journalAt.get(network.name) || 0) > 5 * 60_000) {
    journalAt.set(network.name, Date.now());
    journals[network.name] = await readJournal(network, state);
  }
}

let lastDiscovery = 0;
const busy = new Set();
const lastRun = new Map();
// Each network refreshes on its own cadence; a slow network never delays others.
async function loop() {
  settings = loadSettings(join(DATA, 'settings.json'));
  const nextKey = JSON.stringify([settings.aws.region, settings.aws.tagKey]);
  if (nextKey !== awsKey) { awsKey = nextKey; discover = createDiscovery({ region: settings.aws.region, tagKey: settings.aws.tagKey }); lastDiscovery = 0; log('aws settings changed; discovery rebuilt'); }
  const names = new Set(settings.networks.map((n) => n.name));
  if (Date.now() - lastDiscovery > settings.discoverySeconds * 1000 || !inventory.at || settings.networks.some((n) => !inventory.networks[n.name])) {
    lastDiscovery = Date.now();
    await refreshInventory();
  }
  for (const n of settings.networks) {
    if (busy.has(n.name) || Date.now() - (lastRun.get(n.name) || 0) < settings.pollSeconds * 1000) continue;
    busy.add(n.name); lastRun.set(n.name, Date.now());
    collect(n).catch((e) => log(`collect ${n.name} failed:`, e.message)).finally(() => busy.delete(n.name));
  }
  for (const k of lastRun.keys()) if (!names.has(k)) lastRun.delete(k);
}

async function main() {
  log(`agent starting; key ${key.pub.split(' ').slice(0, 2).join(' ').slice(0, 40)}…`);
  setInterval(() => {
    try { ops.tick(); } catch (e) { log('ops:', e.message); }
    for (const n of wake) {
      wake.delete(n);
      const network = settings.networks.find((x) => x.name === n);
      if (network && !busy.has(n)) { busy.add(n); collect(network).catch(() => {}).finally(() => busy.delete(n)); }
    }
  }, 1000);
  for (;;) {
    await loop().catch((e) => log('loop:', e.message));
    await new Promise((r) => setTimeout(r, 2000));
  }
}

let stopping = false;
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, async () => {
  if (stopping) return;
  stopping = true;
  log(`${s}: stopping running dashnet operations`);
  await ops.shutdown().catch(() => {});
  pool.close();
  process.exit(0);
});
main();
