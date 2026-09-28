// Operator-editable configuration shared by the web process (writer) and the
// agent (reader). Everything here is non-secret.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const COMPONENTS = ['core', 'drive', 'tenderdash', 'dapi', 'gateway', 'helper'];
export const COMPONENT_REPOS = {
  core: 'dashpay/dashd', drive: 'dashpay/drive', tenderdash: 'dashpay/tenderdash',
  dapi: 'dashpay/rs-dapi', gateway: 'dashpay/envoy', helper: 'dashpay/dashmate-helper',
};
const endpoints = (net, extra = []) => [
  { label: 'Insight', url: `https://insight.${net}.networks.dash.org/insight/` },
  { label: 'Faucet', url: `https://faucet.${net}.networks.dash.org/` },
  ...extra,
];

export const DEFAULT_SETTINGS = {
  pollSeconds: 30,
  discoverySeconds: 300,
  aws: { accountId: '854439639386', region: 'us-west-2', tagKey: 'DashNetwork', stateTable: 'dashnet-managed-state' },
  operators: [{ id: 9920871, login: 'ktechmidas', networks: ['*'] }],
  thresholds: { coreLagBlocks: 3, platformLagBlocks: 10, diskWarnPercent: 85, memWarnPercent: 92, balanceWarn: 100 },
  networks: [
    {
      name: 'testnet', displayName: 'Testnet', tag: 'testnet', chainType: 'testnet', coreNetwork: 'test', p2pPort: 19999,
      public: true, deployable: true, showBalances: true,
      endpoints: endpoints('testnet', [
        { label: 'Quorums', url: 'https://quorums.testnet.networks.dash.org/health' },
        { label: 'DAPI seed-1', url: 'https://seed-1.testnet.networks.dash.org:1443/', kind: 'dapi' },
        { label: 'DAPI seed-2', url: 'https://seed-2.testnet.networks.dash.org:1443/', kind: 'dapi' },
      ]),
      observationWindow: '4m', operationTimeout: '110m',
    },
    {
      name: 'devnet-moutai', displayName: 'Moutai', tag: 'devnet-moutai', chainType: 'devnet', coreNetwork: 'devnet-moutai', p2pPort: 20001,
      public: true, deployable: true, showBalances: true,
      endpoints: [
        { label: 'Insight', url: 'https://insight.moutai.networks.dash.org/insight/' },
        { label: 'Faucet', url: 'https://faucet.moutai.networks.dash.org/' },
        { label: 'Quorums', url: 'https://quorums.moutai.networks.dash.org/health' },
        { label: 'DAPI seed-1', url: 'https://seed-1.moutai.networks.dash.org:1443/', kind: 'dapi' },
      ],
      observationWindow: '4m', operationTimeout: '110m',
    },
    {
      name: 'mainnet', displayName: 'Mainnet', tag: 'mainnet-support', chainType: 'mainnet', coreNetwork: 'main', p2pPort: 9999,
      public: true, deployable: false, showBalances: false,
      endpoints: [
        { label: 'Quorums', url: 'https://quorums.mainnet.networks.dash.org/health' },
      ],
      observationWindow: '4m', operationTimeout: '110m',
    },
  ],
};

const slug = /^[a-z][a-z0-9-]{0,62}$/;
const duration = /^[1-9][0-9]{0,3}(s|m|h)$/;

// Validate and normalize a complete settings document. Throws with a message
// suitable for showing to the operator who submitted it.
export function validateSettings(input) {
  const s = structuredClone(input);
  const int = (v, lo, hi, what) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be an integer between ${lo} and ${hi}`);
    return v;
  };
  int(s.pollSeconds, 10, 3600, 'pollSeconds');
  int(s.discoverySeconds, 60, 86400, 'discoverySeconds');
  if (!s.aws || !/^\d{12}$/.test(s.aws.accountId) || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(s.aws.region) || !s.aws.tagKey || !s.aws.stateTable) throw new Error('aws account/region/tagKey/stateTable required');
  if (!Array.isArray(s.operators) || !s.operators.length) throw new Error('At least one operator is required');
  for (const o of s.operators) {
    int(o.id, 1, 2 ** 40, 'operator id');
    if (typeof o.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(o.login)) throw new Error('operator login invalid');
    if (!Array.isArray(o.networks) || !o.networks.every((n) => n === '*' || slug.test(n))) throw new Error('operator networks invalid');
  }
  const t = s.thresholds || {};
  int(t.coreLagBlocks, 0, 1000, 'coreLagBlocks'); int(t.platformLagBlocks, 0, 10000, 'platformLagBlocks');
  int(t.diskWarnPercent, 1, 100, 'diskWarnPercent'); int(t.memWarnPercent, 1, 100, 'memWarnPercent');
  if (typeof t.balanceWarn !== 'number' || t.balanceWarn < 0) throw new Error('balanceWarn must be a non-negative number');
  if (!Array.isArray(s.networks) || !s.networks.length || s.networks.length > 20) throw new Error('1-20 networks required');
  const names = new Set();
  for (const n of s.networks) {
    if (!slug.test(n.name) || names.has(n.name)) throw new Error(`network name "${n.name}" invalid or duplicated`);
    names.add(n.name);
    if (typeof n.displayName !== 'string' || !n.displayName.trim() || n.displayName.length > 60) throw new Error(`${n.name}: displayName required`);
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(n.tag)) throw new Error(`${n.name}: tag invalid`);
    if (!['testnet', 'devnet', 'mainnet'].includes(n.chainType)) throw new Error(`${n.name}: chainType must be testnet, devnet or mainnet`);
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(n.coreNetwork)) throw new Error(`${n.name}: coreNetwork invalid`);
    int(n.p2pPort, 1, 65535, `${n.name} p2pPort`);
    for (const k of ['public', 'deployable', 'showBalances']) if (typeof n[k] !== 'boolean') throw new Error(`${n.name}: ${k} must be true/false`);
    if (n.deployable && n.chainType === 'mainnet') throw new Error(`${n.name}: mainnet workloads are not deployable from the console`);
    if (!duration.test(n.observationWindow) || !duration.test(n.operationTimeout)) throw new Error(`${n.name}: durations look like 4m / 110m`);
    if (!Array.isArray(n.endpoints) || n.endpoints.length > 20) throw new Error(`${n.name}: endpoints must be a list`);
    for (const e of n.endpoints) {
      if (typeof e.label !== 'string' || !e.label.trim() || e.label.length > 40) throw new Error(`${n.name}: endpoint label required`);
      let url; try { url = new URL(e.url); } catch { throw new Error(`${n.name}: endpoint URL invalid`); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${n.name}: endpoints must be credential-free https URLs`);
      if (e.kind !== undefined && !['http', 'dapi'].includes(e.kind)) throw new Error(`${n.name}: endpoint kind must be http or dapi`);
    }
    if (n.description !== undefined && (typeof n.description !== 'string' || n.description.length > 500)) throw new Error(`${n.name}: description too long`);
  }
  return s;
}

export function loadSettings(path) {
  try { return validateSettings(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (e) {
    if (e.code !== 'ENOENT') console.error(`settings: ${e.message}; using defaults`);
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(path, settings) {
  const valid = validateSettings(settings);
  writeAtomic(path, JSON.stringify(valid, null, 2));
  return valid;
}

export function writeAtomic(path, data, mode = 0o640) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

export function readJSON(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function operatorFor(settings, user, network) {
  if (!user) return false;
  const o = settings.operators.find((x) => x.id === user.id);
  return !!o && (network === undefined || o.networks.includes('*') || o.networks.includes(network));
}
