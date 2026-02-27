import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { parseDashmateStatus, parseSystemMetrics, deriveHealthStatus } from './parser.js';
import { setNode, getNode } from './state.js';
import { broadcast } from './sse.js';

const SSH_CONNECT_TIMEOUT = 10000;
const SSH_COMMAND_TIMEOUT = 15000;
// Combined command: dashmate status + system metrics separated by a marker
const DASHMATE_CMD = 'sudo -u dashmate dashmate status; echo "===SYSMETRICS==="; head -1 /proc/loadavg; nproc; free -m | grep Mem; df -h / | tail -1';

let privateKey = null;
let sshUser = 'ubuntu';
let sshPort = 22;
let pollIntervalMs = 4000;
let concurrency = 10;
let polling = false;

export function configure({ sshKeyPath, sshUserName, pollInterval, sshPortNum, pollConcurrency }) {
  if (!existsSync(sshKeyPath)) {
    console.error(`SSH key not found: ${sshKeyPath}`);
    process.exit(1);
  }
  privateKey = readFileSync(sshKeyPath);
  sshUser = sshUserName || 'ubuntu';
  sshPort = sshPortNum || 22;
  pollIntervalMs = pollInterval || 4000;
  concurrency = pollConcurrency || 10;
}

function pollNode(nodeInfo) {
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.end();
        resolve({ success: false, error: 'timeout' });
      }
    }, SSH_CONNECT_TIMEOUT + SSH_COMMAND_TIMEOUT);

    conn.on('ready', () => {
      conn.exec(DASHMATE_CMD, (err, stream) => {
        if (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            conn.end();
            resolve({ success: false, error: err.message });
          }
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });

        stream.on('close', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            conn.end();
            if (stdout.includes('║')) {
              resolve({ success: true, output: stdout });
            } else {
              resolve({ success: false, error: stderr || stdout || 'no output' });
            }
          }
        });
      });
    });

    conn.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      }
    });

    conn.connect({
      host: nodeInfo.host,
      port: sshPort,
      username: sshUser,
      privateKey,
      readyTimeout: SSH_CONNECT_TIMEOUT,
      keepaliveInterval: 5000,
    });
  });
}

function processNodeResult(nodeInfo, result, elapsed) {
  const existing = getNode(nodeInfo.name);

  if (result.success) {
    const [dashmateOutput, metricsBlock] = result.output.split('===SYSMETRICS===');
    const status = parseDashmateStatus(dashmateOutput);
    const health = deriveHealthStatus(status);
    const system = metricsBlock ? parseSystemMetrics(metricsBlock) : null;

    setNode(nodeInfo.name, {
      num: nodeInfo.num,
      type: nodeInfo.type,
      host: nodeInfo.host,
      publicIp: nodeInfo.publicIp,
      privateIp: nodeInfo.privateIp,
      protx: nodeInfo.protx,
      status,
      system,
      health,
      error: null,
      pollDuration: elapsed,
    });
  } else {
    setNode(nodeInfo.name, {
      ...(existing || {}),
      num: nodeInfo.num,
      type: nodeInfo.type,
      host: nodeInfo.host,
      publicIp: nodeInfo.publicIp,
      privateIp: nodeInfo.privateIp,
      protx: nodeInfo.protx,
      health: 'unreachable',
      error: result.error,
      pollDuration: elapsed,
    });
  }

  const updatedNode = getNode(nodeInfo.name);
  broadcast('nodeUpdate', { name: nodeInfo.name, ...updatedNode });
}

async function pollAllNodes(nodes) {
  // Poll in batches of `concurrency` nodes at a time
  for (let i = 0; i < nodes.length; i += concurrency) {
    if (!polling) break;

    const batch = nodes.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (nodeInfo) => {
        const startTime = Date.now();
        try {
          const result = await pollNode(nodeInfo);
          processNodeResult(nodeInfo, result, Date.now() - startTime);
        } catch (err) {
          processNodeResult(nodeInfo, { success: false, error: err.message }, Date.now() - startTime);
        }
      })
    );

    // Wait between batches
    if (polling && i + concurrency < nodes.length) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}

async function pollAllNodesParallel(nodes) {
  const burstStart = Date.now();
  console.log(`Initial burst: polling all ${nodes.length} nodes in parallel...`);

  await Promise.allSettled(
    nodes.map(async (nodeInfo) => {
      const startTime = Date.now();
      try {
        const result = await pollNode(nodeInfo);
        processNodeResult(nodeInfo, result, Date.now() - startTime);
      } catch (err) {
        processNodeResult(nodeInfo, { success: false, error: err.message }, Date.now() - startTime);
      }
    })
  );

  const elapsed = Math.round((Date.now() - burstStart) / 1000);
  console.log(`Initial burst complete in ${elapsed}s`);
}

export async function startPolling(nodes) {
  polling = true;
  console.log(`Starting poller for ${nodes.length} nodes (${pollIntervalMs}ms interval, ${concurrency} concurrent)`);

  // First cycle: hit all nodes in parallel for instant population
  await pollAllNodesParallel(nodes);

  // Subsequent cycles: staggered polling
  while (polling) {
    const cycleStart = Date.now();
    await pollAllNodes(nodes);
    const elapsed = Math.round((Date.now() - cycleStart) / 1000);
    if (polling) {
      console.log(`Poll cycle complete in ${elapsed}s, starting next cycle...`);
    }
  }
}

export function stopPolling() {
  polling = false;
}
