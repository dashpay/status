// New devnets from the console, using the dash-network-go lifecycle:
//
//   network.yaml -> resolve -> provision-plan        (prepare; nothing billable)
//   -- operator reviews footprint, versions, DNS and confirms --
//   provision -> bootstrap-plan -> host-trust -> bootstrap
//   -> deployment-plan -> deploy -> services -> doctor
//
// Each dashnet stage resumes from its own journal, so "Resume" reruns the same
// sequence with the same plans. Delete tears down only resources tagged as
// owned by dash-network-go for exactly this network.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand, TerminateInstancesCommand, DeleteVolumeCommand } from '@aws-sdk/client-ec2';
import { Route53Client, ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { COMPONENTS, COMPONENT_REPOS, readJSON, writeAtomic } from '../shared/settings.js';
import { deployServices, serviceNames, shortName } from './services.js';

const NAME = /^devnet-[a-z][a-z0-9-]{1,30}$/;
const PRICES = { 't4g.small': 0.0168, 't4g.medium': 0.0336, 't4g.large': 0.0672, 't4g.xlarge': 0.1344, 't3.medium': 0.0416, 't3.large': 0.0832, 't3.xlarge': 0.1664, 'm7g.medium': 0.0408, 'm7g.large': 0.0816, 'm6a.large': 0.0864, 'm7i.large': 0.1008, 'c7g.large': 0.0725 };
const GP3_GIB_MONTH = 0.08;

export { shortName };
export const coreNetwork = (name, generation = 1) => `devnet-${shortName(name)}-g${generation}`;

export function validateDevnetRequest(settings, q, registry) {
  if (!NAME.test(q.network || '')) throw new Error('name must look like devnet-<name> (lowercase, 2-31 characters after devnet-)');
  if (settings.networks.some((n) => n.name === q.network) || registry[q.network]) throw new Error(`${q.network} already exists; journal records are permanent, pick a new name`);
  // Placement (VPC, subnet, groups, key, IPAM, DNS zone) always comes from Settings.
  const allowed = ['displayName', 'description', 'public', 'validators', 'validatorType', 'validatorArch', 'walletType', 'walletArch', 'rootVolumeGiB', 'protocol'];
  const extra = Object.keys(q.devnet || {}).filter((k) => !allowed.includes(k) && k !== 'images' && k !== 'services');
  if (extra.length) throw new Error(`not settable per devnet: ${extra.join(', ')}`);
  const d = { ...settings.devnets, ...(q.devnet || {}) };
  if (!Number.isInteger(d.rootVolumeGiB) || d.rootVolumeGiB < 30 || d.rootVolumeGiB > 1000) throw new Error('root disk 30..1000 GiB');
  d.images = { ...settings.devnets.images, ...(q.devnet?.images || {}) };
  d.services = { ...settings.devnets.services, ...(q.devnet?.services || {}) };
  if (!Number.isInteger(d.validators) || d.validators < 13 || d.validators > 25) throw new Error('validators must be 13..25 (dashnet devnet profile)');
  for (const k of ['validatorType', 'walletType']) if (!/^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(d[k])) throw new Error(`${k} invalid`);
  for (const k of ['validatorArch', 'walletArch']) if (!['arm64', 'amd64'].includes(d[k])) throw new Error(`${k} must be arm64 or amd64`);
  for (const c of COMPONENTS) {
    const ref = String(d.images[c] || '').replace(/^docker\.io\//, '');
    if (ref.split(/[@:]/)[0] !== COMPONENT_REPOS[c] || !/^[a-z0-9/-]+(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/.test(ref)) throw new Error(`images.${c} must be ${COMPONENT_REPOS[c]}:<tag>`);
  }
  if (!Number.isInteger(d.protocol) || d.protocol < 1 || d.protocol > 100) throw new Error('protocol must be the Platform protocol number (e.g. 14 for 4.2.x)');
  if (typeof d.displayName !== 'string' || !d.displayName.trim() || d.displayName.length > 60) d.displayName = shortName(q.network).replace(/(^|-)([a-z])/g, (_, a, b) => (a ? ' ' : '') + b.toUpperCase());
  return d;
}

export function estimate(d) {
  const hourly = d.validators * (PRICES[d.validatorType] ?? NaN) + (PRICES[d.walletType] ?? NaN);
  const storageMonth = (d.validators + 1) * d.rootVolumeGiB * GP3_GIB_MONTH;
  return { hourly: Number.isFinite(hourly) ? Math.round(hourly * 1000) / 1000 : null, monthly: Number.isFinite(hourly) ? Math.round(hourly * 730 + storageMonth) : null, storageMonth: Math.round(storageMonth) };
}

export function networkYaml(settings, name, d, amis) {
  const img = (c) => (d.images[c].startsWith('docker.io/') ? d.images[c] : `docker.io/${d.images[c]}`);
  const q = (v) => JSON.stringify(String(v));
  const lines = [
    'apiVersion: dash.network/v1alpha1', 'kind: Network', 'metadata:', `  name: ${name}`, `  displayName: ${q(d.displayName)}`,
    `  description: ${q(d.description || 'Created from the status console')}`, `  visibility: ${d.public === false ? 'private' : 'public'}`,
    'chain:', '  type: devnet', '  generation: 1', 'aws:', `  accountId: '${settings.aws.accountId}'`, `  region: ${settings.aws.region}`, `  networkTagKey: ${settings.aws.tagKey}`,
    '  provision:', `    stateTable: ${settings.aws.stateTable}`, `    vpcId: ${d.vpcId}`, `    subnetId: ${d.subnetId}`, '    securityGroupIds:', ...d.securityGroupIds.map((g) => `    - ${g}`),
    `    keyName: ${d.keyName}`, `    publicIpv4: true`, ...(d.ipamPoolId ? [`    ipamPoolId: ${d.ipamPoolId}`] : []), `    rootVolumeGiB: ${d.rootVolumeGiB}`, '    amis:',
    ...[...new Set([d.validatorArch, d.walletArch])].flatMap((a) => [`      ${a}:`, `        id: ${amis[a]}`, `        ownerId: '099720109477'`]),
    'nodes:',
    '- name: validators', '  role: validator', `  count: ${d.validators}`, `  architecture: ${d.validatorArch}`, `  instanceType: ${d.validatorType}`,
    '- name: wallet', '  role: wallet', '  count: 1', `  architecture: ${d.walletArch}`, `  instanceType: ${d.walletType}`,
    'images:', ...COMPONENTS.map((c) => `  ${c}: ${img(c)}`),
  ];
  return lines.join('\n') + '\n';
}

export function createDevnets({ ctx, dirs, key, pool, getSettings, region, log = console.log }) {
  const { dashnet, step, save, write, pinBinary } = ctx;
  const registryPath = join(dirs.data, 'devnets.json');
  const registry = () => readJSON(registryPath, {});
  const register = (name, patch) => { const r = registry(); r[name] = { ...(r[name] || {}), ...patch, updatedAt: new Date().toISOString() }; writeAtomic(registryPath, JSON.stringify(r, null, 1)); };
  const ec2 = new EC2Client({ region }), r53 = new Route53Client({ region: 'us-east-1' }), ssm = new SSMClient({ region });
  const workDir = (name) => { const d = join(dirs.private, 'devnets', name); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
  const access = (dir) => ['--ssh-key', key.path, '--known-hosts', join(dir, 'known_hosts')];
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  async function ami(arch) {
    const p = await ssm.send(new GetParameterCommand({ Name: `/aws/service/canonical/ubuntu/server/24.04/stable/current/${arch}/hvm/ebs-gp3/ami-id` }));
    return p.Parameter.Value;
  }

  async function run(r, name, args, opts = {}) {
    const code = await dashnet(r, args, { ...opts, bin: pinBinary(workDir(r.network)) });
    if (code !== 0 && !opts.allowFail) throw new Error(`${name} failed (exit ${code}); see log`);
    return code;
  }

  // ---- create ------------------------------------------------------------
  async function prepareCreate(r) {
    const s = getSettings();
    const d = validateDevnetRequest(s, r.request, registry());
    const name = r.network, dir = workDir(name);
    rmSync(join(dir, 'dashnet'), { force: true }); // nothing is bound to a binary before provisioning
    r.status = 'preparing'; save(r);
    let done = step(r, 'Current Ubuntu 24.04 AMIs (Canonical)');
    const amis = {};
    for (const a of new Set([d.validatorArch, d.walletArch])) amis[a] = await ami(a);
    done('ok', Object.entries(amis).map(([a, id]) => `${a} ${id}`).join(', '));
    writeFileSync(join(dir, 'network.yaml'), networkYaml(s, name, d, amis), { mode: 0o600 });
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ ...d, amis }), { mode: 0o600 });
    done = step(r, 'Validate and resolve images (dashnet resolve)');
    await run(r, 'validate', ['validate', '--network', join(dir, 'network.yaml')]);
    rmSync(join(dir, 'lock.json'), { force: true });
    await run(r, 'resolve', ['resolve', '--network', join(dir, 'network.yaml'), '--out', join(dir, 'lock.json')], { timeoutMs: 5 * 60_000 });
    done('ok');
    done = step(r, 'EC2 footprint (dashnet provision-plan, read-only)');
    rmSync(join(dir, 'ec2-plan.json'), { force: true });
    await run(r, 'provision-plan', ['provision-plan', '--network', join(dir, 'network.yaml'), '--out', join(dir, 'ec2-plan.json')], { timeoutMs: 5 * 60_000 });
    const plan = readJSON(join(dir, 'ec2-plan.json'));
    const lock = readJSON(join(dir, 'lock.json'));
    done('ok', `plan ${plan.id.slice(0, 12)}`);
    const groups = {};
    for (const t of plan.targets) { const k = `${t.group}|${t.instanceType}|${t.architecture}`; groups[k] = (groups[k] || 0) + 1; }
    r.review = {
      planId: plan.id, kind: 'create-devnet', preparedAt: new Date().toISOString(),
      footprint: Object.entries(groups).map(([k, count]) => { const [group, type, arch] = k.split('|'); return { group, type, arch, count }; }),
      instances: plan.targets.length, storageGiB: plan.targets.length * d.rootVolumeGiB, estimate: estimate(d),
      images: Object.fromEntries(COMPONENTS.map((c) => [c, { ref: d.images[c], digests: lockDigests(lock, c) }])),
      protocol: d.protocol, coreNetwork: coreNetwork(name), platformChainId: `dash-${coreNetwork(name)}`,
      dns: serviceNames(name, d), services: d.services, amis, network: { vpc: d.vpcId, subnet: d.subnetId, securityGroups: d.securityGroupIds, ipamPool: d.ipamPoolId },
    };
  }

  function lockDigests(lock, component) {
    const out = {};
    for (const img of lock?.images || lock?.components || []) {
      if ((img.component || img.name) !== component) continue;
      for (const p of img.platforms || []) out[p.architecture || p.arch] = p.digest;
    }
    return out;
  }

  async function executeCreate(r) {
    const s = getSettings();
    const name = r.network, dir = workDir(name);
    const d = readJSON(join(dir, 'request.json'));
    const plan = readJSON(join(dir, 'ec2-plan.json'));
    if (!plan || plan.id !== r.review?.planId) throw new Error('reviewed EC2 plan missing');
    r.status = 'running'; save(r);
    register(name, { status: 'creating', displayName: d.displayName, createdBy: r.actor.login, createdAt: r.createdAt, operation: r.id, coreNetwork: coreNetwork(name), public: d.public !== false, dns: serviceNames(name, d), services: d.services });

    let done = step(r, `Provision ${plan.targets.length} EC2 instances (dashnet provision)`);
    await run(r, 'provision', ['provision', '--plan', join(dir, 'ec2-plan.json'), '--confirm', plan.id, '--timeout', '20m'], { timeoutMs: 21 * 60_000 });
    done('ok');

    if (!existsSync(join(dir, 'bootstrap-plan.json'))) {
      done = step(r, 'Bootstrap plan (dashnet bootstrap-plan)');
      await run(r, 'bootstrap-plan', ['bootstrap-plan', '--compute-plan', join(dir, 'ec2-plan.json'), '--lock', join(dir, 'lock.json'), '--ssh-user', 'ubuntu', '--address', 'public', '--out', join(dir, 'bootstrap-plan.json')]);
      done('ok');
    }
    const bplan = readJSON(join(dir, 'bootstrap-plan.json'));

    if (!existsSync(join(dir, 'known_hosts'))) {
      done = step(r, 'Host keys from EC2 console (dashnet host-trust)');
      let ok = false;
      for (let attempt = 1; attempt <= 20 && !ok; attempt++) {
        const out = join(dir, `known_hosts.${stamp()}`);
        ok = (await run(r, 'host-trust', ['host-trust', '--bootstrap-plan', join(dir, 'bootstrap-plan.json'), '--timeout', '3m', '--out', out], { allowFail: true, timeoutMs: 4 * 60_000 })) === 0;
        if (ok) writeFileSync(join(dir, 'known_hosts'), readFileSync(out), { mode: 0o600 });
        else { write(r.id, `console output not complete yet; retry ${attempt}/20 in 30s`); await sleep(30_000); }
      }
      if (!ok) { done('failed'); throw new Error('host keys unavailable from EC2 console output'); }
      done('ok');
    }
    pinHostKeys(readFileSync(join(dir, 'known_hosts'), 'utf8'));

    done = step(r, 'Prepare hosts: Docker, images (dashnet bootstrap)');
    await run(r, 'bootstrap', ['bootstrap', '--plan', join(dir, 'bootstrap-plan.json'), '--confirm', bplan.id, ...access(dir), '--timeout', '45m', '--out', join(dir, `hosts-ready.${stamp()}.json`)], { timeoutMs: 46 * 60_000 });
    done('ok');

    if (!existsSync(join(dir, 'deployment.json'))) {
      done = step(r, `Deployment plan, Platform protocol ${d.protocol} (dashnet deployment-plan)`);
      await run(r, 'deployment-plan', ['deployment-plan', '--bootstrap-plan', join(dir, 'bootstrap-plan.json'), '--protocol', String(d.protocol), '--out', join(dir, 'deployment.json')]);
      done('ok');
    }
    const dplan = readJSON(join(dir, 'deployment.json'));
    register(name, { coreNetwork: dplan.coreNetwork, platformChainId: dplan.platformChainId });

    done = step(r, 'Core, EvoNode registration, quorums, Platform (dashnet deploy)');
    await run(r, 'deploy', ['deploy', '--plan', join(dir, 'deployment.json'), '--confirm', dplan.id, ...access(dir), '--timeout', '100m', '--observation-window', '90s', '--out', join(dir, `deployed.${stamp()}.json`)], { timeoutMs: 101 * 60_000 });
    done('ok');
    register(name, { status: 'services' });

    done = step(r, 'Quorum server, Platform Explorer, faucet, DNS and TLS');
    const services = await deployServices({ r, write, dplan, d, name, pool, s, ec2, r53, dir });
    register(name, { services: d.services, dns: services.dns, walletAddress: services.walletAddress });
    done('ok', services.summary);

    done = step(r, 'Independent health gate (dashnet doctor)');
    const code = await run(r, 'doctor', ['doctor', '--plan', join(dir, 'deployment.json'), ...access(dir), '--timeout', '5m', '--observation-window', '90s', '--out', join(dir, `health.${stamp()}.json`)], { allowFail: true, timeoutMs: 6 * 60_000 });
    done(code === 0 ? 'ok' : 'warn', code === 0 ? 'all targets healthy' : 'see log');
    register(name, { status: 'ready', readyAt: new Date().toISOString() });
  }

  function pinHostKeys(text) {
    for (const line of text.split('\n')) {
      const [alias, type, value] = line.trim().split(/\s+/);
      const id = alias?.split('.')[0];
      if (!/^i-[0-9a-f]+$/.test(id || '') || type !== 'ssh-ed25519') continue;
      if (!pool.pins[id]) pool.pins[id] = { type, key: value, address: null, pinnedAt: new Date().toISOString(), source: 'EC2 console (dashnet host-trust)' };
    }
    pool.savePins();
  }

  // ---- services only (re-install / change service versions) ---------------
  async function prepareServices(r) {
    const name = r.network, dir = workDir(name);
    const reg = registry()[name];
    if (!reg || !['ready', 'services', 'failed'].includes(reg.status) || !existsSync(join(dir, 'deployment.json'))) throw new Error('services can be updated once the devnet is deployed');
    const d = readJSON(join(dir, 'request.json'));
    // Current Settings defaults are the desired service versions for every console devnet.
    const services = { ...d.services, ...getSettings().devnets.services, ...(r.request.services || {}) };
    r.status = 'preparing'; save(r);
    r.review = { kind: 'devnet-services', planId: `services-${name}-${Date.now()}`, preparedAt: new Date().toISOString(), from: d.services, to: services, dns: serviceNames(name, d) };
  }

  async function executeServices(r) {
    const name = r.network, dir = workDir(name);
    const d = readJSON(join(dir, 'request.json'));
    d.services = r.review.to;
    const dplan = readJSON(join(dir, 'deployment.json'));
    r.status = 'running'; save(r);
    const done = step(r, 'Quorum server, Platform Explorer, faucet, DNS and TLS');
    const services = await deployServices({ r, write, dplan, d, name, pool, s: getSettings(), ec2, r53, dir });
    writeFileSync(join(dir, 'request.json'), JSON.stringify(d), { mode: 0o600 });
    register(name, { services: d.services, dns: services.dns, status: registry()[name]?.status === 'failed' ? 'ready' : registry()[name]?.status });
    done('ok', services.summary);
  }

  // ---- delete ------------------------------------------------------------
  async function owned(name) {
    const out = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: 'tag:dashnet:network', Values: [name] }, { Name: 'tag:dashnet:managed-by', Values: ['dash-network-go'] }, { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped', 'shutting-down'] }] }));
    return (out.Reservations || []).flatMap((x) => x.Instances || []);
  }

  async function prepareDelete(r) {
    const name = r.network;
    const reg = registry()[name];
    if (!reg) throw new Error(`${name} was not created from this console; refusing to delete`);
    r.status = 'preparing'; save(r);
    const done = step(r, 'Inventory owned resources');
    const instances = await owned(name);
    const vols = (await ec2.send(new DescribeVolumesCommand({ Filters: [{ Name: 'tag:dashnet:network', Values: [name] }, { Name: 'tag:dashnet:managed-by', Values: ['dash-network-go'] }] }))).Volumes || [];
    done('ok', `${instances.length} instances, ${vols.length} volumes`);
    r.review = { kind: 'delete-devnet', planId: `delete-${name}`, preparedAt: new Date().toISOString(), instances: instances.map((i) => ({ id: i.InstanceId, name: i.Tags?.find((t) => t.Key === 'Name')?.Value, ip: i.PublicIpAddress, state: i.State?.Name })), volumes: vols.length, dns: Object.values(reg.dns || {}).map((x) => x.host).filter(Boolean) };
  }

  async function executeDelete(r) {
    const name = r.network, dir = workDir(name);
    r.status = 'running'; save(r);
    register(name, { status: 'deleting' });
    let done = step(r, 'Remove DNS records');
    const reg = registry()[name] || {};
    const hosts = Object.values(reg.dns || {}).map((x) => x.host).filter(Boolean);
    const zone = getSettings().devnets.dnsZoneId;
    const existing = hosts.length ? (await r53.send(new ListResourceRecordSetsCommand({ HostedZoneId: zone, StartRecordName: hosts.sort()[0], MaxItems: '300' }))).ResourceRecordSets : [];
    const changes = existing.filter((x) => x.Type === 'A' && hosts.includes(x.Name.replace(/\.$/, ''))).map((x) => ({ Action: 'DELETE', ResourceRecordSet: x }));
    if (changes.length) await r53.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: zone, ChangeBatch: { Changes: changes } }));
    done('ok', `${changes.length} removed`);
    done = step(r, 'Terminate instances');
    let instances = await owned(name);
    if (instances.length) await ec2.send(new TerminateInstancesCommand({ InstanceIds: instances.map((i) => i.InstanceId) }));
    for (let i = 0; i < 60 && (instances = (await owned(name)).filter((x) => x.State?.Name !== 'terminated')).length; i++) await sleep(10_000);
    if (instances.length) { done('failed'); throw new Error(`${instances.length} instance(s) not terminated yet`); }
    done('ok');
    if (existsSync(join(dir, 'ec2-plan.json'))) {
      done = step(r, 'Release BYOIP addresses (dashnet release-addresses)');
      const plan = readJSON(join(dir, 'ec2-plan.json'));
      await run(r, 'release-addresses', ['release-addresses', '--plan', join(dir, 'ec2-plan.json'), '--confirm', plan.id, '--timeout', '10m'], { timeoutMs: 11 * 60_000 });
      done('ok');
    }
    done = step(r, 'Delete retained root volumes');
    let vols = [];
    for (let i = 0; i < 30; i++) {
      vols = ((await ec2.send(new DescribeVolumesCommand({ Filters: [{ Name: 'tag:dashnet:network', Values: [name] }, { Name: 'tag:dashnet:managed-by', Values: ['dash-network-go'] }] }))).Volumes || []);
      const free = vols.filter((v) => v.State === 'available');
      for (const v of free) await ec2.send(new DeleteVolumeCommand({ VolumeId: v.VolumeId }));
      if (vols.length === free.length) break;
      await sleep(10_000);
    }
    done('ok', `${vols.length} deleted`);
    register(name, { status: 'deleted', deletedAt: new Date().toISOString() });
    log(`devnet ${name} deleted by ${r.actor.login}`);
  }

  return { prepareCreate, executeCreate, prepareServices, executeServices, prepareDelete, executeDelete, registry };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
