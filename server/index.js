import 'dotenv/config';

if (process.env.NETWORKS_CONFIG) {
  const { startConsole } = await import('./console.js');
  const server = startConsole(process.env.NETWORKS_CONFIG);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
} else {
  await import('./legacy.js');
}
