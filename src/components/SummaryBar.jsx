const statusConfig = {
  healthy: { label: 'Healthy', color: 'bg-emerald-500', textColor: 'text-emerald-400' },
  syncing: { label: 'Syncing', color: 'bg-amber-500', textColor: 'text-amber-400' },
  warning: { label: 'Warning', color: 'bg-yellow-500', textColor: 'text-yellow-400' },
  error: { label: 'Error', color: 'bg-red-500', textColor: 'text-red-400' },
  banned: { label: 'Banned', color: 'bg-red-700', textColor: 'text-red-400' },
  unreachable: { label: 'Unreachable', color: 'bg-gray-500', textColor: 'text-gray-400' },
  unknown: { label: 'Unknown', color: 'bg-gray-600', textColor: 'text-gray-500' },
};

export default function SummaryBar({ nodes }) {
  const counts = {};
  for (const node of nodes) {
    const h = node.health || 'unknown';
    counts[h] = (counts[h] || 0) + 1;
  }

  // Show in priority order
  const order = ['healthy', 'syncing', 'warning', 'error', 'banned', 'unreachable', 'unknown'];

  return (
    <div className="flex flex-wrap gap-4 items-center">
      {order.map((key) => {
        const count = counts[key] || 0;
        if (count === 0) return null;
        const cfg = statusConfig[key];
        return (
          <div key={key} className="flex items-center gap-2">
            <span className={`inline-block w-3 h-3 rounded-full ${cfg.color}`} />
            <span className={`text-sm font-medium ${cfg.textColor}`}>
              {count} {cfg.label}
            </span>
          </div>
        );
      })}
      <div className="ml-auto text-sm text-gray-500">
        {nodes.length} total nodes
      </div>
    </div>
  );
}
