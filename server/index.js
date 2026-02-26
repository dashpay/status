import 'dotenv/config';
import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { parseInventory } from './inventory.js';
import { initNode, getAllNodes, getNode } from './state.js';
import { addClient, getClientCount } from './sse.js';
import { configure, startPolling } from './poller.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Parse inventory
const inventoryPath = process.env.INVENTORY_PATH;
if (!inventoryPath || !existsSync(inventoryPath)) {
  console.error(`Inventory file not found: ${inventoryPath}`);
  console.error('Set INVENTORY_PATH in .env');
  process.exit(1);
}

const nodes = parseInventory(inventoryPath);
console.log(`Loaded ${nodes.length} HP masternodes from inventory`);

// Initialize state for all nodes
for (const node of nodes) {
  initNode(node);
}

// Configure SSH poller
configure({
  sshKeyPath: process.env.SSH_KEY_PATH,
  sshUserName: process.env.SSH_USER || 'ubuntu',
  pollInterval: parseInt(process.env.POLL_INTERVAL_MS || '4000', 10),
});

// API routes
app.get('/api/nodes', (req, res) => {
  res.json(getAllNodes());
});

app.get('/api/nodes/:name', (req, res) => {
  const node = getNode(req.params.name);
  if (!node) {
    res.status(404).json({ error: 'Node not found' });
    return;
  }
  res.json({ name: req.params.name, ...node });
});

app.get('/api/events', (req, res) => {
  addClient(res);
});

app.get('/api/health', (req, res) => {
  const allNodes = getAllNodes();
  const counts = { healthy: 0, syncing: 0, error: 0, banned: 0, warning: 0, unreachable: 0, unknown: 0 };
  for (const node of allNodes) {
    counts[node.health] = (counts[node.health] || 0) + 1;
  }
  res.json({
    totalNodes: allNodes.length,
    sseClients: getClientCount(),
    ...counts,
  });
});

// Serve static frontend in production
const distPath = join(__dirname, '..', 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('/{*path}', (req, res) => {
    res.sendFile(join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Dashboard API running on http://localhost:${PORT}`);
  // Start polling in the background
  startPolling(nodes);
});
