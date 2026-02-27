import { readFileSync } from 'fs';

export function parseInventory(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const nodes = [];

  for (const line of content.split('\n')) {
    const match = line.match(/^((hp-)?masternode-\d+)\s+(.+)/);
    if (!match) continue;

    const name = match[1];
    const isHp = !!match[2];
    const attrs = match[3];

    const host = attrs.match(/ansible_host=(\S+)/)?.[1];
    const publicIp = attrs.match(/public_ip=(\S+)/)?.[1];
    const privateIp = attrs.match(/private_ip=(\S+)/)?.[1];
    const protx = attrs.match(/protx=(\S+)/)?.[1];

    if (!host) continue;

    const num = parseInt(name.replace(/^(hp-)?masternode-/, ''), 10);

    nodes.push({
      name,
      num,
      type: isHp ? 'hp' : 'mn',
      host,
      publicIp: publicIp || host,
      privateIp: privateIp || null,
      protx: protx || null,
    });
  }

  // Sort: HP masternodes first, then regular, each by number
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'hp' ? -1 : 1;
    return a.num - b.num;
  });
  return nodes;
}
