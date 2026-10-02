import 'dotenv/config';

// One image, three roles:
//   web    public board and operator console (no cloud/SSH credentials)
//   agent  discovery, host probes and dashnet operations
//   legacy the original single-network Testnet API (INVENTORY_PATH)
const mode = process.env.STATUS_MODE || (process.env.INVENTORY_PATH ? 'legacy' : 'web');
if (mode === 'agent') await import('../agent/index.js');
else if (mode === 'legacy') await import('./legacy.js');
else if (mode === 'incidents') (await import('./incident-service.js')).startIncidents();
else if (mode === 'web') (await import('./web.js')).startWeb();
else throw new Error(`unknown STATUS_MODE ${mode}`);
