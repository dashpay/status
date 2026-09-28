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
    insight: { host: `insight.${short}.${suffix}`, url: `https://insight.${short}.${suffix}/insight/` },
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

// dashnet devnets use fixed default ports (internal/node DefaultPorts).
const PORTS = { coreRPC: 20002, coreZMQ: 29998, platformRPC: 26657, gateway: 1443 };

// Public-address plans keep the VPC address separately; the Elastic IP is
// not bound on the instance's interface.
const vpc = (t) => t.privateAddress || t.peerAddress;
const host = (t) => ({ name: t.name, instanceId: t.instanceId, publicIp: t.sshAddress, role: t.role });

function servicesConfig(name, d, dplan) {
  const ports = { ...PORTS, ...(dplan.ports || {}) };
  const wallet = dplan.targets.find((t) => t.role === 'wallet');
  const validators = dplan.targets.filter((t) => t.role === 'validator');
  const relay = validators[0];
  const names = serviceNames(name, d);
  return {
    short: shortName(name), displayName: d.displayName, auxiliary: `${name}/${wallet.name}`, coreNetwork: dplan.coreNetwork, platformChainId: dplan.platformChainId,
    coreRpcPort: ports.coreRPC, coreZmqPort: ports.coreZMQ, hosts: Object.fromEntries(Object.entries(names).map(([k, v]) => [k, v.host])),
    quorumServerImage: d.services.quorumServer.startsWith('docker.io/') ? d.services.quorumServer : `docker.io/${d.services.quorumServer}`,
    insightImage: (d.services.insightImage || 'dashpay/insight:4.0.9').replace(/^(?!docker\.io\/)/, 'docker.io/'),
    explorerVersion: d.services.explorerVersion, faucetRef: d.services.faucetRef, faucetAmount: d.services.faucetAmount,
    faucetRateLimit: d.services.faucetRateLimit, faucetFunding: d.services.faucetFunding, epochSeconds: d.services.epochSeconds,
    tenderdashUrl: `http://${vpc(relay)}:${RELAY_PORT}`,
    // Validators with Let's Encrypt certificates are verified; self-signed ones are not.
    trustedGateways: !!dplan.gatewayTls,
    dapiUrls: validators.slice(0, 5).map((t) => `https://${t.sshAddress}:${ports.gateway}`),
  };
}

async function runRemote(pool, wallet, cfg, onLine) {
  const arg = Buffer.from(JSON.stringify(cfg)).toString('base64');
  await pool.exec(host(wallet), 'sudo install -d -m 0700 /opt/devnet-services && sudo tee /opt/devnet-services/services.py >/dev/null && sudo chmod 0700 /opt/devnet-services/services.py', REMOTE, 60_000);
  const out = await pool.exec(host(wallet), `set -o pipefail; { sudo python3 /opt/devnet-services/services.py ${arg} 2>&1 1>&3 | tee /tmp/devnet-services.log >&2; } 3>&1`, null, 100 * 60_000, onLine);
  return JSON.parse(out.trim().split('\n').pop());
}

// Build the faucet and explorer frontend and pull every service image while
// dashnet deploys the chain (about seven minutes the install would otherwise
// spend afterwards). Best effort: the install builds whatever is missing.
export async function prebuildServices({ r, write, dplan, d, name, pool }) {
  const wallet = dplan.targets.find((t) => t.role === 'wallet');
  try {
    const result = await runRemote(pool, wallet, { ...servicesConfig(name, d, dplan), prebuildOnly: true }, (line) => write(r.id, `  services (early): ${line}`));
    write(r.id, `services (early): built ${result.faucetImage} and ${result.frontendImage}, pulled ${result.pulled} images`);
  } catch (e) {
    write(r.id, `services (early): ${e.message.slice(0, 300)}; the install builds them instead`);
  }
}

export async function deployServices({ r, write, dplan, d, name, pool, r53 }) {
  const ports = { ...PORTS, ...(dplan.ports || {}) };
  const wallet = dplan.targets.find((t) => t.role === 'wallet');
  const validators = dplan.targets.filter((t) => t.role === 'validator');
  const relay = validators[0];
  const names = serviceNames(name, d);

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
  write(r.id, `services: Tenderdash RPC relay ${relay.name} ${vpc(relay)}:${RELAY_PORT} -> 127.0.0.1:${ports.platformRPC}`);
  const relayLabel = `dashnet.auxiliary=${name}/${relay.name}`;
  await pool.exec(host(relay), `[ "$(sudo docker inspect -f '{{index .Config.Labels "dashnet.auxiliary"}}' devnet-td-relay 2>/dev/null)" = "${name}/${relay.name}" ] || { sudo docker rm -f devnet-td-relay >/dev/null 2>&1; sudo docker run -d --name devnet-td-relay --label ${relayLabel} --restart unless-stopped --network host --log-driver local alpine/socat:1.8.0.3 TCP-LISTEN:${RELAY_PORT},bind=${vpc(relay)},fork,reuseaddr TCP:127.0.0.1:${ports.platformRPC}; }`, null, 180_000);

  write(r.id, 'services: installing on wallet host (builds faucet and explorer frontend unless already built)');
  const result = await runRemote(pool, wallet, servicesConfig(name, d, dplan), (line) => write(r.id, `  ${line}`));
  const { promoCodes, ...shown } = result;
  write(r.id, `services: ${JSON.stringify(shown)}`);
  const bad = ['quorums', 'insight', 'faucet', 'explorerApi', 'explorerFrontend'].filter((k) => !result[k] || result[k] >= 500);
  if (bad.length) throw new Error(`services not answering locally: ${bad.join(', ')}`);
  if (!Number.isInteger(result.quorumList) || result.quorumList < 1) throw new Error(`quorum server has no quorums from Core: ${result.quorumList}`);
  if (result.insight !== 200 || !Number.isInteger(result.insightBlocks)) throw new Error(`Insight is not following the chain: HTTP ${result.insight}, ${result.insightBlocks}`);
  return { dns: names, walletAddress: result.walletAddress, promoCodes, summary: `faucet balance ${result.faucetBalance}, ${result.quorumList} quorums listed, explorer validators ${result.explorerValidators}, insight at block ${result.insightBlocks}, ${Object.values(names).map((x) => x.host).join(', ')}` };
}
