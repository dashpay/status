const healthStyles = {
  healthy: 'border-emerald-500/30 bg-emerald-500/5',
  syncing: 'border-amber-500/30 bg-amber-500/5',
  warning: 'border-yellow-500/30 bg-yellow-500/5',
  error: 'border-red-500/30 bg-red-500/5',
  banned: 'border-red-700/30 bg-red-700/5',
  unreachable: 'border-gray-500/30 bg-gray-500/5',
  unknown: 'border-gray-700/30 bg-gray-700/5',
};

const healthDot = {
  healthy: 'bg-emerald-500',
  syncing: 'bg-amber-500 animate-pulse',
  warning: 'bg-yellow-500',
  error: 'bg-red-500',
  banned: 'bg-red-700',
  unreachable: 'bg-gray-500',
  unknown: 'bg-gray-700',
};

function timeAgo(timestamp) {
  if (!timestamp) return 'never';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function MiniBar({ percent, color }) {
  return (
    <div className="h-1 w-full bg-gray-800 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${Math.min(percent, 100)}%` }}
      />
    </div>
  );
}

function barColor(percent) {
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

export default function NodeCard({ node, onClick }) {
  const health = node.health || 'unknown';
  const s = node.status || {};
  const sys = node.system || {};

  const displayName = node.type === 'hp'
    ? `HP ${node.name.replace('hp-masternode-', '')}`
    : `MN ${node.name.replace('masternode-', '')}`;
  const coreInfo = s.coreServiceStatus === 'syncing'
    ? `Core: ${s.coreSyncProgress || 'syncing'}`
    : s.coreServiceStatus === 'up'
      ? `Core: up`
      : `Core: ${s.coreServiceStatus || '—'}`;

  const showPlatform = s.platformEnabled !== false;
  const platformInfo = showPlatform
    ? (s.platformStatus === 'up'
      ? `Plat: ${s.platformBlockHeight || 'up'}`
      : s.platformStatus
        ? `Plat: ${s.platformStatus}`
        : 'Plat: —')
    : null;

  const mnState = s.masternodeState || '—';
  const pose = s.posePenalty !== null && s.posePenalty !== undefined
    ? `PoSe: ${s.posePenalty}`
    : '';

  const hasSys = sys.cpuPercent !== undefined;

  return (
    <button
      onClick={() => onClick?.(node)}
      className={`border rounded-lg p-3 text-left transition-all hover:scale-[1.02] hover:shadow-lg cursor-pointer w-full ${healthStyles[health]}`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${healthDot[health]}`} />
        <span className="font-semibold text-sm text-gray-100 truncate">{displayName}</span>
      </div>

      <div className="space-y-0.5 text-xs font-mono">
        <div className={`${mnState === 'READY' ? 'text-emerald-400' : mnState === 'POSE_BANNED' ? 'text-red-400' : 'text-gray-400'}`}>
          {mnState}
        </div>
        <div className="text-gray-400">{coreInfo}</div>
        {platformInfo && <div className="text-gray-400">{platformInfo}</div>}
        {pose && <div className="text-gray-500">{pose}</div>}
      </div>

      {hasSys && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 w-7">CPU</span>
            <MiniBar percent={sys.cpuPercent} color={barColor(sys.cpuPercent)} />
            <span className="text-[10px] text-gray-500 w-7 text-right">{sys.cpuPercent}%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 w-7">MEM</span>
            <MiniBar percent={sys.memPercent} color={barColor(sys.memPercent)} />
            <span className="text-[10px] text-gray-500 w-7 text-right">{sys.memPercent}%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 w-7">DSK</span>
            <MiniBar percent={sys.diskPercent} color={barColor(sys.diskPercent)} />
            <span className="text-[10px] text-gray-500 w-7 text-right">{sys.diskPercent}%</span>
          </div>
        </div>
      )}

      <div className="mt-2 text-[10px] text-gray-600">
        {timeAgo(node.lastUpdated)}
      </div>
    </button>
  );
}
