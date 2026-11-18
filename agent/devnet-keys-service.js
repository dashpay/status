import { startKeyService } from './devnet-keys.js';
startKeyService({ dataDir: process.env.STATUS_DATA_DIR || '/data', privateDir: process.env.AGENT_PRIVATE_DIR || '/agent', socketPath: process.env.DEVNET_KEYS_SOCKET || '/key-access/keys.sock' });
