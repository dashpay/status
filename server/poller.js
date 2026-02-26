import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import { parseDashmateStatus, parseSystemMetrics, deriveHealthStatus } from './parser.js';
import { setNode, getNode } from './state.js';
import { broadcast } from './sse.js';

const SSH_CONNECT_TIMEOUT = 10000;
const SSH_COMMAND_TIMEOUT = 15000;
// Combined command: dashmate status + system metrics separated by a marker
const DASHMATE_CMD = 'sudo -u dashmate dashmate status; echo "===SYSMETRICS==="; head -1 /proc/loadavg; nproc; free -m | grep Mem; df -h / | tail -1';

let privateKey = null;
let sshUser = 'ubuntu';
let pollIntervalMs = 4000;
let polling = false;

export function configure({ sshKeyPath, sshUserName, pollInterval }) {
  privateKey = readFileSync(sshKeyPath);
  sshUser = sshUserName || 'ubuntu';
  pollIntervalMs = pollInterval || 4000;
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
      port: 22,
      username: sshUser,
      privateKey,
      readyTimeout: SSH_CONNECT_TIMEOUT,
      keepaliveInterval: 5000,
    });
  });
}

async function pollAllNodes(nodes) {
  for (const nodeInfo of nodes) {
    if (!polling) break;

    const existing = getNode(nodeInfo.name);
    const startTime = Date.now();

    try {
      const result = await pollNode(nodeInfo);
      const elapsed = Date.now() - startTime;

      if (result.success) {
        const [dashmateOutput, metricsBlock] = result.output.split('===SYSMETRICS===');
        const status = parseDashmateStatus(dashmateOutput);
        const health = deriveHealthStatus(status);
        const system = metricsBlock ? parseSystemMetrics(metricsBlock) : null;

        setNode(nodeInfo.name, {
          num: nodeInfo.num,
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
          host: nodeInfo.host,
          publicIp: nodeInfo.publicIp,
          privateIp: nodeInfo.privateIp,
          protx: nodeInfo.protx,
          health: 'unreachable',
          error: result.error,
          pollDuration: elapsed,
        });
      }
    } catch (err) {
      setNode(nodeInfo.name, {
        ...(existing || {}),
        num: nodeInfo.num,
        host: nodeInfo.host,
        publicIp: nodeInfo.publicIp,
        privateIp: nodeInfo.privateIp,
        protx: nodeInfo.protx,
        health: 'unreachable',
        error: err.message,
        pollDuration: Date.now() - startTime,
      });
    }

    // Broadcast the updated node to SSE clients
    const updatedNode = getNode(nodeInfo.name);
    broadcast('nodeUpdate', { name: nodeInfo.name, ...updatedNode });

    // Wait before polling the next node
    if (polling) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}

async function pollAllNodesParallel(nodes) {
  console.log(`Initial burst: polling all ${nodes.length} nodes in parallel...`);
  const results = await Promise.allSettled(
    nodes.map(async (nodeInfo) => {
      const existing = getNode(nodeInfo.name);
      const startTime = Date.now();
      try {
        const result = await pollNode(nodeInfo);
        const elapsed = Date.now() - startTime;
        if (result.success) {
          const [dashmateOutput, metricsBlock] = result.output.split('===SYSMETRICS===');
          const status = parseDashmateStatus(dashmateOutput);
          const health = deriveHealthStatus(status);
          const system = metricsBlock ? parseSystemMetrics(metricsBlock) : null;
          setNode(nodeInfo.name, {
            num: nodeInfo.num, host: nodeInfo.host,
            publicIp: nodeInfo.publicIp, privateIp: nodeInfo.privateIp,
            protx: nodeInfo.protx, status, system, health,
            error: null, pollDuration: elapsed,
          });
        } else {
          setNode(nodeInfo.name, {
            ...(existing || {}),
            num: nodeInfo.num, host: nodeInfo.host,
            publicIp: nodeInfo.publicIp, privateIp: nodeInfo.privateIp,
            protx: nodeInfo.protx, health: 'unreachable',
            error: result.error, pollDuration: elapsed,
          });
        }
      } catch (err) {
        setNode(nodeInfo.name, {
          ...(existing || {}),
          num: nodeInfo.num, host: nodeInfo.host,
          publicIp: nodeInfo.publicIp, privateIp: nodeInfo.privateIp,
          protx: nodeInfo.protx, health: 'unreachable',
          error: err.message, pollDuration: Date.now() - startTime,
        });
      }
      const updatedNode = getNode(nodeInfo.name);
      broadcast('nodeUpdate', { name: nodeInfo.name, ...updatedNode });
    })
  );
  const elapsed = Math.round((Date.now() - Date.now()) / 1000);
  console.log(`Initial burst complete: ${results.filter(r => r.status === 'fulfilled').length}/${nodes.length} nodes`);
}

export async function startPolling(nodes) {
  polling = true;
  console.log(`Starting poller for ${nodes.length} nodes (${pollIntervalMs}ms interval)`);

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
