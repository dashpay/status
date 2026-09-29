// EC2 is the inventory. Hosts are found by their network tag and by the
// `dn-<tag>-<role>-<n>` naming convention, so new seeds, web or wallet hosts
// appear without editing a manifest.
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';

const ROLES = [
  [/^hp-masternode-(\d+)/, 'validator', (m) => `hp-masternode-${m[1]}`],
  [/^masternode-(\d+)/, 'masternode', (m) => `masternode-${m[1]}`],
  [/^seed-(\d+)/, 'seed', (m) => `seed-${m[1]}`],
  [/^web-(\d+)/, 'web', (m) => `web-${m[1]}`],
  [/^dashd-wallet-(\d+)/, 'wallet', (m) => `wallet-${m[1]}`],
  [/^miner-(\d+)/, 'miner', (m) => `miner-${m[1]}`],
  [/^mixer-(\d+)/, 'mixer', (m) => `mixer-${m[1]}`],
  [/^quorum-list-server-(\d+)/, 'quorums', (m) => `quorums-${m[1]}`],
  [/^prometheus-(\d+)/, 'metrics', (m) => `metrics-${m[1]}`],
  [/^logs-(\d+)/, 'logs', (m) => `logs-${m[1]}`],
  [/^vpn$/, 'vpn', () => 'vpn'],
];
const DASHNET_ROLES = { validator: 'validator', wallet: 'wallet', miner: 'miner', fullnode: 'fullnode', seed: 'seed' };
export const ROLE_ORDER = ['validator', 'masternode', 'seed', 'fullnode', 'web', 'wallet', 'miner', 'mixer', 'quorums', 'metrics', 'logs', 'vpn', 'other'];

export function classify(tagValue, nameTag) {
  const prefix = new RegExp(`^d[nh]-${tagValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(.+)$`);
  const m = prefix.exec(nameTag || '');
  if (!m) return null;
  for (const [re, role, name] of ROLES) {
    const r = re.exec(m[1]);
    if (r) return { role, name: name(r), variant: m[1] };
  }
  return { role: 'other', name: m[1].replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 63), variant: m[1] };
}

export function createDiscovery({ region, tagKey }, client = new EC2Client({ region })) {
  async function describe(filters) {
    const out = [];
    let NextToken;
    do {
      const page = await client.send(new DescribeInstancesCommand({ Filters: filters, NextToken, MaxResults: 1000 }));
      for (const r of page.Reservations || []) out.push(...(r.Instances || []));
      NextToken = page.NextToken;
    } while (NextToken);
    return out;
  }
  return async function discover(networks) {
    const states = { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] };
    // External/report-backed networks are intentionally not discovered from
    // EC2.  Mainnet uses a separately managed observer/fullnode and must not
    // accidentally enroll or monitor the existing mainnet-support fleet.
    const discovered = networks.filter((n) => n.source !== 'report');
    const tags = discovered.map((n) => n.tag);
    if (!tags.length) return Object.fromEntries(networks.map((n) => [n.name, []]));
    const [tagged, named] = await Promise.all([
      describe([{ Name: `tag:${tagKey}`, Values: tags }, states]),
      describe([{ Name: 'tag:Name', Values: tags.flatMap((t) => [`dn-${t}-*`, `dh-${t}-*`]) }, states]),
    ]);
    const byId = new Map([...tagged, ...named].map((i) => [i.InstanceId, i]));
    const result = Object.fromEntries(networks.map((n) => [n.name, []]));
    for (const i of byId.values()) {
      const tag = (k) => i.Tags?.find((t) => t.Key === k)?.Value;
      const nameTag = tag('Name');
      for (const n of discovered) {
        // dash-network-go instances carry their role and node name as tags.
        const c = tag('dashnet:managed-by') === 'dash-network-go' && tag('dashnet:network') === n.tag
          ? { role: DASHNET_ROLES[tag('dashnet:role')] || 'other', name: tag('dashnet:node') || i.InstanceId }
          : classify(n.tag, nameTag);
        if (!c || (tag(tagKey) && tag(tagKey) !== n.tag)) continue;
        result[n.name].push({
          name: c.name, role: c.role, nameTag, instanceId: i.InstanceId, state: i.State?.Name,
          publicIp: i.PublicIpAddress || null, privateIp: i.PrivateIpAddress || null,
          instanceType: i.InstanceType, arch: i.Architecture === 'arm64' ? 'arm64' : 'amd64',
          az: i.Placement?.AvailabilityZone, launchTime: i.LaunchTime ? new Date(i.LaunchTime).toISOString() : null,
          keyName: i.KeyName || null, tagged: tag(tagKey) === n.tag,
        });
      }
    }
    // Several instances may share a canonical name (e.g. a restore test that now
    // holds the address). The running one wins; others stay visible as extras.
    for (const [net, hosts] of Object.entries(result)) {
      const seen = new Map();
      hosts.sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || a.nameTag.localeCompare(b.nameTag));
      for (const h of hosts) {
        if (!seen.has(h.name)) { seen.set(h.name, h); continue; }
        h.name = `${h.name}~${h.instanceId.slice(-5)}`;
        h.duplicate = true;
      }
      result[net] = hosts.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || naturalCompare(a.name, b.name));
    }
    return result;
  };
}

export function naturalCompare(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}
