// Manage Server-Sent Events connections
const MAX_SSE_CLIENTS = 100;
const HEARTBEAT_INTERVAL = 30000;

const clients = new Set();
let heartbeatTimer = null;

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(':keepalive\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, HEARTBEAT_INTERVAL);
}

export function addClient(res) {
  if (clients.size >= MAX_SSE_CLIENTS) {
    res.status(503).json({ error: 'Too many SSE clients' });
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('\n');
  clients.add(res);

  res.on('close', () => {
    clients.delete(res);
  });

  startHeartbeat();
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function getClientCount() {
  return clients.size;
}

export function closeAll() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const client of clients) {
    try { client.end(); } catch { /* ignore */ }
  }
  clients.clear();
}
