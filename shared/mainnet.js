// Public-data-only boundary. Failure samples are data, never manufactured health.
const integer = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const finite = (v) => Number.isFinite(v) && v >= 0 ? v : null;
const version = (v) => typeof v === 'string' && /^(?:unreleased-)?\d+(?:\.\d+){0,2}(?:[-+][a-zA-Z0-9.-]+)?$/.test(v) && v.length < 64 ? v : null;
const coreVersion = (v) => typeof v === 'string' && /^\/Dash Core:\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\/$/.test(v) ? v : null;
const enumeration = (v, allowed) => allowed.includes(v) ? v : null;
const boolean = (v) => typeof v === 'boolean' ? v : null;
const timestamp = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

// Every state Dash Core's `masternode status` can report.
const MASTERNODE_STATES = ['READY', 'WAITING_FOR_PROTX', 'POSE_BANNED', 'REMOVED', 'OPERATOR_KEY_CHANGED', 'PROTX_IP_CHANGED', 'ERROR', 'UNKNOWN'];

const SERVICES = {
  quorums: ['Quorums · fresh Core comparison', 'https://quorums.mainnet.networks.dash.org/quorums'],
  insight: ['Insight · indexed block/transaction', 'https://insight.dash.org/insight/'],
  'seed-1': ['Platform seed 1 · TLS + bootstrap', 'https://seed-1.mainnet.networks.dash.org'],
  'seed-2': ['Platform seed 2 · TLS + bootstrap', 'https://seed-2.mainnet.networks.dash.org'],
  'seed-3': ['Platform seed 3 · TLS + bootstrap', 'https://seed-3.mainnet.networks.dash.org'],
  bootstrap: ['Default SDK bootstrap', 'https://www.npmjs.com/package/@dashevo/dapi-client'],
  'quorums-tls': ['Quorum certificate', 'https://quorums.mainnet.networks.dash.org'],
  'insight-tls': ['Insight certificate', 'https://insight.dash.org'],
  observer: ['Independent observer / data freshness', 'https://status.testnet.networks.dash.org/'],
  core: ['Core chain progress', 'https://status.testnet.networks.dash.org/'], platform: ['Platform chain progress', 'https://status.testnet.networks.dash.org/'], chainlocks: ['ChainLocks', 'https://status.testnet.networks.dash.org/'],
};
export function serviceEndpoints(input, now) {
  const fresh = finite(input?.at) !== null && now / 1000 - input.at >= -60 && now / 1000 - input.at <= 240;
  const rows = Array.isArray(input?.services) ? input.services : [];
  return Object.entries(SERVICES).map(([id, [label, url]]) => {
    const samples = rows.filter((s) => s?.id === id);
    const s = fresh && samples.length === 1 ? samples[0] : null;
    const reason = enumeration(s?.reason, ['healthy', 'reference-unavailable', 'stale-data', 'certificate-expiring', 'probe-failed', 'consensus-signal']);
    return { label, url, kind: 'mainnet-service', ok: s ? boolean(s.ok) : false,
      status: s?.ok === true ? 'OK' : null, ms: finite(s?.ms), height: integer(s?.height),
      error: s?.ok === true ? null : reason || (s && boolean(s.ok) === null ? 'not observed' : 'monitor sample missing or stale') };
  });
}

