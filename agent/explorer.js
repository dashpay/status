import { readFileSync } from 'node:fs';
const SCRIPT = readFileSync(new URL('./explorer-chain.py', import.meta.url), 'utf8');

// Separate from validator stages: this only touches the owned wallet-host index.
export async function reconcileExplorer({ pool, target, network, chain, anchor, checkOnly = false }) {
  const q = Buffer.from(JSON.stringify({ auxiliary: `${network}/${target.name}`, chain, anchor, checkOnly })).toString('base64');
  const out = await pool.exec({ name: target.name, instanceId: target.instanceId, publicIp: target.sshAddress, role: target.role }, `sudo -n python3 - ${q}`, SCRIPT, 20 * 60_000);
  const result = JSON.parse(out.trim().split('\n').pop());
  if (!result.ok) throw Error(`Explorer: ${result.error || 'reconciliation failed'}`);
  return result.result;
}
