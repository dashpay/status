// Operator-editable configuration shared by the web process (writer) and the
// agent (reader). Everything here is non-secret.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// admin: every network, settings and user management; operator: deploy on the
// granted networks; viewer: see granted (including private) networks read-only.
export const ROLES = ['admin', 'operator', 'viewer'];
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
  operators: [{ id: 9920871, login: 'ktechmidas', role: 'admin', networks: ['*'] }],
  thresholds: { coreLagBlocks: 3, platformLagBlocks: 10, diskWarnPercent: 85, memWarnPercent: 92, balanceWarn: 100 },
  // Defaults for devnets created from the console (dash-network-go lifecycle).
  devnets: {
    vpcId: 'vpc-08b7a214713ca4ce9', subnetId: 'subnet-01765e4b0fc0a2aa4', securityGroupIds: ['sg-0246983c2e14a5f34'],
    keyName: 'dash-status-agent', ipamPoolId: 'ipam-pool-0de83ed8bba5f9b48', rootVolumeGiB: 60,
    validators: 13, validatorType: 't4g.medium', validatorArch: 'arm64', walletType: 't3.large', walletArch: 'amd64',
    protocol: 14, blockTimeSeconds: 10, platformEpochSeconds: 3600,
    images: {
      core: 'dashpay/dashd:23', drive: 'dashpay/drive:4.2.0-beta.5', dapi: 'dashpay/rs-dapi:4.2.0-beta.5',
      tenderdash: 'dashpay/tenderdash:1.8.1', gateway: 'dashpay/envoy:1.39.0-impr.1', helper: 'dashpay/dashmate-helper:4.2.0-beta.5',
      // ACME client for each validator's Let's Encrypt certificate (public IP).
      acme: 'goacme/lego:v5.5.2',
    },
    acmeEmail: 'infrastructure@dash.org',
    services: {
      quorumServer: 'dashpay/quorum-list-server:0.7.0',
      insightImage: 'dashpay/insight:4.0.10',
      explorerVersion: '2.5.3',
      faucetRef: 'b927e6058845ebf3c0722e56eb0e89642e98c28b',
      faucetAmount: 10, faucetRateLimit: 20, faucetFunding: 50000, epochSeconds: 3600,
    },
    dnsZoneId: 'Z0875113JJTK7DOU978T', dnsSuffix: 'networks.dash.org',
  },
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
    // Mainnet (EC2 tag mainnet-support) is off the board for now; an admin can
    // add it back in Settings as a monitor-only (non-deployable) network.
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
  if (!Array.isArray(s.operators) || !s.operators.length) throw new Error('At least one user is required');
  const ids = new Set();
  for (const o of s.operators) {
    int(o.id, 1, 2 ** 40, 'GitHub user id');
    if (ids.has(o.id)) throw new Error(`${o.login}: listed twice`);
    ids.add(o.id);
    if (typeof o.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(o.login)) throw new Error('GitHub login invalid');
    if (!Array.isArray(o.networks) || !o.networks.every((n) => n === '*' || slug.test(n))) throw new Error(`${o.login}: networks invalid`);
    o.role ??= o.networks.includes('*') ? 'admin' : 'operator';
    if (!ROLES.includes(o.role)) throw new Error(`${o.login}: role must be ${ROLES.join(', ')}`);
    if (o.role === 'admin') o.networks = ['*'];
    if (!o.networks.length) throw new Error(`${o.login}: grant at least one network`);
  }
  if (!s.operators.some((o) => o.role === 'admin')) throw new Error('At least one admin is required');
  const t = s.thresholds || {};
  int(t.coreLagBlocks, 0, 1000, 'coreLagBlocks'); int(t.platformLagBlocks, 0, 10000, 'platformLagBlocks');
  int(t.diskWarnPercent, 1, 100, 'diskWarnPercent'); int(t.memWarnPercent, 1, 100, 'memWarnPercent');
  if (typeof t.balanceWarn !== 'number' || t.balanceWarn < 0) throw new Error('balanceWarn must be a non-negative number');
  s.devnets = validateDevnetDefaults(s.devnets ?? structuredClone(DEFAULT_SETTINGS.devnets));
  if (!Array.isArray(s.networks) || !s.networks.length || s.networks.length > 40) throw new Error('1-40 networks required');
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
    if (n.kind !== undefined && !['managed', 'dashnet'].includes(n.kind)) throw new Error(`${n.name}: kind must be managed or dashnet`);
    delete n.lifecycle;
  }
  return s;
}