export function validateMainnetReport(input, now = Date.now()) {
  if (!input || input.network !== 'mainnet') throw new Error('mainnet report required');
  const at = timestamp(input.generatedAt);
  if (!at || Date.parse(at) > now + 60_000 || now - Date.parse(at) > 180_000) throw new Error('mainnet report timestamp invalid or stale');
  let core = null;
  if (input.core != null) {
    if (input.core.chain !== 'main' || integer(input.core.blocks) === null) throw new Error('mainnet Core chain and height required');
    const c = input.core;
    core = { chain: 'main', blocks: c.blocks, headers: integer(c.headers), chainLockHeight: integer(c.chainLockHeight),
      bestBlockHash: /^[a-f0-9]{64}$/i.test(c.bestBlockHash || '') ? c.bestBlockHash : null,
      blockTime: finite(c.blockTime), difficulty: finite(c.difficulty), ibd: boolean(c.ibd), synced: boolean(c.synced),
      subversion: coreVersion(c.subversion), protocol: integer(c.protocol), connections: integer(c.connections) };
  }
  let platform = null;
  if (input.platform != null) {
    const p = input.platform;
    if (p.network !== 'evo1' || integer(p.height) === null) throw new Error('mainnet Platform chain and height required');
    platform = { height: p.height, blockTime: timestamp(p.blockTime), network: p.network,
      catchingUp: boolean(p.catchingUp), maxPeerHeight: integer(p.maxPeerHeight), peers: integer(p.peers), version: version(p.version), protocolApp: integer(p.protocolApp), validatorSetSize: integer(p.validatorSetSize), round: integer(p.round), commitRound: integer(p.commitRound), thresholdSigned: boolean(p.thresholdSigned) };
  }
  // Explicit schema on ingress: no target/address, ProTx/node ID, payment height,
  // certificate identity, arbitrary error, container name or untrusted text survives.
  const evo = input.evo === true;
  const mn = input.core?.masternode;
  if (core && evo && mn) core.masternode = {
    state: enumeration(mn.state, MASTERNODE_STATES),
    type: enumeration(mn.type, ['Evo']), posePenalty: integer(mn.posePenalty),
  };
  const d = input.dapi;
  const dapi = evo ? {
    ok: d?.ok === true, latencyMs: finite(d?.latencyMs), height: integer(d?.height),
    dapiVersion: version(d?.dapiVersion), driveVersion: version(d?.driveVersion),
    chainId: d?.chainId === 'evo1' ? 'evo1' : null,
    query: d?.query ? { ok: d.query.ok === true, method: 'getEpochsInfo',
      latencyMs: finite(d.query.latencyMs), epoch: integer(d.query.epoch),
      firstBlockHeight: integer(d.query.firstBlockHeight), protocol: integer(d.query.protocol) } : null,
  } : null;
  const components = { core: 'dashpay/dashd', drive: 'dashpay/drive', tenderdash: 'dashpay/tenderdash', dapi: 'dashpay/rs-dapi' };
  const containers = evo ? Object.entries(components).flatMap(([component, repo]) => {
    const c = input.components?.[component];
    const tag = version(c?.version);
    return c && tag ? [{ name: component, service: component, repo, image: `${repo}:${tag}`,
      running: c.running === true, state: c.running === true ? 'running' : 'unavailable',
      restarts: integer(c.restarts) }] : [];
  }) : [];
  const q = input.quorumServer;
  const quorum = q && typeof q === 'object' ? Object.fromEntries(['status', 'quorums', 'listed', 'banned', 'enabled', 'versionFailures'].map((k) => [k, integer(q[k])])) : null;
  if (quorum) quorum.latencyMs = finite(q.latencyMs);
  const mainnet = { chainLockHeight: core?.chainLockHeight ?? null, chainLockAgeSeconds: finite(input.mainnet?.chainLockAgeSeconds),
    platformHeight: platform?.height ?? null, platformSyncing: platform?.catchingUp ?? null,
    bigBans: integer(input.mainnet?.bigBans), newBans: integer(input.mainnet?.newBans), banWindowSeconds: 3600,
    quorumServer: quorum, coreStall: core?.ibd === false ? boolean(input.mainnet?.coreStall) : null,
    platformStall: platform?.catchingUp === false ? boolean(input.mainnet?.platformStall) : null };
  return { network: 'mainnet', generatedAt: at, pollSeconds: 60, discovery: { at, error: null },
    endpoints: input.serviceChecks !== undefined ? serviceEndpoints(input.serviceChecks, now) : [{ label: 'Quorum list', kind: 'quorum', url: 'https://quorums.mainnet.networks.dash.org/masternodes',
      status: quorum?.status ?? null, ok: quorum?.status === 200 && quorum.quorums > 0 && quorum.listed > 0, ms: quorum?.latencyMs ?? null }],
    hosts: [{ name: 'mainnet-observer', role: evo ? 'validator' : 'fullnode', state: 'running', publicIp: null, privateIp: null,
      probe: { ok: true, at, ms: finite(input.probeMs) ?? 0, data: { core, tenderdash: platform, mainnet, dapi, containers, system: null } } }] };
}
