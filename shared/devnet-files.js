// Renders a console devnet's connection files from its facts
// (agent/devnet-config.js), shaped like the legacy dash-network-configs
// outputs: devnet-<name>.conf, devnet-<name>.inventory, devnet-<name>.yml.
const short = (name) => name.replace(/^devnet-/, '');

export function confFile(f) {
  const c = f.core;
  return [
    `# ${f.name}: Dash Core options to join this devnet (dashd -conf=<this file>)`,
    `devnet=${c.devnet}`,
    '',
    '[devnet]',
    `llmqchainlocks=${c.llmq.chainlocks}`,
    `llmqinstantsenddip0024=${c.llmq.instantsendDip0024}`,
    `llmqplatform=${c.llmq.platform}`,
    `llmqmnhf=${c.llmq.mnhf}`,
    '',
    `minimumdifficultyblocks=${c.minimumDifficultyBlocks}`,
    `highsubsidyblocks=${c.highSubsidyBlocks}`,
    `highsubsidyfactor=${c.highSubsidyFactor}`,
    `powtargetspacing=${c.blockSeconds}`,
    '',
    ...(c.sporkAddress ? [`sporkaddr=${c.sporkAddress}`, ''] : []),
    `port=${c.port}`,
    ...c.seeds.map((s) => `addnode=${s}`),
    '',
  ].join('\n');
}

export function inventoryFile(f) {
  const line = (h) => [h.name, `public_ip=${h.publicIp || ''}`, `private_ip=${h.privateIp || ''}`, `instance_id=${h.instanceId}`, `arch=${h.arch}`,
    ...(h.proTxHash ? [`protx=${h.proTxHash}`] : []), ...(h.platformNodeId ? [`node_id=${h.platformNodeId}`] : [])].join(' ');
  const groups = {};
  for (const h of f.hosts) (groups[h.role === 'validator' ? 'hp_masternodes' : h.role === 'wallet' ? 'wallet_nodes' : `${h.role}_nodes`] ||= []).push(h.name);
  return [`# ${f.name}: hosts (dash-network-go, SSH user ubuntu)`, ...f.hosts.map(line), '',
    ...Object.entries(groups).flatMap(([g, names]) => [`[${g}]`, ...names, '']), ''].join('\n');
}

// YAML via JSON scalars (valid YAML); nested maps and lists of maps.
function yaml(value, indent = '') {
  const scalar = (v) => (v === null || v === undefined ? 'null' : typeof v === 'string' ? JSON.stringify(v) : String(v));
  if (Array.isArray(value)) {
    if (!value.length) return ' []';
    return value.map((v) => (v && typeof v === 'object'
      ? `\n${indent}- ${yaml(v, indent + '  ').trimStart()}`
      : `\n${indent}- ${scalar(v)}`)).join('');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => (v && typeof v === 'object' && (!Array.isArray(v) || v.length)
      ? `\n${indent}${k}:${yaml(v, indent + '  ')}`
      : `\n${indent}${k}:${Array.isArray(v) ? ' []' : ` ${scalar(v)}`}`)).join('');
  }
  return ` ${scalar(value)}`;
}

export function ymlFile(f) {
  const doc = {
    network: f.name, display_name: f.displayName,
    core: { devnet_name: f.core.devnet, chain: f.core.chain, p2p_port: f.core.port, powtargetspacing: f.core.blockSeconds,
      minimumdifficultyblocks: f.core.minimumDifficultyBlocks, highsubsidyblocks: f.core.highSubsidyBlocks, highsubsidyfactor: f.core.highSubsidyFactor,
      llmqchainlocks: f.core.llmq.chainlocks, llmqinstantsenddip0024: f.core.llmq.instantsendDip0024, llmqplatform: f.core.llmq.platform, llmqmnhf: f.core.llmq.mnhf,
      sporkaddr: f.core.sporkAddress, genesis_core_height: f.core.genesisCoreHeight, premine_height: f.core.premineHeight },
    platform: { chain_id: f.platform.chainId, initial_protocol_version: f.platform.initialProtocolVersion, epoch_time: f.platform.epochSeconds,
      genesis_time: f.platform.genesisTime, gateway_tls: f.platform.gatewayTls, tenderdash_p2p_port: f.platform.tenderdashP2P,
      validator_set_quorum: f.platform.quorums.validatorSet, chain_lock_quorum: f.platform.quorums.chainLock, instant_lock_quorum: f.platform.quorums.instantLock,
      dapi_addresses: f.platform.dapi },
    services: { ...f.services, faucet_address: f.faucetAddress },
    images: Object.fromEntries(f.images.map((i) => [i.component, { requested: i.requested, pinned: i.pinned }])),
    hp_masternodes: Object.fromEntries(f.hosts.filter((h) => h.role === 'validator').map((h) => [h.name,
      { public_ip: h.publicIp, protx: h.proTxHash, operator_public_key: h.operatorPublicKey, platform_node_id: h.platformNodeId }])),
  };
  return `# ${f.name}: network parameters (public facts; private keys stay on the hosts)${yaml(doc)}\n`;
}

export function devnetFiles(f) {
  const n = short(f.name);
  return [
    { name: `devnet-${n}.conf`, title: 'dash.conf', text: confFile(f) },
    { name: `devnet-${n}.inventory`, title: 'Inventory', text: inventoryFile(f) },
    { name: `devnet-${n}.yml`, title: 'Network', text: ymlFile(f) },
  ];
}
