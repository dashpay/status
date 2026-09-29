// Validation and normalization boundary for the separate mainnet observer.
// The observer is not the status agent and never receives cloud/SSH authority.

const finite = (value) => Number.isFinite(value) ? value : null;
const safeString = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : null;

export function validateMainnetReport(input, now = Date.now()) {
  if (!input || input.network !== 'mainnet') throw new Error('mainnet report required');
  const at = Date.parse(input.generatedAt);
  if (!Number.isFinite(at) || at > now + 60_000) throw new Error('mainnet report timestamp invalid');
  if (!input.core || !Number.isSafeInteger(input.core.blocks) || input.core.blocks < 0) throw new Error('mainnet Core height required');
  const core = {
    chain: input.core.chain === 'main' ? 'main' : safeString(input.core.chain, 32),
    blocks: input.core.blocks,
    headers: Number.isSafeInteger(input.core.headers) ? input.core.headers : input.core.blocks,
    chainLockHeight: Number.isSafeInteger(input.core.chainLockHeight) ? input.core.chainLockHeight : null,
    bestBlockHash: safeString(input.core.bestBlockHash, 128),
    blockTime: finite(input.core.blockTime),
    ibd: input.core.ibd === true,
    synced: input.core.synced !== false,
    subversion: safeString(input.core.subversion, 80),
    protocol: finite(input.core.protocol),
    connections: finite(input.core.connections),
  };
  const platform = input.platform && Number.isSafeInteger(input.platform.height) ? {
    height: input.platform.height,
    blockTime: finite(input.platform.blockTime),
    network: safeString(input.platform.network, 80),
    catchingUp: input.platform.catchingUp === true,
    peers: finite(input.platform.peers),
    version: safeString(input.platform.version, 80),
  } : null;
  const q = input.quorumServer && typeof input.quorumServer === 'object' ? {
    status: Number.isInteger(input.quorumServer.status) ? input.quorumServer.status : null,
    latencyMs: finite(input.quorumServer.latencyMs),
    quorums: Number.isSafeInteger(input.quorumServer.quorums) ? input.quorumServer.quorums : null,
    banned: Number.isSafeInteger(input.quorumServer.banned) ? input.quorumServer.banned : null,
    enabled: Number.isSafeInteger(input.quorumServer.enabled) ? input.quorumServer.enabled : null,
    versionFailures: Number.isSafeInteger(input.quorumServer.versionFailures) ? input.quorumServer.versionFailures : null,
  } : null;
  const mainnet = {
    chainLockHeight: core.chainLockHeight,
    chainLockAgeSeconds: finite(input.mainnet?.chainLockAgeSeconds),
    platformHeight: platform?.height ?? null,
    bigBans: Number.isSafeInteger(input.mainnet?.bigBans) ? input.mainnet.bigBans : q?.banned ?? null,
    quorumServer: q,
    coreStall: input.mainnet?.coreStall === true,
    platformStall: input.mainnet?.platformStall === true,
  };
  const host = {
    name: 'mainnet-observer', role: 'fullnode', state: 'running', publicIp: null, privateIp: null,
    probe: { ok: true, at: input.generatedAt, ms: finite(input.probeMs) ?? 0, data: {
      core, tenderdash: platform, mainnet,
      containers: Array.isArray(input.containers) ? input.containers.slice(0, 32).map((c) => ({
        name: safeString(c.name, 120), repo: safeString(c.repo, 120), image: safeString(c.image, 200),
        running: c.running !== false, state: safeString(c.state, 32) || 'running', restarts: finite(c.restarts),
      })) : [],
      system: null, errors: Array.isArray(input.errors) ? input.errors.map((e) => safeString(e, 240)).filter(Boolean).slice(0, 20) : [],
    } },
  };
  return { network: 'mainnet', generatedAt: new Date(at).toISOString(), pollSeconds: 60,
    discovery: { at: new Date(at).toISOString(), error: null }, endpoints: [{
      label: 'Quorum list', kind: 'quorum', url: 'https://quorums.mainnet.networks.dash.org/masternodes',
      status: q?.status, ok: q?.status === 200, ms: q?.latencyMs,
    }], hosts: [host] };
}
