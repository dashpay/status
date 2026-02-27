// Parse system metrics from the ===SYSMETRICS=== section
// Format: loadavg line, nproc line, free -m Mem line, df -h / line
export function parseSystemMetrics(metricsBlock) {
  const lines = metricsBlock.trim().split('\n').filter(Boolean);
  const metrics = {};

  // Line 0: /proc/loadavg - "0.52 0.48 0.41 2/350 12345"
  if (lines[0]) {
    const parts = lines[0].split(/\s+/);
    metrics.loadAvg1 = parseFloat(parts[0]) || 0;
    metrics.loadAvg5 = parseFloat(parts[1]) || 0;
    metrics.loadAvg15 = parseFloat(parts[2]) || 0;
  }

  // Line 1: nproc - "4"
  if (lines[1]) {
    metrics.cpuCores = parseInt(lines[1], 10) || 1;
    // CPU usage as percentage of cores (load1 / cores * 100)
    metrics.cpuPercent = Math.round((metrics.loadAvg1 / metrics.cpuCores) * 100);
  }

  // Line 2: free -m Mem line - "Mem:           7839        4521         234         123        3083        2994"
  if (lines[2]) {
    const parts = lines[2].split(/\s+/);
    metrics.memTotalMB = parseInt(parts[1], 10) || 0;
    metrics.memUsedMB = parseInt(parts[2], 10) || 0;
    metrics.memFreeMB = parseInt(parts[3], 10) || 0;
    metrics.memAvailableMB = parseInt(parts[6], 10) || metrics.memFreeMB;
    metrics.memPercent = metrics.memTotalMB > 0
      ? Math.round((metrics.memUsedMB / metrics.memTotalMB) * 100)
      : 0;
  }

  // Line 3: df -h / line - "/dev/root        58G   23G   36G  39% /"
  if (lines[3]) {
    const parts = lines[3].split(/\s+/);
    metrics.diskTotal = parts[1] || null;
    metrics.diskUsed = parts[2] || null;
    metrics.diskFree = parts[3] || null;
    metrics.diskPercent = parseInt(parts[4], 10) || 0;
  }

  return metrics;
}

// Parse the box-drawing table output from `dashmate status`
// Example line: ║ Core Version           │ 23.0.2                                          ║
export function parseDashmateStatus(output) {
  const result = {};

  for (const line of output.split('\n')) {
    // Match lines with ║ key │ value ║ pattern
    const match = line.match(/║\s*(.+?)\s*│\s*(.+?)\s*║/);
    if (!match) continue;

    const key = match[1].trim();
    const value = match[2].trim();

    switch (key) {
      case 'Network':
        result.network = value;
        break;
      case 'Core Version':
        result.coreVersion = value;
        break;
      case 'Core Status':
        result.coreStatus = value;
        break;
      case 'Core Service Status':
        result.coreServiceStatus = value;
        break;
      case 'Core Size':
        result.coreSize = value;
        break;
      case 'Core Height':
        result.coreHeight = value === 'n/a' ? null : parseInt(value, 10);
        break;
      case 'Core Sync Progress':
        result.coreSyncProgress = value === 'n/a' ? null : value;
        break;
      case 'Masternode Enabled':
        result.masternodeEnabled = value === 'true';
        break;
      case 'Masternode State':
        result.masternodeState = value;
        break;
      case 'Masternode ProTX':
        result.masternodeProTx = value === 'n/a' ? null : value;
        break;
      case 'PoSe Penalty':
        result.posePenalty = value === 'n/a' ? null : parseInt(value, 10);
        break;
      case 'Last paid block':
        result.lastPaidBlock = value === 'n/a' ? null : parseInt(value, 10);
        break;
      case 'Last paid time':
        result.lastPaidTime = value === 'n/a' ? null : value;
        break;
      case 'Payment queue position':
        result.paymentQueuePosition = value === 'n/a' ? null : parseInt(value, 10);
        break;
      case 'Next payment time':
        result.nextPaymentTime = value === 'n/a' ? null : value;
        break;
      case 'Platform Enabled':
        result.platformEnabled = value === 'true';
        break;
      case 'Platform Status':
        result.platformStatus = value;
        break;
      case 'Platform Version':
        result.platformVersion = value === 'n/a' ? null : value;
        break;
      case 'Platform Block Height':
        result.platformBlockHeight = value === 'n/a' ? null : parseInt(value, 10);
        break;
      case 'Platform Peers':
        result.platformPeers = value === 'n/a' ? null : parseInt(value, 10);
        break;
      case 'Platform Network':
        result.platformNetwork = value === 'n/a' ? null : value;
        break;
    }
  }

  return result;
}

// Parse dash-cli JSON output for regular masternodes
export function parseDashCliStatus(blockchainJson, masternodeJson) {
  const result = {};

  try {
    const chain = JSON.parse(blockchainJson.trim());
    result.network = chain.chain === 'test' ? 'testnet' : chain.chain;
    result.coreHeight = chain.blocks || null;
    result.coreServiceStatus = chain.initialblockdownload ? 'syncing' : 'up';
    const progress = chain.verificationprogress;
    if (progress != null) {
      result.coreSyncProgress = progress >= 0.9999 ? '100%' : `${(progress * 100).toFixed(2)}%`;
    }
    result.coreSize = chain.size_on_disk
      ? `${(chain.size_on_disk / (1024 ** 3)).toFixed(1)} GB`
      : null;
  } catch { /* blockchain info unavailable */ }

  try {
    const mn = JSON.parse(masternodeJson.trim());
    result.masternodeState = mn.state?.toUpperCase() || mn.status?.toUpperCase() || null;
    result.masternodeProTx = mn.proTxHash || null;
    result.posePenalty = mn.dmnState?.PoSePenalty ?? null;
    if (mn.dmnState?.PoSeBanHeight > 0) {
      result.masternodeState = 'POSE_BANNED';
    }
    result.lastPaidBlock = mn.dmnState?.lastPaidHeight || null;
  } catch { /* masternode info unavailable */ }

  // Regular masternodes don't have platform
  result.platformEnabled = false;
  result.platformStatus = null;

  return result;
}

// Derive overall health status from parsed data
export function deriveHealthStatus(data) {
  if (!data || Object.keys(data).length === 0) return 'unreachable';
  if (data.masternodeState === 'POSE_BANNED') return 'banned';
  if (data.masternodeState === 'ERROR') return 'error';
  if (data.platformStatus === 'error') return 'error';
  if (data.coreServiceStatus === 'syncing' || (data.coreSyncProgress && data.coreSyncProgress !== '100%')) return 'syncing';
  if (data.platformStatus === 'syncing' || data.platformStatus === 'wait_for_core') return 'syncing';
  // HP nodes need platform up to be healthy; regular nodes just need READY
  if (data.masternodeState === 'READY' && data.platformEnabled === false) return 'healthy';
  if (data.masternodeState === 'READY' && data.platformStatus === 'up') return 'healthy';
  if (data.masternodeState === 'READY') return 'warning';
  return 'warning';
}
