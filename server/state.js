// In-memory state store for node data
const nodes = new Map();

export function getNode(name) {
  return nodes.get(name) || null;
}

export function setNode(name, data) {
  nodes.set(name, {
    ...data,
    lastUpdated: Date.now(),
  });
}

export function getAllNodes() {
  const result = [];
  for (const [name, data] of nodes) {
    result.push({ name, ...data });
  }
  result.sort((a, b) => (a.num || 0) - (b.num || 0));
  return result;
}

export function initNode(nodeInfo) {
  if (!nodes.has(nodeInfo.name)) {
    nodes.set(nodeInfo.name, {
      num: nodeInfo.num,
      host: nodeInfo.host,
      publicIp: nodeInfo.publicIp,
      privateIp: nodeInfo.privateIp,
      protx: nodeInfo.protx,
      status: null,
      health: 'unknown',
      error: null,
      lastUpdated: null,
    });
  }
}
