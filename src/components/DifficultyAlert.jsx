function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

export default function DifficultyAlert({ alert }) {
  if (!alert) return null;

  const difficulty = alert.difficulty.toLocaleString(undefined, {
    maximumFractionDigits: alert.difficulty >= 10 ? 0 : 6,
  });
  const tipAge = formatDuration(alert.ageSeconds);
  const height = alert.height.toLocaleString();

  return (
    <div className="border border-sky-500/30 bg-sky-500/10 rounded-lg px-4 py-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-sky-200">
            Possible testnet difficulty pause
          </div>
          <div className="text-sm text-sky-100/80">
            Best Core block {height} is {tipAge} old while difficulty is {difficulty}. This can happen after
            ASIC mining spikes testnet difficulty; CPU miners may resume once min-difficulty rules allow it.
          </div>
        </div>
        <div className="text-xs text-sky-200/70 font-mono sm:text-right shrink-0">
          {alert.sourceNode}
        </div>
      </div>
    </div>
  );
}
