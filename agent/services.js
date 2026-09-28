// Public services for console-created devnets, placed on the dashnet wallet
// host: quorum-list-server, Platform Explorer and dash-faucet behind Caddy TLS.
import { readFileSync } from 'node:fs';
import { ChangeResourceRecordSetsCommand, GetChangeCommand } from '@aws-sdk/client-route-53';

export const shortName = (name) => name.replace(/^devnet-/, '');

const REMOTE = readFileSync(new URL('./services-remote.py', import.meta.url), 'utf8');
const RELAY_PORT = 26667;

export function serviceNames(name, d) {
  const short = shortName(name), suffix = d.dnsSuffix || 'networks.dash.org';
  return {
    quorums: { host: `quorums.${short}.${suffix}`, url: `https://quorums.${short}.${suffix}/quorums` },
    explorer: { host: `explorer.${short}.${suffix}`, url: `https://explorer.${short}.${suffix}/` },
    faucet: { host: `faucet.${short}.${suffix}`, url: `https://faucet.${short}.${suffix}/` },
  };
}

export function serviceEndpoints(name, d) {
  const n = serviceNames(name, d);
  return [
    { label: 'Quorums', url: `https://${n.quorums.host}/health` },
    { label: 'Explorer', url: n.explorer.url },
    { label: 'Faucet', url: n.faucet.url },
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function deployServices({ r, write, dplan, d, name, pool, r53 }) {
  const wallet = dplan.targets.find((t) => t.role === 'wallet');
  const validators = dplan.targets.filter((t) => t.role === 'validator');
  const relay = validators[0];
  const names = serviceNames(name, d);
  const host = (t) => ({ name: t.name, instanceId: t.instanceId, publicIp: t.sshAddress, role: t.role });

  write(r.id, `services: DNS ${Object.values(names).map((x) => x.host).join(', ')} -> ${wallet.sshAddress}`);
  const change = await r53.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: d.dnsZoneId,
    ChangeBatch: { Comment: `${name} console devnet services`, Changes: Object.values(names).map((x) => ({ Action: 'UPSERT', ResourceRecordSet: { Name: x.host, Type: 'A', TTL: 60, ResourceRecords: [{ Value: wallet.sshAddress }] } })) },
  }));
  for (let i = 0; i < 30; i++) {
    const c = await r53.send(new GetChangeCommand({ Id: change.ChangeInfo.Id }));
    if (c.ChangeInfo.Status === 'INSYNC') break;
    await sleep(5000);
  }

  // Tenderdash RPC stays on loopback on validators; the explorer indexer needs a
  // full-history RPC, so relay one validator's RPC to its VPC address only.
  write(r.id, `services: Tenderdash RPC relay ${relay.name} ${relay.peerAddress}:${RELAY_PORT} -> 127.0.0.1:${dplan.ports.platformRPC || 26657}`);
  await pool.exec(host(relay), `sudo docker inspect devnet-td-relay >/dev/null 2>&1 || sudo docker run -d --name devnet-td-relay --restart unless-stopped --network host --log-driver local alpine/socat:1.8.0.3 TCP-LISTEN:${RELAY_PORT},bind=${relay.peerAddress},fork,reuseaddr TCP:127.0.0.1:${dplan.ports.platformRPC || 26657}`, null, 180_000);

  const cfg = {
    short: shortName(name), displayName: d.displayName, coreNetwork: dplan.coreNetwork, platformChainId: dplan.platformChainId,
    coreRpcPort: dplan.ports.coreRPC || 20002, hosts: Object.fromEntries(Object.entries(names).map(([k, v]) => [k, v.host])),
    quorumServerImage: d.services.quorumServer.startsWith('docker.io/') ? d.services.quorumServer : `docker.io/${d.services.quorumServer}`,
    explorerVersion: d.services.explorerVersion, faucetRef: d.services.faucetRef, faucetAmount: d.services.faucetAmount,
    faucetRateLimit: d.services.faucetRateLimit, faucetFunding: d.services.faucetFunding, epochSeconds: d.services.epochSeconds,
    tenderdashUrl: `http://${relay.peerAddress}:${RELAY_PORT}`,
    dapiUrls: validators.slice(0, 5).map((t) => `https://${t.sshAddress}:${dplan.ports.gateway || 1443}`),
  };
  write(r.id, 'services: installing on wallet host (builds faucet and explorer frontend; first run takes several minutes)');
  const arg = Buffer.from(JSON.stringify(cfg)).toString('base64');
  await pool.exec(host(wallet), 'sudo install -d -m 0700 /opt/devnet-services && sudo tee /opt/devnet-services/services.py >/dev/null && sudo chmod 0700 /opt/devnet-services/services.py', REMOTE, 60_000);
  const out = await pool.exec(host(wallet), `sudo python3 /opt/devnet-services/services.py ${arg} 2>/tmp/devnet-services.log; rc=$?; sudo tail -c 4000 /tmp/devnet-services.log >&2; exit $rc`, null, 100 * 60_000, (line) => write(r.id, `  ${line}`));
  const result = JSON.parse(out.trim().split('\n').pop());
  write(r.id, `services: ${JSON.stringify(result)}`);
  const bad = ['quorums', 'faucet', 'explorerApi', 'explorerFrontend'].filter((k) => !result[k] || result[k] >= 500);
  if (bad.length) throw new Error(`services not answering locally: ${bad.join(', ')}`);
  return { dns: names, walletAddress: result.walletAddress, summary: `faucet balance ${result.faucetBalance}, ${Object.values(names).map((x) => x.host).join(', ')}` };
}