const IMAGE_TAG = /^(docker\.io\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/;
export function validateDevnetDefaults(d) {
  const req = (cond, msg) => { if (!cond) throw new Error(`devnets: ${msg}`); };
  req(d && typeof d === 'object', 'defaults required');
  req(/^vpc-[0-9a-f]+$/.test(d.vpcId) && /^subnet-[0-9a-f]+$/.test(d.subnetId), 'vpcId/subnetId invalid');
  req(Array.isArray(d.securityGroupIds) && d.securityGroupIds.length >= 1 && d.securityGroupIds.length <= 5 && d.securityGroupIds.every((g) => /^sg-[0-9a-f]+$/.test(g)), 'securityGroupIds invalid');
  req(/^[A-Za-z0-9_.-]{1,255}$/.test(d.keyName), 'keyName invalid');
  req(d.ipamPoolId === '' || /^ipam-pool-[0-9a-f]+$/.test(d.ipamPoolId), 'ipamPoolId invalid');
  req(Number.isInteger(d.rootVolumeGiB) && d.rootVolumeGiB >= 30 && d.rootVolumeGiB <= 1000, 'rootVolumeGiB 30..1000');
  req(Number.isInteger(d.validators) && d.validators >= 13 && d.validators <= 25, 'validators 13..25');
  for (const k of ['validatorType', 'walletType']) req(/^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(d[k]), `${k} invalid`);
  for (const k of ['validatorArch', 'walletArch']) req(['arm64', 'amd64'].includes(d[k]), `${k} must be arm64 or amd64`);
  req(Number.isInteger(d.protocol) && d.protocol >= 1 && d.protocol <= 100, 'protocol invalid');
  // Under 8 s a restarted node never completes Core's blockchain sync.
  req(d.blockTimeSeconds === undefined || (Number.isInteger(d.blockTimeSeconds) && d.blockTimeSeconds >= 8 && d.blockTimeSeconds <= 600), 'blockTimeSeconds 8..600');
  // Drive's EPOCH_TIME_LENGTH_S (dashnet deployment-plan --epoch-time).
  req(d.platformEpochSeconds === undefined || (Number.isInteger(d.platformEpochSeconds) && d.platformEpochSeconds >= 60 && d.platformEpochSeconds <= 30 * 86400), 'platformEpochSeconds 60 s .. 30 days');
  for (const c of COMPONENTS) req(IMAGE_TAG.test(d.images?.[c] || '') && d.images[c].replace(/^docker\.io\//, '').split(/[@:]/)[0] === COMPONENT_REPOS[c], `images.${c} must be ${COMPONENT_REPOS[c]}:<tag>`);
  req(!d.images?.acme || (IMAGE_TAG.test(d.images.acme) && d.images.acme.replace(/^docker\.io\//, '').split(/[@:]/)[0] === 'goacme/lego'), 'images.acme must be goacme/lego:<tag> (or empty for self-signed gateways)');
  req(!d.images?.acme || /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(d.acmeEmail || ''), 'acmeEmail required for trusted gateway certificates');
  const sv = d.services || {};
  req(IMAGE_TAG.test(sv.quorumServer || '') && /^(docker\.io\/)?dashpay\/quorum-list-server[:@]/.test(sv.quorumServer), 'services.quorumServer must be dashpay/quorum-list-server:<tag>');
  req(IMAGE_TAG.test(sv.insightImage || '') && /^(docker\.io\/)?dashpay\/insight[:@]/.test(sv.insightImage), 'services.insightImage must be dashpay/insight:<tag>');
  req(/^\d+\.\d+\.\d+$|^nightly$/.test(sv.explorerVersion || ''), 'services.explorerVersion like 2.5.3');
  req(/^[0-9a-f]{40}$/.test(sv.faucetRef || ''), 'services.faucetRef must be a full dash-faucet commit');
  req(typeof sv.faucetAmount === 'number' && sv.faucetAmount > 0 && sv.faucetAmount <= 1000, 'services.faucetAmount 0..1000');
  req(Number.isInteger(sv.faucetRateLimit) && sv.faucetRateLimit >= 1 && sv.faucetRateLimit <= 10000, 'services.faucetRateLimit >= 1');
  req(typeof sv.faucetFunding === 'number' && sv.faucetFunding >= 100, 'services.faucetFunding >= 100');
  req(Number.isInteger(sv.epochSeconds) && sv.epochSeconds >= 60, 'services.epochSeconds >= 60');
  req(/^Z[0-9A-Z]+$/.test(d.dnsZoneId) && /^[a-z0-9.-]+\.[a-z]+$/.test(d.dnsSuffix), 'dnsZoneId/dnsSuffix invalid');
  return d;
}

export function loadSettings(path) {
  let settings;
  try { settings = validateSettings(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (e) {
    if (e.code !== 'ENOENT') console.error(`settings: ${e.message}; using defaults`);
    settings = structuredClone(DEFAULT_SETTINGS);
  }
  return mergeDevnets(settings, readJSON(join(dirname(path), 'devnets.json'), {}));
}

// Devnets created from the console are registered by the agent in devnets.json
// and appear as networks without anyone editing settings. Deleted ones drop out.
export function mergeDevnets(settings, registry) {
  settings.networks = settings.networks.filter((n) => registry[n.name]?.status !== 'deleted');
  const names = new Set(settings.networks.map((n) => n.name));
  for (const [name, reg] of Object.entries(registry)) {
    if (reg.status === 'deleted' || names.has(name)) continue;
    settings.networks.push(devnetEntry(name, reg));
  }
  for (const n of settings.networks) if (registry[n.name]) n.lifecycle = lifecycleOf(registry[n.name]);
  return settings;
}
// Console devnets start Platform after creation, once their quorums form.
const lifecycleOf = (reg) => ({ status: reg.status, operation: reg.operation, createdBy: reg.createdBy, createdAt: reg.createdAt, readyAt: reg.readyAt || null, dns: reg.dns || null,
  platform: reg.platform || (reg.status === 'ready' ? 'ready' : null), blockTimeSeconds: reg.blockTimeSeconds || 10, platformEpochSeconds: reg.platformEpochSeconds || null });

// Core reports a devnet's chain as devnet-<name>; dashnet plans carry <name>.
export const devnetChain = (core) => (core.startsWith('devnet-') ? core : `devnet-${core}`);

export function devnetEntry(name, reg) {
  const dns = reg.dns || {};
  return {
    name, displayName: reg.displayName || name, tag: name, chainType: 'devnet', coreNetwork: devnetChain(reg.coreNetwork || `${name.replace(/^devnet-/, '')}-g1`),
    p2pPort: 20001, public: reg.public !== false, deployable: reg.status === 'ready', showBalances: true, kind: 'dashnet',
    // Components this devnet's dash-network-go can upgrade in place.
    upgradeScopes: reg.upgradeScopes || ['platform', 'tenderdash'],
    description: '',
    endpoints: [
      dns.insight && { label: 'Insight', url: `https://${dns.insight.host}/insight-api/status` },
      dns.quorums && { label: 'Quorums', url: `https://${dns.quorums.host}/health` },
      dns.explorer && { label: 'Explorer', url: `https://${dns.explorer.host}/` },
      dns.faucet && { label: 'Faucet', url: `https://${dns.faucet.host}/api/status` },
    ].filter(Boolean),
    observationWindow: '90s', operationTimeout: '110m',
  };
}

export function saveSettings(path, settings) {
  const valid = validateSettings(settings);
  // Console devnets live in devnets.json; saving must not freeze their entries.
  const registry = readJSON(join(dirname(path), 'devnets.json'), {});
  valid.networks = valid.networks.filter((n) => !(n.kind === 'dashnet' && registry[n.name]));
  writeAtomic(path, JSON.stringify(valid, null, 2));
  return mergeDevnets(valid, registry);
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

export function accessFor(settings, user) {
  const o = user ? settings.operators.find((x) => x.id === user.id) : null;
  return o ? { ...o, role: o.role || (o.networks.includes('*') ? 'admin' : 'operator') } : null;
}
const covers = (a, network) => network === undefined || a.networks.includes('*') || a.networks.includes(network);
// Members (any role) see granted networks in full detail, including private ones.
export function memberOf(settings, user, network) {
  const a = accessFor(settings, user);
  return !!a && covers(a, network);
}
export function operatorFor(settings, user, network) {
  const a = accessFor(settings, user);
  return !!a && a.role !== 'viewer' && covers(a, network);
}
export function adminFor(settings, user) {
  return accessFor(settings, user)?.role === 'admin';
}
