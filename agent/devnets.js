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
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EC2Client, DescribeAddressesCommand, DescribeInstancesCommand, DescribeVolumesCommand, TerminateInstancesCommand, DeleteVolumeCommand } from '@aws-sdk/client-ec2';
import { Route53Client, ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { COMPONENTS, COMPONENT_REPOS, devnetChain, readJSON, validateDevnetDefaults, writeAtomic } from '../shared/settings.js';
import { deployServices, prebuildServices, serviceNames, shortName } from './services.js';

const NAME = /^devnet-[a-z][a-z0-9-]{1,30}$/;
const PRICES = { 't4g.small': 0.0168, 't4g.medium': 0.0336, 't4g.large': 0.0672, 't4g.xlarge': 0.1344, 't3.medium': 0.0416, 't3.large': 0.0832, 't3.xlarge': 0.1664, 'm7g.medium': 0.0408, 'm7g.large': 0.0816, 'm6a.large': 0.0864, 'm7i.large': 0.1008, 'c7g.large': 0.0725 };
const GP3_GIB_MONTH = 0.08;
const SERVICE_KEYS = ['quorumServer', 'insightImage', 'explorerVersion', 'faucetRef', 'faucetAmount', 'faucetRateLimit', 'faucetFunding', 'epochSeconds'];
const TEXT = /^[A-Za-z0-9 .,_()-]+$/;
// Core block interval in seconds; devnets created before it was settable use 10.
const blockSeconds = (d) => d?.blockTimeSeconds || 10;
// Platform epoch length; dashnet builds without --epoch-time run 3600.
const epochSeconds = (d) => d?.platformEpochSeconds || 3600;
// Each health sample must see a new Core block. Platform needs no longer
// window: dash-network-go accepts an idle chain's recent block as live.
const observeSeconds = (d) => Math.max(30, Math.ceil(2.5 * blockSeconds(d)));
// A resumed deploy waits for the quorums (well under 60 blocks), then Platform.
const deployMinutes = (d) => Math.max(100, blockSeconds(d) + 60);

export { shortName };
// dash-network-go devnets whose services each release's dashmate renders; the
// helper image is then that dashmate, and Platform upgrades re-render with it.
export const DASHMATE_PROFILE = 'devnet-dashmate-compose';
// The images a devnet runs now: its network file after any upgrade.
export function imagesOf(yaml) {
  const out = {};
  const block = /^images:\n((?: {2}\S.*\n?)+)/m.exec(yaml || '');
  for (const line of (block?.[1] || '').split('\n')) {
    const m = /^ {2}([a-z]+): (\S+)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^docker\.io\//, '');
  }
  return out;
}
// The helper follows Drive's release unless chosen explicitly: dashmate renders
// the services, so it should be the release being deployed.
export function helperFollowsDrive(images, explicit = {}) {
  const tag = /^dashpay\/drive:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(String(images.drive || '').replace(/^docker\.io\//, ''))?.[1];
  return explicit.helper || !tag ? images : { ...images, helper: `dashpay/dashmate-helper:${tag}` };
}
// As dash-network-go names chains: <name>, or <name>-g<N> for a reset chain.
export const coreNetwork = (name, generation = 1) => `devnet-${shortName(name)}${generation > 1 ? `-g${generation}` : ''}`;

export function validateDevnetRequest(settings, q, registry) {
  if (!NAME.test(q.network || '')) throw new Error('name must look like devnet-<name> (lowercase, 2-31 characters after devnet-)');
  if (settings.networks.some((n) => n.name === q.network) || registry[q.network]) throw new Error(`${q.network} already exists; journal records are permanent, pick a new name`);
  // <name>-g<N> is how a reset chain of devnet-<name> is named (and its DNS alias).
  if (/-g\d+$/.test(q.network)) throw new Error('name must not end in -g<number>: that is how a reset devnet chain is named');
  // Placement (VPC, subnet, groups, key, IPAM, DNS zone) always comes from Settings.
  const allowed = ['displayName', 'description', 'public', 'validators', 'validatorType', 'validatorArch', 'walletType', 'walletArch', 'rootVolumeGiB', 'protocol', 'blockTimeSeconds', 'platformEpochSeconds'];
  const extra = Object.keys(q.devnet || {}).filter((k) => !allowed.includes(k) && k !== 'images' && k !== 'services');
  if (extra.length) throw new Error(`not settable per devnet: ${extra.join(', ')}`);
  const services = Object.keys(q.devnet?.services || {}).filter((k) => !SERVICE_KEYS.includes(k));
  if (services.length) throw new Error(`not settable per devnet: services.${services.join(', services.')}`);
  const d = { ...settings.devnets, ...(q.devnet || {}) };
  if (!Number.isInteger(d.rootVolumeGiB) || d.rootVolumeGiB < 30 || d.rootVolumeGiB > 1000) throw new Error('root disk 30..1000 GiB');
  // dashmate's Core never uses private addresses: every host needs an IPAM
  // Elastic IP. Refuse here, before anything is billable.
  if (!d.ipamPoolId) throw new Error('an IPAM pool is required (Settings → devnets): devnet nodes need public Elastic IPs');
  d.images = helperFollowsDrive({ ...settings.devnets.images, ...(q.devnet?.images || {}) }, q.devnet?.images || {});
  d.services = { ...settings.devnets.services, ...(q.devnet?.services || {}) };
  if (!Number.isInteger(d.validators) || d.validators < 13 || d.validators > 25) throw new Error('validators must be 13..25 (dashnet devnet profile)');
  for (const k of ['validatorType', 'walletType']) if (!/^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(d[k])) throw new Error(`${k} invalid`);
  for (const k of ['validatorArch', 'walletArch']) if (!['arm64', 'amd64'].includes(d[k])) throw new Error(`${k} must be arm64 or amd64`);
  for (const c of COMPONENTS) {
    const ref = String(d.images[c] || '').replace(/^docker\.io\//, '');
    if (ref.split(/[@:]/)[0] !== COMPONENT_REPOS[c] || !/^[a-z0-9/-]+(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/.test(ref)) throw new Error(`images.${c} must be ${COMPONENT_REPOS[c]}:<tag>`);
  }
  if (!Number.isInteger(d.protocol) || d.protocol < 1 || d.protocol > 100) throw new Error('protocol must be the Platform protocol number (e.g. 14 for 4.2.x)');
  if (typeof d.displayName !== 'string' || !d.displayName.trim()) d.displayName = shortName(q.network).replace(/(^|-)([a-z])/g, (_, a, b) => (a ? ' ' : '') + b.toUpperCase());
  // Shown on the faucet page and in the network file: plain text only.
  if (!TEXT.test(d.displayName) || d.displayName.length > 60) throw new Error('display name: letters, digits, spaces and . , _ ( ) - only, up to 60');
  if (d.description != null && (typeof d.description !== 'string' || d.description.length > 200 || !TEXT.test(d.description || 'x'))) throw new Error('description: plain text up to 200 characters');
  // Same rules as Settings, so a bad service value fails before anything is billable.
  validateDevnetDefaults(d);
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
    'images:', ...COMPONENTS.map((c) => `  ${c}: ${img(c)}`), ...(d.images.acme ? [`  acme: ${img('acme')}`] : []),
  ];
  return lines.join('\n') + '\n';
}

export function createDevnets({ ctx, dirs, key, pool, getSettings, region, log = console.log, clients = {}, wait = sleep }) {
  const { dashnet, step, save, write, pinBinary, binary } = ctx;
  const registryPath = join(dirs.data, 'devnets.json');
  const registry = () => readJSON(registryPath, {});
  const register = (name, patch) => { const r = registry(); r[name] = { ...(r[name] || {}), ...patch, updatedAt: new Date().toISOString() }; writeAtomic(registryPath, JSON.stringify(r, null, 1)); };
  // Registered before Route 53 has them, so deleting after a failed install removes them too.
  const registerNames = (name, d, dplan) => register(name, { dns: { ...(registry()[name]?.dns || {}), ...serviceNames(name, d, dplan.coreNetwork) } });
  const ec2 = clients.ec2 || new EC2Client({ region }), r53 = clients.r53 || new Route53Client({ region: 'us-east-1' }), ssm = clients.ssm || new SSMClient({ region });
  const workDir = (name) => { const d = join(dirs.private, 'devnets', name); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
  const access = (dir) => ['--ssh-key', key.path, '--known-hosts', join(dir, 'known_hosts')];
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  // What this devnet's own (pinned) dash-network-go can upgrade.
  // Whether this devnet's pinned dash-network-go knows a flag (builds older than
  // the console may be pinned to a devnet created before an agent update).
  function supports(name, command, flag) {
    const bin = join(dirs.private, 'devnets', name, 'dashnet');
    if (!existsSync(bin)) return false;
    const p = spawnSync(bin, [command, '-h'], { encoding: 'utf8', timeout: 10_000 });
    return new RegExp(`^\\s*-${flag}\\b`, 'm').test(`${p.stdout}${p.stderr}`);
  }
  function upgradeScopes(name) {
    const bin = join(dirs.private, 'devnets', name, 'dashnet');
    if (!existsSync(bin)) return null;
    const p = spawnSync(bin, ['upgrade-plan', '-h'], { encoding: 'utf8', timeout: 10_000 });
    return /or core \(Core only/.test(`${p.stdout}${p.stderr}`) ? ['platform', 'tenderdash', 'core'] : ['platform', 'tenderdash'];
  }
  // An upgrade runs with the binary that planned it, but a resume may move to a
  // strictly newer build whose recipes the plans still accept (same upgrade
  // and node recipes), e.g. to pick up a runner fix.
  function refreshSnapshot(r, dir, plan) {
    const dep = readJSON(join(dir, 'deployment.json'));
    if (!binary || !existsSync(binary) || !r.artifacts.bin || !dep) return;
    const p = spawnSync(binary, ['recipes'], { encoding: 'utf8', timeout: 10_000 });
    let rec; try { rec = JSON.parse(p.stdout); } catch { return; }
    if (rec.upgrade !== plan.recipeSha256 || rec.node !== dep.recipeSha256) return;
    const [was, now] = [versionOf(r.artifacts.bin), versionOf(binary)];
    if (!dated(now) || (dated(was) && dated(was) >= dated(now))) return;
    copyFileSync(binary, `${r.artifacts.bin}.next`); chmodSync(`${r.artifacts.bin}.next`, 0o700); renameSync(`${r.artifacts.bin}.next`, r.artifacts.bin);
    write(r.id, `resuming with dashnet ${now.slice(0, 16)} (same upgrade and node recipes as the reviewed plan)`);
  }
  const versionOf = (bin) => spawnSync(bin, ['version'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
  const dated = (v) => /^(\d{8}T\d{6}Z)-[0-9a-f]{40}$/.exec(v || '')?.[1];

  // A devnet is pinned to the dashnet that created it: its plans bind that
  // binary's recipes. A newer binary reporting the same node and bootstrap
  // recipes (dashnet recipes) can operate it, so fixes reach existing devnets.
  function adoptCompatible(r, name) {
    const dir = join(dirs.private, 'devnets', name), pinned = join(dir, 'dashnet');
    const dep = readJSON(join(dir, 'deployment.json')), boot = readJSON(join(dir, 'bootstrap-plan.json'));
    if (!binary || !existsSync(binary) || !existsSync(pinned) || !dep || !boot) return;
    const p = spawnSync(binary, ['recipes'], { encoding: 'utf8', timeout: 10_000 });
    let rec; try { rec = JSON.parse(p.stdout); } catch { return; }
    if (rec.node !== dep.recipeSha256 || rec.bootstrap !== boot.recipeSha256) return;
    // Versions are <commit date>-<commit>; adopt only a strictly newer build
    // (never downgrade on an agent rollback; undated pins are older).
    const [was, now] = [versionOf(pinned), versionOf(binary)];
    if (!dated(now) || (dated(was) && dated(was) >= dated(now))) return;
    copyFileSync(binary, `${pinned}.next`); chmodSync(`${pinned}.next`, 0o700); renameSync(`${pinned}.next`, pinned);
    register(name, { upgradeScopes: upgradeScopes(name), dashnet: now });
    write(r.id, `dashnet ${was.slice(0, 12)} -> ${now.slice(0, 12)} for ${name} (same node and bootstrap recipes)`);
  }

  // Current images, and whether dashmate renders the devnet, for the console.
  function runtimeOf(dir) {
    const file = existsSync(join(dir, 'network-current.yaml')) ? 'network-current.yaml' : 'network.yaml';
    const images = existsSync(join(dir, file)) ? imagesOf(readFileSync(join(dir, file), 'utf8')) : {};
    return { images, dashmate: readJSON(join(dir, 'deployment.json'))?.profile === DASHMATE_PROFILE };
  }
  for (const [name, reg] of Object.entries(registry())) {
    if (reg.status === 'deleted' || reg.images) continue;
    const dir = join(dirs.private, 'devnets', name);
    if (existsSync(join(dir, 'deployment.json'))) register(name, runtimeOf(dir));
  }

  for (const [name, reg] of Object.entries(registry())) {
    if (reg.status === 'deleted' || reg.upgradeScopes) continue;
    const scopes = upgradeScopes(name);
    if (scopes) register(name, { upgradeScopes: scopes });
  }

  async function ami(arch) {
    const p = await ssm.send(new GetParameterCommand({ Name: `/aws/service/canonical/ubuntu/server/24.04/stable/current/${arch}/hvm/ebs-gp3/ami-id` }));
    return p.Parameter.Value;
  }

  async function run(r, name, args, opts = {}) {
    const code = await dashnet(r, args, { ...opts, bin: opts.bin || pinBinary(workDir(r.network)) });
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
    if (blockSeconds(d) !== 10 && !supports(r.network, 'deployment-plan', 'block-time')) throw new Error('this devnet\'s pinned dash-network-go has no --block-time; create it with 10-second blocks or after the agent update');
    if (epochSeconds(d) !== 3600 && !supports(r.network, 'deployment-plan', 'epoch-time')) throw new Error('this devnet\'s pinned dash-network-go has no --epoch-time; create it with one-hour Platform epochs or after the agent update');
    const plan = readJSON(join(dir, 'ec2-plan.json'));
    const lock = readJSON(join(dir, 'lock.json'));
    done('ok', `plan ${plan.id.slice(0, 12)}`);
    const groups = {};
    for (const t of plan.targets) { const k = `${t.group}|${t.instanceType}|${t.architecture}`; groups[k] = (groups[k] || 0) + 1; }
    r.review = {
      planId: plan.id, kind: 'create-devnet', preparedAt: new Date().toISOString(),
      footprint: Object.entries(groups).map(([k, count]) => { const [group, type, arch] = k.split('|'); return { group, type, arch, count }; }),
      instances: plan.targets.length, storageGiB: plan.targets.length * d.rootVolumeGiB, estimate: estimate(d),
      images: Object.fromEntries([...COMPONENTS, ...(d.images.acme ? ['acme'] : [])].map((c) => [c, { ref: d.images[c], digests: lockDigests(lock, c) }])),
      protocol: d.protocol, blockTimeSeconds: blockSeconds(d), platformEpochSeconds: epochSeconds(d), coreNetwork: coreNetwork(name), platformChainId: `dash-${coreNetwork(name)}`,
      dns: serviceNames(name, d, coreNetwork(name)), services: d.services, amis, network: { vpc: d.vpcId, subnet: d.subnetId, securityGroups: d.securityGroupIds, ipamPool: d.ipamPoolId },
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
    // Records created before stage tracking: derive completed stages from their steps.
    r.done ??= [['provision', 'dashnet provision)'], ['bootstrap', 'dashnet bootstrap)'], ['deploy', 'dashnet deploy)']]
      .filter(([, tag]) => r.steps.some((st) => st.name.endsWith(tag) && st.status === 'ok')).map(([k]) => k);
    const reg = registry()[name];
    if (reg && ['deleting', 'deleted'].includes(reg.status)) throw new Error(`${name} is ${reg.status}; this creation cannot resume`);
    r.status = 'running'; save(r);
    // Resume continues at the first stage that has not completed.
    const once = async (key, fn) => { if (r.done.includes(key)) return; await fn(); r.done.push(key); save(r); };
    if (reg?.status === 'failed') register(name, { status: r.done.includes('deploy') ? 'services' : 'creating' });
    if (!r.done.includes('deploy')) register(name, { status: 'creating', displayName: d.displayName, createdBy: r.actor.login, createdAt: r.createdAt, operation: r.id, coreNetwork: coreNetwork(name), public: d.public !== false, dns: serviceNames(name, d), services: d.services, dnsZoneId: d.dnsZoneId });

    let done;
    await once('provision', async () => {
      done = step(r, `Provision ${plan.targets.length} EC2 instances (dashnet provision)`);
      await run(r, 'provision', ['provision', '--plan', join(dir, 'ec2-plan.json'), '--confirm', plan.id, '--timeout', '20m'], { timeoutMs: 21 * 60_000 });
      done('ok');
    });

    if (!existsSync(join(dir, 'bootstrap-plan.json'))) {
      done = step(r, 'Bootstrap plan (dashnet bootstrap-plan)');
      await run(r, 'bootstrap-plan', ['bootstrap-plan', '--compute-plan', join(dir, 'ec2-plan.json'), '--lock', join(dir, 'lock.json'), '--ssh-user', 'ubuntu', '--address', 'public', '--out', join(dir, 'bootstrap-plan.json')]);
      done('ok');
    }
    const bplan = readJSON(join(dir, 'bootstrap-plan.json'));

    if (!existsSync(join(dir, 'known_hosts'))) {
      done = step(r, 'Host keys from EC2 console (dashnet host-trust)');
      let ok = false;
      // New instances publish their host keys to the console within a minute
      // or two; poll often so bootstrap starts as soon as they are complete.
      const deadline = Date.now() + 15 * 60_000;
      for (let attempt = 1; attempt <= 60 && !ok && Date.now() < deadline; attempt++) {
        if (r.cancelRequested) throw new Error('cancelled by operator');
        const out = join(dir, `known_hosts.${stamp()}`);
        ok = (await run(r, 'host-trust', ['host-trust', '--bootstrap-plan', join(dir, 'bootstrap-plan.json'), '--timeout', '3m', '--out', out], { allowFail: true, timeoutMs: 4 * 60_000 })) === 0;
        if (ok) writeFileSync(join(dir, 'known_hosts'), readFileSync(out), { mode: 0o600 });
        else { write(r.id, `console output not complete yet; retry ${attempt}/60 in 10s`); await sleep(10_000); }
      }
      if (!ok) { done('failed'); throw new Error('host keys unavailable from EC2 console output'); }
      done('ok');
    }
    pinHostKeys(r, readFileSync(join(dir, 'known_hosts'), 'utf8'));

    await once('bootstrap', async () => {
      done = step(r, 'Prepare hosts: Docker, images (dashnet bootstrap)');
      await run(r, 'bootstrap', ['bootstrap', '--plan', join(dir, 'bootstrap-plan.json'), '--confirm', bplan.id, ...access(dir), '--timeout', '45m', '--out', join(dir, `hosts-ready.${stamp()}.json`)], { timeoutMs: 46 * 60_000 });
      done('ok');
    });

    if (!existsSync(join(dir, 'deployment.json'))) {
      done = step(r, `Deployment plan, Platform protocol ${d.protocol} (dashnet deployment-plan)`);
      // Public IPAM addresses and Let's Encrypt gateway certificates, as
      // long-running devnets have; explicit so a missing prerequisite fails.
      const tls = d.images.acme && d.ipamPoolId ? ['--gateway-tls', 'letsencrypt', '--acme-email', d.acmeEmail] : ['--gateway-tls', 'self-signed'];
      await run(r, 'deployment-plan', ['deployment-plan', '--bootstrap-plan', join(dir, 'bootstrap-plan.json'), '--protocol', String(d.protocol), '--advertise', d.ipamPoolId ? 'public' : 'private', ...tls, ...(supports(name, 'deployment-plan', 'block-time') ? ['--block-time', String(blockSeconds(d))] : []), ...(supports(name, 'deployment-plan', 'epoch-time') ? ['--epoch-time', String(epochSeconds(d))] : []), '--out', join(dir, 'deployment.json')]);
      done('ok');
    }
    const dplan = readJSON(join(dir, 'deployment.json'));
    register(name, { coreNetwork: devnetChain(dplan.coreNetwork), platformChainId: dplan.platformChainId, platformEpochSeconds: dplan.platformEpochSeconds || 3600, ...runtimeOf(dir) });

    // Platform does not hold up creation: it starts in a follow-up operation as
    // soon as the quorums form, as legacy devnets did. Devnets pinned to a
    // dash-network-go without --core-only deploy everything here instead.
    const coreOnly = supports(name, 'deploy', 'core-only');
    await once('deploy', async () => {
    done = step(r, coreOnly ? 'Core, EvoNode registration, rotation cycles, DKG on (dashnet deploy --core-only)' : 'Core, EvoNode registration, quorums, Platform (dashnet deploy)');
    // A validator can be PoSe-banned by an early DKG while the fleet is still
    // forming; dashnet then waits forever for it. Revive such nodes meanwhile.
    const watcher = setInterval(() => reviveBanned(r, name, dplan).catch((e) => write(r.id, `revive: ${e.message}`)), 60_000);
    try {
      // Service images need no chain: build them on the wallet host meanwhile.
      // Best effort (it never rejects); the install builds whatever is missing.
      const early = prebuildServices({ r, write, dplan, d, name, pool });
      try {
        const minutes = coreOnly ? 60 : deployMinutes(d);
        await run(r, 'deploy', ['deploy', ...(coreOnly ? ['--core-only'] : []), '--plan', join(dir, 'deployment.json'), '--confirm', dplan.id, ...access(dir), '--timeout', `${minutes}m`, '--observation-window', `${observeSeconds(d)}s`, '--out', join(dir, `deployed.${stamp()}.json`)], { timeoutMs: (minutes + 1) * 60_000 });
      } finally { await early; } // never leave it running past this operation
    } finally { clearInterval(watcher); }
    done('ok');
    register(name, { status: 'services' });
    });

    await once('services', async () => {
      done = step(r, coreOnly ? 'Faucet, Insight, quorum server, DNS and TLS (Platform Explorer follows Platform)' : 'Quorum server, Platform Explorer, faucet, DNS and TLS');
      registerNames(name, d, dplan);
      const services = await deployServices({ r, write, dplan, d, name, pool, s, ec2, r53, dir, platformPending: coreOnly });
      register(name, { services: d.services, dns: services.dns, walletAddress: services.walletAddress, promoCodes: services.promoCodes });
      done('ok', services.summary);
    });

    if (!coreOnly) {
      done = step(r, 'Health check (dashnet doctor)');
      const window = observeSeconds(d);
      const code = await run(r, 'doctor', ['doctor', '--plan', join(dir, 'deployment.json'), ...access(dir), '--timeout', `${window + 300}s`, '--observation-window', `${window}s`, '--out', join(dir, `health.${stamp()}.json`)], { allowFail: true, timeoutMs: (window + 360) * 1000 });
      done(code === 0 ? 'ok' : 'warn', code === 0 ? 'all targets healthy' : 'see log');
      register(name, { status: 'ready', platform: 'ready', blockTimeSeconds: blockSeconds(d), readyAt: new Date().toISOString(), upgradeScopes: upgradeScopes(name) });
      return;
    }
    // A resumed creation must not reset a Platform that already started.
    register(name, { status: 'ready', ...(r.done.includes('platform-op') ? {} : { platform: 'starting' }), blockTimeSeconds: blockSeconds(d), readyAt: registry()[name]?.readyAt || new Date().toISOString(), upgradeScopes: upgradeScopes(name) });
    await once('platform-op', async () => {
      const now = new Date().toISOString(), id = randomUUID();
      const follow = { id, network: name, actor: r.actor, createdAt: now, status: 'confirmed', confirmedBy: r.confirmedBy || r.actor, confirmedAt: now, autoConfirmed: true, steps: [],
        request: { id, network: name, action: 'devnet-platform', nodes: [], components: [], images: {}, options: {} },
        review: { kind: 'devnet-platform', planId: `platform-${name}`, preparedAt: now, createdBy: r.id } };
      save(follow);
      write(id, `queued by the creation of ${name} (${r.id}): start Platform as soon as its quorums form`);
      r.result = { ...(r.result || {}), platformOperation: id };
      write(r.id, `Core is ready; Platform starts in operation ${id} as soon as the quorums form`);
    });
  }

  // Follows a creation: waits for the quorums, starts Platform, then brings up
  // the Platform Explorer and checks the whole fleet.
  async function executePlatform(r) {
    const name = r.network, dir = workDir(name);
    const d = readJSON(join(dir, 'request.json')), dplan = readJSON(join(dir, 'deployment.json'));
    const reg = registry()[name];
    if (!reg || !dplan || ['deleting', 'deleted', 'failed'].includes(reg.status)) throw new Error(`${name} is ${reg?.status || 'unknown'}; Platform not started`);
    r.status = 'running'; r.done ??= []; save(r);
    if (reg.platform !== 'ready') register(name, { platform: 'starting' });
    const once = async (key, fn) => { if (r.done.includes(key)) return; await fn(); r.done.push(key); save(r); };
    let done;
    await once('deploy', async () => {
      done = step(r, 'Wait for quorums, then start Drive, Tenderdash and DAPI (dashnet deploy)');
      const watcher = setInterval(() => reviveBanned(r, name, dplan).catch((e) => write(r.id, `revive: ${e.message}`)), 60_000);
      try {
        const minutes = deployMinutes(d);
        await run(r, 'deploy', ['deploy', '--plan', join(dir, 'deployment.json'), '--confirm', dplan.id, ...access(dir), '--timeout', `${minutes}m`, '--observation-window', `${observeSeconds(d)}s`, '--out', join(dir, `deployed.${stamp()}.json`)], { timeoutMs: (minutes + 1) * 60_000 });
      } finally { clearInterval(watcher); }
      done('ok');
    });
    await once('services', async () => {
      done = step(r, 'Platform Explorer and all services');
      registerNames(name, d, dplan);
      const services = await deployServices({ r, write, dplan, d, name, pool, s: getSettings(), ec2, r53, dir });
      register(name, { dns: services.dns, walletAddress: services.walletAddress, promoCodes: services.promoCodes });
      done('ok', services.summary);
    });
    done = step(r, 'Health check (dashnet doctor)');
    const window = observeSeconds(d);
    const code = await run(r, 'doctor', ['doctor', '--plan', join(dir, 'deployment.json'), ...access(dir), '--timeout', `${window + 300}s`, '--observation-window', `${window}s`, '--out', join(dir, `health.${stamp()}.json`)], { allowFail: true, timeoutMs: (window + 360) * 1000 });
    done(code === 0 ? 'ok' : 'warn', code === 0 ? 'all targets healthy' : 'see log');
    register(name, { platform: 'ready', platformReadyAt: new Date().toISOString() });
  }

  const revived = new Map();
  async function reviveBanned(r, name, dplan) {
    const state = readJSON(join(dirs.state, `${name}.json`));
    const banned = (state?.hosts || []).filter((h) => h.role === 'validator' && h.probe?.data?.core?.masternode?.state === 'POSE_BANNED');
    const wallet = dplan.targets.find((t) => t.role === 'wallet');
    const w = { name: wallet.name, instanceId: wallet.instanceId, publicIp: wallet.sshAddress };
    const core = `sudo docker exec -i $(sudo docker ps --format '{{.Names}}' | grep -- '-core$' | head -1) dash-cli -conf=/etc/dash/dash.conf`;
    for (const h of banned) {
      if (Date.now() - (revived.get(h.instanceId) || 0) < 10 * 60_000) continue;
      revived.set(h.instanceId, Date.now());
      const t = dplan.targets.find((x) => x.instanceId === h.instanceId);
      if (!t) continue;
      const list = JSON.parse(await pool.exec(w, `${core} protx list registered true`, null, 60_000));
      const mn = list.find((x) => x.state.service.startsWith(`${t.peerAddress}:`));
      if (!mn || mn.state.PoSeBanHeight <= 0) continue;
      const s = mn.state;
      // Fee from an existing confirmed, unlocked wallet UTXO.
      const locked = new Set(JSON.parse(await pool.exec(w, `${core} -rpcwallet=dashnet listlockunspent`, null, 60_000)).map((u) => `${u.txid}:${u.vout}`));
      const utxo = JSON.parse(await pool.exec(w, `${core} -rpcwallet=dashnet listunspent 1`, null, 60_000)).find((u) => u.amount >= 1 && !locked.has(`${u.txid}:${u.vout}`) && u.address);
      if (!utxo) { write(r.id, `revive ${t.name}: no spendable fee UTXO yet`); continue; }
      const key = (await pool.exec({ name: t.name, instanceId: t.instanceId, publicIp: t.sshAddress }, `sudo python3 -c 'import json;print(json.load(open("/var/lib/dashnet/secrets.json"))["operatorPrivateKey"])'`, null, 30_000)).trim();
      if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`unexpected operator key format on ${t.name}`);
      // The key and everything after it go on stdin (dash-cli -stdin), never on a
      // command line that sudo logs or ps shows.
      const tx = (await pool.exec(w, `${core} -rpcwallet=dashnet -stdin protx update_service_evo ${mn.proTxHash} ${s.service}`, [key, s.platformNodeID, s.platformP2PPort, s.platformHTTPPort, '', utxo.address].join('\n') + '\n', 60_000)).trim();
      write(r.id, `revived PoSe-banned ${t.name} (ban height ${s.PoSeBanHeight}) with ProUpServTx ${tx.slice(0, 16)}…`);
    }
  }

  // Keys from the EC2 console are authoritative. The collector may already have
  // pinned a key on first contact; a matching pin is marked verified, and a
  // different one is replaced and its session dropped.
  function pinHostKeys(r, text) {
    for (const line of text.split('\n')) {
      const [alias, type, value] = line.trim().split(/\s+/);
      const id = alias?.split('.')[0];
      if (!/^i-[0-9a-f]+$/.test(id || '') || type !== 'ssh-ed25519') continue;
      const had = pool.pins[id];
      if (had?.source && had.type === type && had.key === value) continue;
      if (had && (had.type !== type || had.key !== value)) write(r.id, `WARNING: first-contact host key for ${id} differs from the EC2 console key; replaced with the console key`);
      pool.pins[id] = { type, key: value, address: had?.address ?? null, pinnedAt: new Date().toISOString(), source: 'EC2 console (dashnet host-trust)' };
      if (had && (had.type !== type || had.key !== value)) pool.drop?.(id);
    }
    pool.savePins();
  }

  // ---- native image upgrades (dash-network-go upgrade-plan / upgrade) -------
  const currentYaml = (dir) => (existsSync(join(dir, 'network-current.yaml')) ? join(dir, 'network-current.yaml') : join(dir, 'network.yaml'));

  // Core and Platform images change in separate dash-network-go rollouts:
  // Core first (every node), then Platform (validators). One console operation
  // runs both; the Platform plan is made after Core completes, from the
  // runtime that rollout recorded.
  const PLATFORM = ['drive', 'dapi', 'gateway', 'helper', 'tenderdash'];
  const phasesOf = (components) => [
    ...(components.includes('core') ? [{ scope: 'core', components: ['core'] }] : []),
    ...(components.some((c) => PLATFORM.includes(c)) ? [{ scope: components.every((c) => c === 'tenderdash' || c === 'core') ? 'tenderdash' : 'platform', components: components.filter((c) => PLATFORM.includes(c)) }] : []),
  ];

  function candidate(dir, base, components, images) {
    let yaml = readFileSync(base, 'utf8');
    for (const c of components) {
      const ref = images[c].startsWith('docker.io/') ? images[c] : `docker.io/${images[c]}`;
      const re = new RegExp(`^(  ${c}: ).*$`, 'm');
      if (!re.test(yaml)) throw new Error(`network definition has no ${c} image`);
      yaml = yaml.replace(re, `$1${ref}`);
    }
    return yaml;
  }

  async function planPhase(r, dir, phase, n) {
    const a = { candidate: `candidate-${r.artifacts.ts}-${n}.yaml`, lock: `candidate-${r.artifacts.ts}-${n}.lock.json`, plan: `upgrade-${r.artifacts.ts}-${n}.json` };
    // Each phase changes only its own images on top of the current network.
    writeFileSync(join(dir, a.candidate), candidate(dir, currentYaml(dir), phase.components, r.request.images), { mode: 0o600 });
    let done = step(r, `Resolve ${phase.scope === 'core' ? 'Core' : 'Platform'} images (dashnet resolve)`);
    await run(r, 'resolve', ['resolve', '--network', join(dir, a.candidate), '--out', join(dir, a.lock)], { timeoutMs: 5 * 60_000, bin: r.artifacts.bin });
    done('ok', phase.components.map((c) => `${c} ${r.request.images[c]}`).join(', '));
    done = step(r, `Upgrade plan, scope ${phase.scope} (dashnet upgrade-plan)`);
    await run(r, 'upgrade-plan', ['upgrade-plan', '--deployment-plan', join(dir, 'deployment.json'), '--network', join(dir, a.candidate), '--lock', join(dir, a.lock), '--scope', phase.scope, '--out', join(dir, a.plan)], { timeoutMs: 5 * 60_000, bin: r.artifacts.bin });
    const plan = readJSON(join(dir, a.plan));
    const changes = [];
    for (const [node, to] of Object.entries(plan.to || {})) for (const [component, pin] of Object.entries(to)) {
      const from = plan.from?.[node]?.[component];
      if (from !== pin) changes.push({ node, component, from, to: pin, requested: r.request.images[component] || null, dependency: !phase.components.includes(component), phase: phase.scope });
    }
    done('ok', `${changes.length} container change(s)`);
    return { ...phase, ...a, planId: plan.id, changes };
  }

  async function prepareUpgrade(r) {
    const name = r.network, dir = workDir(name);
    if (!existsSync(join(dir, 'deployment.json'))) throw new Error('devnet is not deployed yet');
    adoptCompatible(r, name);
    r.status = 'preparing'; r.artifacts = { ts: stamp() };
    // The upgrade executes with exactly the binary that planned it, even if the
    // devnet adopts a newer one meanwhile (upgrade plans bind its recipe).
    r.artifacts.bin = join(dir, `dashnet.upgrade-${r.artifacts.ts}`);
    copyFileSync(join(dir, 'dashnet'), r.artifacts.bin); chmodSync(r.artifacts.bin, 0o700);
    save(r);
    const phases = phasesOf(r.request.components);
    // The first phase is planned exactly now; a later one after its predecessor.
    const first = await planPhase(r, dir, phases[0], 0);
    r.artifacts.phases = [first, ...phases.slice(1)];
    const later = phases.slice(1).map((p) => ({ scope: p.scope, components: p.components, images: Object.fromEntries(p.components.map((c) => [c, r.request.images[c]])) }));
    r.review = { planId: first.planId, operation: 'upgrade', scope: phases.map((p) => p.scope).join(' + '), changes: first.changes, then: later,
      targets: [...new Set(first.changes.map((c) => c.node))], preparedAt: new Date().toISOString() };
  }

  async function executeUpgrade(r) {
    const name = r.network, dir = workDir(name);
    // Older records carried a single plan.
    r.artifacts.phases ??= [{ scope: readJSON(join(dir, r.artifacts.plan))?.scope, candidate: r.artifacts.candidate, lock: r.artifacts.lock, plan: r.artifacts.plan, planId: r.review.planId }];
    r.status = 'running'; r.progress = { phase: 'upgrading', completed: [], current: null }; r.done ??= []; save(r);
    for (let n = 0; n < r.artifacts.phases.length; n++) {
      let phase = r.artifacts.phases[n];
      if (r.done.includes(`phase-${n}`)) continue;
      if (!phase.plan) { phase = await planPhase(r, dir, phase, n); r.artifacts.phases[n] = phase; save(r); }
      const plan = readJSON(join(dir, phase.plan));
      if (!plan || plan.id !== phase.planId || (n === 0 && plan.id !== r.review?.planId)) throw new Error('reviewed upgrade plan missing');
      refreshSnapshot(r, dir, plan);
      const who = plan.scope === 'core' ? 'every node one at a time (Core: validators, then the mining node)' : 'validators one at a time';
      const done = step(r, `Upgrade ${who} (dashnet upgrade, scope ${plan.scope})`);
      r.progress = { phase: plan.scope, completed: [], current: null }; save(r);
      // A Core rollout visits every node and may wait up to a DKG cycle for its
      // quiet window; every node's health check needs two samples.
      const d = readJSON(join(dir, 'request.json')), nodes = readJSON(join(dir, 'deployment.json'))?.targets?.length || 14;
      const window = observeSeconds(d);
      const minutes = plan.scope === 'core' ? Math.max(240, Math.ceil((nodes * (26 * blockSeconds(d) + 420 + window)) / 60)) : Math.max(110, Math.ceil((nodes * (2 * window + 180)) / 60));
      await run(r, 'upgrade', ['upgrade', '--plan', join(dir, phase.plan), '--confirm', plan.id, ...access(dir), '--observation-window', `${window}s`, '--timeout', `${minutes}m`, '--out', join(dir, `upgrade-result.${stamp()}.json`)], {
        timeoutMs: (minutes + 1) * 60_000, bin: r.artifacts.bin,
        onLine: (line) => {
          const m = /((?:validators|wallet|miner|fullnodes?)-\d+)/.exec(line);
          if (m && /appl|withdraw|replac|upgrad/i.test(line)) { r.progress.current = m[1]; if (/complete|done|verified|upgraded/i.test(line) && !r.progress.completed.includes(m[1])) r.progress.completed.push(m[1]); save(r); }
        },
      });
      // The network file now carries this phase's images for later operations.
      writeFileSync(join(dir, 'network-current.yaml'), readFileSync(join(dir, phase.candidate)), { mode: 0o600 });
      register(name, runtimeOf(dir));
      r.done.push(`phase-${n}`); save(r);
      done('ok');
    }
  }

  async function doctor(r) {
    const name = r.network, dir = workDir(name);
    adoptCompatible(r, name);
    r.status = 'running'; save(r);
    const done = step(r, 'Health check (dashnet doctor)');
    const out = join(dir, `health.${stamp()}.json`);
    const window = observeSeconds(readJSON(join(dir, 'request.json')));
    const code = await run(r, 'doctor', ['doctor', '--plan', join(dir, 'deployment.json'), ...access(dir), '--timeout', `${window + 270}s`, '--observation-window', `${window}s`, '--out', out], { allowFail: true, timeoutMs: (window + 330) * 1000 });
    const h = readJSON(out) || {};
    const nodes = {};
    for (const [n, v] of Object.entries(h.nodes || h.targets || {})) nodes[n] = { healthy: !!v.healthy, status: v.status || (v.healthy ? 'healthy' : 'unhealthy'), problems: v.problems || [] };
    r.result = { healthy: code === 0, nodes };
    done(code === 0 ? 'ok' : 'failed', code === 0 ? 'all targets healthy' : 'see node results and log');
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
    r.review = { kind: 'devnet-services', planId: `services-${name}-${Date.now()}`, preparedAt: new Date().toISOString(), from: d.services, to: services, dns: serviceNames(name, d, reg.coreNetwork) };
  }

  async function executeServices(r) {
    const name = r.network, dir = workDir(name);
    const reg = registry()[name];
    if (!reg || ['deleting', 'deleted'].includes(reg.status)) throw new Error(`${name} is ${reg?.status || 'unknown'}; services not changed`);
    const d = readJSON(join(dir, 'request.json'));
    d.services = r.review.to;
    const dplan = readJSON(join(dir, 'deployment.json'));
    r.status = 'running'; save(r);
    const done = step(r, 'Quorum server, Platform Explorer, faucet, DNS and TLS');
    // Until Platform runs, its explorer parts and checks wait for it.
    registerNames(name, d, dplan);
    const services = await deployServices({ r, write, dplan, d, name, pool, s: getSettings(), ec2, r53, dir, platformPending: !!reg.platform && reg.platform !== 'ready' });
    writeFileSync(join(dir, 'request.json'), JSON.stringify(d), { mode: 0o600 });
    register(name, { services: d.services, dns: services.dns, promoCodes: services.promoCodes, status: registry()[name]?.status === 'failed' ? 'ready' : registry()[name]?.status });
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
    const zone = reg.dnsZoneId || getSettings().devnets.dnsZoneId;
    // One lookup per name: Route 53 orders names by reversed labels, so a
    // listing from one name need not reach quorums.<name>-g1 or the others.
    const records = async () => {
      const found = [];
      for (const h of hosts) found.push(...((await r53.send(new ListResourceRecordSetsCommand({ HostedZoneId: zone, StartRecordName: h, StartRecordType: 'A', MaxItems: '1' }))).ResourceRecordSets || []));
      return found;
    };
    const existing = await records();
    const changes = existing.filter((x) => x.Type === 'A' && hosts.includes(x.Name.replace(/\.$/, ''))).map((x) => ({ Action: 'DELETE', ResourceRecordSet: x }));
    if (changes.length) await r53.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: zone, ChangeBatch: { Changes: changes } }));
    const left = (await records()).filter((x) => x.Type === 'A' && hosts.includes(x.Name.replace(/\.$/, '')));
    if (left.length) { done('failed'); throw new Error(`DNS records still present: ${left.map((x) => x.Name).join(', ')}`); }
    done('ok', `${changes.length} removed, none left`);
    done = step(r, 'Terminate instances');
    let instances = await owned(name);
    if (instances.length) await ec2.send(new TerminateInstancesCommand({ InstanceIds: instances.map((i) => i.InstanceId) }));
    for (let i = 0; i < 60 && (instances = (await owned(name)).filter((x) => x.State?.Name !== 'terminated')).length; i++) await wait(10_000);
    if (instances.length) { done('failed'); throw new Error(`${instances.length} instance(s) not terminated yet`); }
    done('ok');
    if (existsSync(join(dir, 'ec2-plan.json'))) {
      // EC2 detaches an Elastic IP some time after its instance reports
      // "terminated"; a release before then fails with InvalidIPAddress.InUse
      // (devnet-console-2, 2026-09-29: 32 s after termination).
      done = step(r, 'Wait for addresses to detach');
      const attached = async () => ((await ec2.send(new DescribeAddressesCommand({ Filters: [{ Name: 'tag:dashnet:network', Values: [name] }, { Name: 'tag:dashnet:managed-by', Values: ['dash-network-go'] }] }))).Addresses || []).filter((a) => a.AssociationId);
      let still = await attached();
      for (let i = 0; i < 30 && still.length; i++) { await wait(10_000); still = await attached(); }
      if (still.length) { done('failed'); throw new Error(`${still.length} address(es) still attached: ${still.map((a) => a.PublicIp).join(', ')}`); }
      done('ok');
      done = step(r, 'Release BYOIP addresses (dashnet release-addresses)');
      const plan = readJSON(join(dir, 'ec2-plan.json'));
      // The agent's current dashnet, not the devnet's pinned build: EC2 plans
      // carry no node recipes, and newer builds can finish a cleanup older ones
      // could not (dash-network-go#24: resumable after EC2 purges terminated instances).
      await run(r, 'release-addresses', ['release-addresses', '--plan', join(dir, 'ec2-plan.json'), '--confirm', plan.id, '--timeout', '10m'], { timeoutMs: 11 * 60_000, bin: binary });
      done('ok');
    }
    done = step(r, 'Delete retained root volumes');
    const volumes = async () => ((await ec2.send(new DescribeVolumesCommand({ Filters: [{ Name: 'tag:dashnet:network', Values: [name] }, { Name: 'tag:dashnet:managed-by', Values: ['dash-network-go'] }] }))).Volumes || []).filter((v) => v.State !== 'deleted');
    let deleted = 0, vols = [];
    for (let i = 0; i < 30; i++) {
      vols = await volumes();
      if (!vols.length) break;
      for (const v of vols.filter((x) => x.State === 'available')) { await ec2.send(new DeleteVolumeCommand({ VolumeId: v.VolumeId })); deleted++; }
      await wait(10_000);
    }
    vols = await volumes();
    if (vols.length) { done('failed'); throw new Error(`${vols.length} volume(s) remain: ${vols.map((v) => `${v.VolumeId} ${v.State}`).join(', ')}`); }
    done('ok', `${deleted} deleted, none left`);
    register(name, { status: 'deleted', deletedAt: new Date().toISOString() });
    log(`devnet ${name} deleted by ${r.actor.login}`);
  }

  // A creation that stopped leaves the devnet visibly failed, not "deploying".
  function markFailed(name) {
    if (['creating', 'services'].includes(registry()[name]?.status)) register(name, { status: 'failed', failedAt: new Date().toISOString() });
  }
  // Failed, cancelled or interrupted: Core stays usable and the Platform
  // operation can be resumed.
  function markPlatformFailed(name) {
    if (registry()[name]?.platform === 'starting') register(name, { platform: 'stopped' });
  }

  return { prepareCreate, executeCreate, executePlatform, prepareServices, executeServices, prepareUpgrade, executeUpgrade, doctor, prepareDelete, executeDelete, registry, markFailed, markPlatformFailed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
