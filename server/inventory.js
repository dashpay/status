import { readFileSync } from 'fs';

export function parseInventory(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const nodes = [];

  for (const line of content.split('\n')) {
    const match = line.match(/^(hp-masternode-\d+)\s+(.+)/);
    if (!match) continue;

    const name = match[1];
    const attrs = match[2];

    const host = attrs.match(/ansible_host=(\S+)/)?.[1];
    const publicIp = attrs.match(/public_ip=(\S+)/)?.[1];
    const privateIp = attrs.match(/private_ip=(\S+)/)?.[1];
    const protx = attrs.match(/protx=(\S+)/)?.[1];

    if (!host) continue;

    const num = parseInt(name.replace('hp-masternode-', ''), 10);

    nodes.push({
      name,
      num,
      host,
      publicIp: publicIp || host,
      privateIp: privateIp || null,
      protx: protx || null,
    });
  }

  nodes.sort((a, b) => a.num - b.num);
  return nodes;
}
