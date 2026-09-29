// What a member needs to join or use a console devnet, in the spirit of the
// legacy dash-network-configs outputs (devnet-<name>.conf / .inventory / .yml):
// chain parameters, Platform settings, service endpoints, hosts and masternode
// identities. Public facts only: private keys stay on the hosts.
//
// Built from the agent's devnet workdir (deployment plan, newest dashnet
// deployment record, release lock) and written to data/devnets/<name>/config.json
// for the web, which renders the files (shared/devnet-files.js).
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON, writeAtomic } from '../shared/settings.js';

// dashnet's devnet profile (devnet-core23-platform4-tenderdash1): Core's devnet
// consensus options and Drive's quorum settings, as its node worker renders them.
export const PROFILE = {
  core: { minimumDifficultyBlocks: 1000000, highSubsidyBlocks: 500, highSubsidyFactor: 100,
    llmq: { chainlocks: 'llmq_devnet', instantsendDip0024: 'llmq_devnet_dip0024', platform: 'llmq_devnet_platform', mnhf: 'llmq_devnet' } },
  quorums: {
    validatorSet: { llmqType: 107, size: 12, dkgInterval: 24, activeSigners: 4, rotation: false },
    chainLock: { llmqType: 101, size: 12, dkgInterval: 24, activeSigners: 4, rotation: false },
    instantLock: { llmqType: 105, size: 8, dkgInterval: 48, activeSigners: 2, rotation: true },
  },
  ports: { coreP2P: 20001, tenderdashP2P: 26656, gateway: 1443 },
};

const newest = (dir, prefix) => {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort() : [];
  return files.length ? join(dir, files.at(-1)) : null;
};

export function devnetFacts({ name, reg = {}, plan, record, lock }) {
  if (!plan?.coreNetwork || !Array.isArray(plan.targets)) return null;
  const d = record?.deployment || {};
  const nodes = d.nodes || {};
  const ports = PROFILE.ports; // dashnet's fixed node ports (node.DefaultPorts)
  const hosts = plan.targets.map((t) => ({
    name: t.name, role: t.role, instanceId: t.instanceId, arch: t.architecture,
    publicIp: t.peerAddress || t.sshAddress || null, privateIp: t.privateAddress || null,
    proTxHash: nodes[t.name]?.proTxHash || null, operatorPublicKey: nodes[t.name]?.operatorPublicKey || null, platformNodeId: nodes[t.name]?.platformNodeId || null,
  }));
  const validators = hosts.filter((h) => h.role === 'validator');
  return {
    name, displayName: reg.displayName || name,
    core: {
      devnet: plan.coreNetwork, chain: plan.coreNetwork.startsWith('devnet-') ? plan.coreNetwork : `devnet-${plan.coreNetwork}`,
      port: ports.coreP2P, blockSeconds: plan.miningIntervalSeconds, premineHeight: plan.premineHeight || null,
      ...PROFILE.core, sporkAddress: d.sporkAddress || null, genesisCoreHeight: d.genesisCoreHeight ?? null, genesisBlock: d.coreGenesis || null,
      seeds: [...hosts.filter((h) => h.role === 'wallet'), ...validators].filter((h) => h.publicIp).slice(0, 4).map((h) => `${h.publicIp}:${ports.coreP2P}`),
    },
    platform: {
      chainId: plan.platformChainId, initialProtocolVersion: plan.initialProtocolVersion, epochSeconds: plan.platformEpochSeconds || 3600,
      genesisTime: plan.genesisTime, quorums: PROFILE.quorums, tenderdashP2P: ports.tenderdashP2P,
      gatewayTls: plan.gatewayTls ? 'letsencrypt' : 'self-signed',
      dapi: validators.filter((h) => h.publicIp).map((h) => `https://${h.publicIp}:${ports.gateway}`),
    },
    services: Object.fromEntries(Object.entries(reg.dns || {}).map(([k, v]) => [k, v.url])),
    faucetAddress: reg.walletAddress || null,
    images: (lock?.images || []).map((i) => ({ component: i.component, requested: i.requested, pinned: i.pinned })),
    hosts,
  };
}

// Rewrite data/devnets/<name>/config.json when the workdir's sources change.
export function createConfigWriter({ privateDir, dataDir, registry, log = () => {} }) {
  const seen = new Map();
  return function refresh() {
    const all = registry();
    for (const [name, reg] of Object.entries(all)) {
      const work = join(privateDir, 'devnets', name);
      const out = join(dataDir, 'devnets', name, 'config.json');
      if (reg.status === 'deleted' || !existsSync(join(work, 'deployment.json'))) continue;
      const sources = [join(work, 'deployment.json'), newest(work, 'deployed.'), join(work, 'lock.json')].filter((p) => p && existsSync(p));
      const key = JSON.stringify([...sources.map((p) => [p, statSync(p).mtimeMs]), reg.dns, reg.walletAddress, reg.displayName]);
      if (seen.get(name) === key && existsSync(out)) continue;
      try {
        const facts = devnetFacts({ name, reg, plan: readJSON(join(work, 'deployment.json')), record: readJSON(newest(work, 'deployed.') || ''), lock: readJSON(join(work, 'lock.json')) });
        if (!facts) continue;
        mkdirSync(join(dataDir, 'devnets', name), { recursive: true });
        writeAtomic(out, JSON.stringify({ ...facts, generatedAt: new Date().toISOString() }));
        seen.set(name, key);
      } catch (e) { log(`devnet config ${name}:`, e.message); }
    }
  };
}
