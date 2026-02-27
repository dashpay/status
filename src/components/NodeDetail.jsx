import { useEffect, useRef } from 'react';

const healthLabels = {
  healthy: { text: 'Healthy', classes: 'bg-emerald-500/20 text-emerald-400' },
  syncing: { text: 'Syncing', classes: 'bg-amber-500/20 text-amber-400' },
  warning: { text: 'Warning', classes: 'bg-yellow-500/20 text-yellow-400' },
  error: { text: 'Error', classes: 'bg-red-500/20 text-red-400' },
  banned: { text: 'PoSe Banned', classes: 'bg-red-700/20 text-red-400' },
  unreachable: { text: 'Unreachable', classes: 'bg-gray-500/20 text-gray-400' },
  unknown: { text: 'Unknown', classes: 'bg-gray-700/20 text-gray-500' },
};

function Row({ label, value, highlight }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-gray-800">
      <span className="text-gray-500 text-sm">{label}</span>
      <span className={`text-sm font-mono ${highlight || 'text-gray-200'}`}>
        {value ?? 'n/a'}
      </span>
    </div>
  );
}

export default function NodeDetail({ node, onClose }) {
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!node) return;

    // Store the element that had focus before the modal opened
    previousFocusRef.current = document.activeElement;

    // Focus the dialog
    dialogRef.current?.focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus
      previousFocusRef.current?.focus();
    };
  }, [node, onClose]);

  if (!node) return null;

  const health = node.health || 'unknown';
  const hl = healthLabels[health];
  const s = node.status || {};

  const lastUpdated = node.lastUpdated
    ? new Date(node.lastUpdated).toLocaleTimeString()
    : 'never';

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="node-detail-title"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-gray-900 border border-gray-700 rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <h2 id="node-detail-title" className="text-lg font-bold text-gray-100">
              {node.name}
            </h2>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${node.type === 'hp' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400'}`}>
              {node.type === 'hp' ? 'HP' : 'Regular'}
            </span>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${hl.classes}`}>
              {hl.text}
            </span>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Network */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Network</h3>
            <Row label="IP" value={node.host} />
            <Row label="Private IP" value={node.privateIp} />
            <Row label="ProTx" value={node.protx ? `${node.protx.slice(0, 12)}...` : null} />
            <Row label="Network" value={s.network} />
          </div>

          {/* Core */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Core</h3>
            <Row label="Version" value={s.coreVersion} />
            <Row label="Status" value={s.coreServiceStatus}
              highlight={s.coreServiceStatus === 'up' ? 'text-emerald-400' : 'text-amber-400'} />
            <Row label="Height" value={s.coreHeight?.toLocaleString()} />
            <Row label="Sync Progress" value={s.coreSyncProgress} />
            <Row label="Size" value={s.coreSize} />
          </div>

          {/* Masternode */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Masternode</h3>
            <Row label="State" value={s.masternodeState}
              highlight={s.masternodeState === 'READY' ? 'text-emerald-400' : s.masternodeState === 'POSE_BANNED' ? 'text-red-400' : 'text-amber-400'} />
            <Row label="PoSe Penalty" value={s.posePenalty}
              highlight={s.posePenalty === 0 ? 'text-emerald-400' : s.posePenalty > 0 ? 'text-red-400' : ''} />
            <Row label="Last Paid" value={s.lastPaidTime} />
            <Row label="Queue Position" value={s.paymentQueuePosition} />
            <Row label="Next Payment" value={s.nextPaymentTime} />
          </div>

          {/* Platform */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Platform</h3>
            <Row label="Status" value={s.platformStatus}
              highlight={s.platformStatus === 'up' ? 'text-emerald-400' : s.platformStatus === 'error' ? 'text-red-400' : 'text-amber-400'} />
            <Row label="Version" value={s.platformVersion} />
            <Row label="Block Height" value={s.platformBlockHeight?.toLocaleString()} />
            <Row label="Peers" value={s.platformPeers} />
            <Row label="Network" value={s.platformNetwork} />
          </div>

          {/* System */}
          {node.system && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">System</h3>
              <Row label="CPU" value={`${node.system.cpuPercent}% (load: ${node.system.loadAvg1} / ${node.system.loadAvg5} / ${node.system.loadAvg15})`}
                highlight={node.system.cpuPercent >= 90 ? 'text-red-400' : node.system.cpuPercent >= 70 ? 'text-amber-400' : 'text-emerald-400'} />
              <Row label="CPU Cores" value={node.system.cpuCores} />
              <Row label="Memory" value={`${node.system.memUsedMB} / ${node.system.memTotalMB} MB (${node.system.memPercent}%)`}
                highlight={node.system.memPercent >= 90 ? 'text-red-400' : node.system.memPercent >= 70 ? 'text-amber-400' : 'text-emerald-400'} />
              <Row label="Disk" value={`${node.system.diskUsed} / ${node.system.diskTotal} (${node.system.diskPercent}%)`}
                highlight={node.system.diskPercent >= 90 ? 'text-red-400' : node.system.diskPercent >= 70 ? 'text-amber-400' : 'text-emerald-400'} />
            </div>
          )}

          {/* Meta */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Polling</h3>
            <Row label="Last Updated" value={lastUpdated} />
            <Row label="Poll Duration" value={node.pollDuration ? `${node.pollDuration}ms` : null} />
            {node.error && <Row label="Error" value={node.error} highlight="text-red-400" />}
          </div>
        </div>
      </div>
    </div>
  );
}
