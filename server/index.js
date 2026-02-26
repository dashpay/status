import 'dotenv/config';
import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { parseInventory } from './inventory.js';
import { initNode, getAllNodes, getNode } from './state.js';
import { addClient, getClientCount, closeAll as closeSSE } from './sse.js';
import { configure, startPolling, stopPolling } from './poller.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const API_TOKEN = process.env.API_TOKEN || null;

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline styles from Tailwind
}));

// Rate limiting
app.use('/api/', rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Auth middleware (optional - only enforced if API_TOKEN is set)
function authMiddleware(req, res, next) {
  if (!API_TOKEN) return next();
  if (req.headers.authorization === `Bearer ${API_TOKEN}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

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
  sshPortNum: parseInt(process.env.SSH_PORT || '22', 10),
});

// API routes
app.get('/api/nodes', authMiddleware, (req, res) => {
  res.json(getAllNodes());
});

app.get('/api/nodes/:name', authMiddleware, (req, res) => {
  if (!/^hp-masternode-\d+$/.test(req.params.name)) {
    res.status(400).json({ error: 'Invalid node name' });
    return;
  }
  const node = getNode(req.params.name);
  if (!node) {
    res.status(404).json({ error: 'Node not found' });
    return;
  }
  res.json({ name: req.params.name, ...node });
});

app.get('/api/events', authMiddleware, (req, res) => {
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

const server = app.listen(PORT, () => {
  console.log(`Dashboard API running on http://localhost:${PORT}`);
  // Start polling in the background
  startPolling(nodes);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  stopPolling();
  closeSSE();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
