// In-memory state store for node data
const nodes = new Map();

// Global proposer state (network-wide, not per-node)
let proposerState = {
  currentProposer: null,      // ProTX hash of current block proposer
  nextProposer: null,         // ProTX hash of next block proposer
  currentProposerNode: null,  // resolved node name
  nextProposerNode: null,     // resolved node name
  platformHeight: null,
  updatedAt: null,
};

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
    const nodeData = { name, ...data };
    if (proposerState.currentProposerNode === name) {
      nodeData.proposerRole = 'current';
    } else if (proposerState.nextProposerNode === name) {
      nodeData.proposerRole = 'next';
    } else {
      nodeData.proposerRole = null;
    }
    result.push(nodeData);
  }
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'hp' ? -1 : 1;
    return (a.num || 0) - (b.num || 0);
  });
  return result;
}

export function initNode(nodeInfo) {
  if (!nodes.has(nodeInfo.name)) {
    nodes.set(nodeInfo.name, {
      num: nodeInfo.num,
      type: nodeInfo.type,
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

export function getProposerState() {
  return { ...proposerState };
}

export function setProposerState(state) {
  proposerState = { ...proposerState, ...state, updatedAt: Date.now() };
}

// Resolve proposer ProTX hashes to node names using inventory protx
export function resolveProposerNodes() {
  const protxMap = new Map();
  for (const [name, data] of nodes) {
    if (data.protx) {
      protxMap.set(data.protx.toUpperCase(), name);
    }
  }

  proposerState.currentProposerNode = proposerState.currentProposer
    ? protxMap.get(proposerState.currentProposer.toUpperCase()) || null
    : null;
  proposerState.nextProposerNode = proposerState.nextProposer
    ? protxMap.get(proposerState.nextProposer.toUpperCase()) || null
    : null;
}
