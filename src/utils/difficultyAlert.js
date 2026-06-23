export const DEFAULT_DIFFICULTY_ALERT_THRESHOLD = 1;
export const DEFAULT_STALE_BLOCK_SECONDS = 45 * 60;

function isUsableNode(node) {
  const status = node.status || {};
  return status.coreServiceStatus === 'up'
    && Number.isFinite(status.coreHeight)
    && Number.isFinite(status.coreDifficulty)
    && Number.isFinite(status.coreBestBlockTime);
}

export function getDifficultyAlert(nodes, nowMs = Date.now(), options = {}) {
  const difficultyThreshold = options.difficultyThreshold ?? DEFAULT_DIFFICULTY_ALERT_THRESHOLD;
  const staleBlockSeconds = options.staleBlockSeconds ?? DEFAULT_STALE_BLOCK_SECONDS;

  const bestNode = [...nodes]
    .filter(isUsableNode)
    .sort((a, b) => {
      const heightDelta = b.status.coreHeight - a.status.coreHeight;
      if (heightDelta !== 0) return heightDelta;
      return (b.lastUpdated || 0) - (a.lastUpdated || 0);
    })[0];

  if (!bestNode) return null;

  const status = bestNode.status;
  const ageSeconds = Math.max(0, Math.floor(nowMs / 1000 - status.coreBestBlockTime));
  if (ageSeconds < staleBlockSeconds || status.coreDifficulty < difficultyThreshold) {
    return null;
  }

  return {
    type: 'testnet_difficulty_stall',
    severity: 'info',
    sourceNode: bestNode.name,
    height: status.coreHeight,
    bestBlockHash: status.coreBestBlockHash,
    bestBlockTime: status.coreBestBlockTime,
    difficulty: status.coreDifficulty,
    ageSeconds,
  };
}
