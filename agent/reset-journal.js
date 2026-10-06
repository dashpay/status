// Native Platform reset is an image transition in dashnet's strict journal.
// Preparation only reads it. Execution holds its non-expiring Owner claim until
// every validator is verified and host/controller receipts are durable. A failed
// or interrupted wipe keeps that claim for the SAME operation's Resume.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoDBClient, DescribeTableCommand, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { readJSON, writeAtomic } from '../shared/settings.js';
import { helperFollowsDrive, imagesOf } from './devnets.js';

const stable = (x) => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, stable(x[k])])) : x;
const hash = (x) => createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
const need = (ok, message) => { if (!ok) throw Error(message); };
const clone = (x) => JSON.parse(JSON.stringify(x));
export const RESET_COMPONENTS = ['drive', 'dapi', 'tenderdash', 'gateway', 'helper'];
export function candidateYaml(yaml, images) {
  for (const [c, ref] of Object.entries(images)) {
    need(RESET_COMPONENTS.includes(c) && new RegExp(`^  ${c}: .+$`, 'm').test(yaml), 'reset candidate outside existing Platform images');
    yaml = yaml.replace(new RegExp(`^  ${c}: .+$`, 'm'), `  ${c}: docker.io/${ref.replace(/^(?:index\.)?docker\.io\//, '')}`);
  }
  return yaml;
}
export function transitionRecord(original, plan, id, desired, observations, at) {
  const record = clone(original), from = original.runtime?.images || Object.fromEntries(plan.targets.map((t) => [t.name, Object.fromEntries(t.images.map((i) => [i.component, i.pinned]))]));
  const baseline = {}, completed = {};
  for (const t of plan.targets) {
    const actual = observations[t.name];
    need(actual && hash(actual.images) === hash(from[t.name]), `installed images differ from dashnet journal on ${t.name}`);
    // Native Platform upgrades stage the wallet helper without an upgrade marker.
    need(actual.previousId === (original.runtime?.upgradeId || '') || (t.role !== 'validator' && !actual.previousId), `native upgrade marker differs on ${t.name}`);
    need(desired[t.name].core === from[t.name].core, 'reset attempted to change Core');
    baseline[t.name] = actual.preservation;
    if (t.role === 'validator') completed[t.name] = false;
  }
  const sidecars = original.runtime?.sidecars || original.deployment.sidecars;
  record.runtime = { deploymentId: plan.id, upgradeId: id, images: clone(from), ...(sidecars ? { sidecars } : {}) };
  record.upgrade = { planId: id, previousId: original.runtime?.upgradeId || '', phase: 'applying', from, to: desired, baseline, completed, observedAt: at, ...(sidecars ? { sidecars } : {}) };
  record.revision++; record.updatedAt = at; record.lastRunner = 'status-platform-reset-' + id; delete record.lastError;
  return record;
}

export function createResetJournal({ dirs, ctx, client }) {
  const work = (r) => join(dirs.private, 'devnets', r.network);
  const dir = (r) => { const d = join(dirs.private, 'resets', r.nativeJournalExec || r.id); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
  const file = (r, name) => join(dir(r), `${name}.json`);
  const store = (r, name, value) => writeAtomic(file(r, name), JSON.stringify(value), 0o600);
  const load = (r, name) => readJSON(file(r, name));
  const planOf = (r) => readJSON(join(work(r), 'deployment.json'));
  function db(r) {
    const p = planOf(r), n = p.bootstrap.compute.network;
    return { client: client || new DynamoDBClient({ region: n.aws.region }), TableName: n.aws.provision.stateTable,
      Key: { Network: { S: [n.aws.accountId, n.aws.region, n.metadata.name].join('/') } }, plan: p, n };
  }
  async function read(r) {
    const d = db(r);
    const { Item: item } = await d.client.send(new GetItemCommand({ TableName: d.TableName, Key: d.Key, ConsistentRead: true }));
    need(item?.Data?.S && item.PlanID?.S === d.plan.bootstrap.compute.id, 'native journal identity mismatch');
    const data = JSON.parse(item.Data.S);
    need(data.revision === Number(item.Revision?.N) && data.deployment?.planId === d.plan.id, 'native journal revision/deployment mismatch');
    return { item, data };
  }
  async function prepare(r, choices) {
    // Native resolve publishes without overwriting. Each new preparation keeps
    // its own immutable artifacts; confirmed resumes retain their saved path.
    r.nativeJournalExec = r.execId || r.id;
    const d = db(r);
    need(d.n.metadata.name === r.network && d.plan.profile === 'devnet-dashmate-compose', 'native reset requires matching dashmate deployment');
    const { Table: table } = await d.client.send(new DescribeTableCommand({ TableName: d.TableName }));
    need(table?.TableStatus === 'ACTIVE' && table.TableArn === `arn:aws:dynamodb:${d.n.aws.region}:${d.n.aws.accountId}:table/${d.TableName}` && table.KeySchema?.length === 1 && table.KeySchema[0].AttributeName === 'Network' && table.KeySchema[0].KeyType === 'HASH', 'native state table identity/schema mismatch');
    const snapshot = await read(r);
    need(!snapshot.item.Owner && snapshot.data.deployment.phase === 'network-ready' && (!snapshot.data.upgrade || snapshot.data.upgrade.phase === 'complete'), 'native deployment has an active or unfinished operation');
    store(r, 'journal-before', snapshot);
    const from = snapshot.data.runtime?.images || Object.fromEntries(d.plan.targets.map((t) => [t.name, Object.fromEntries(t.images.map((i) => [i.component, i.pinned]))]));
    const desired = clone(from);
    const normalized = Object.fromEntries(Object.entries(choices).map(([k,v]) => [k, v.replace(/^(?:index\.)?docker\.io\//, '')]));
    const images = helperFollowsDrive(normalized, normalized);
    r.resolvedChoices = images;
    const current = join(work(r), existsSync(join(work(r), 'network-current.yaml')) ? 'network-current.yaml' : 'network.yaml');
    const yaml = candidateYaml(readFileSync(current, 'utf8'), images);
    const candidate = join(dir(r), 'candidate.yaml'), lockPath = file(r, 'candidate-lock');
    writeAtomic(candidate, yaml, 0o600);
    if (Object.keys(images).length) {
      need(await ctx.dashnet(r, ['resolve', '--network', candidate, '--out', lockPath], { bin: join(work(r), 'dashnet'), timeoutMs: 15 * 60_000 }) === 0, 'target image resolution failed');
      const lock = readJSON(lockPath);
      for (const t of d.plan.targets.filter((t) => t.role === 'validator')) for (const c of Object.keys(images)) {
        const image = lock.images.find((i) => i.component === c), platform = image?.platforms.find((p) => p.architecture === t.architecture && p.os === 'linux');
        need(platform && /^sha256:[a-f0-9]{64}$/.test(platform.digest), `target image architecture missing: ${t.name}/${c}`);
        desired[t.name][c] = image.pinned.split('@')[0] + '@' + platform.digest;
      }
    }
    r.nativePlanId = hash([r.execId || r.id, d.plan.id, snapshot.data.revision, desired]);
    r.nativeImages = Object.fromEntries(d.plan.targets.filter((t) => t.role === 'validator').map((t) => [t.name, Object.fromEntries(RESET_COMPONENTS.map((c) => [c, desired[t.name][c]]))]));
    r.nativeArchitectures = Object.fromEntries(d.plan.targets.map((t) => [t.name, t.architecture]));
    store(r, 'target-images', desired);
    return d.plan;
  }
  function seal(r, observations, sidecars) {
    const record = transitionRecord(load(r, 'journal-before').data, planOf(r), r.nativePlanId, load(r, 'target-images'), observations, new Date().toISOString());
    record.upgrade.sidecars = sidecars;
    record.lastRunner = `status-reset-${r.id}`;
    store(r, 'journal-begun', record);
    r.nativeTransitions = Object.fromEntries(planOf(r).targets.map((t) => [t.name, { id: r.nativePlanId, previousId: observations[t.name].previousId, from: record.upgrade.from[t.name], to: record.upgrade.to[t.name], preserve: observations[t.name].preservation }]));
  }
  async function put(r, previous, next) {
    const d = db(r), owner = `status-reset-${r.id}`;
    await d.client.send(new UpdateItemCommand({ TableName: d.TableName, Key: d.Key,
      UpdateExpression: 'SET #data = :data, #rev = :next',
      ConditionExpression: '#plan = :plan AND #owner = :owner AND ((#rev = :previous AND #data = :before) OR (#rev = :next AND #data = :data))',
      ExpressionAttributeNames: { '#plan':'PlanID', '#owner':'Owner', '#data':'Data', '#rev':'Revision' },
      ExpressionAttributeValues: { ':plan':{ S:d.plan.bootstrap.compute.id }, ':owner':{ S:owner }, ':data':{ S:JSON.stringify(next) }, ':next':{ N:String(next.revision) }, ':previous':{ N:String(previous.data.revision) }, ':before':{ S:previous.item?.Data.S || JSON.stringify(previous.data) } } }));
  }
  async function begin(r) {
    const d = db(r), before = load(r, 'journal-before'), begun = load(r, 'journal-begun'), owner = `status-reset-${r.id}`;
    need(begun?.upgrade?.planId === r.nativePlanId, 'unsealed reset review');
    const current = await read(r);
    if (current.data.upgrade?.planId === r.nativePlanId && current.data.upgrade.phase === 'complete') {
      need(!current.item.Owner || current.item.Owner.S === owner, 'native journal claimed by another runner');
      return; // lost acknowledgement after verification/commit: finish receipts only
    }
    if (current.item.Owner?.S !== owner) {
      need(!current.item.Owner, 'native journal claimed by another runner');
      await d.client.send(new UpdateItemCommand({ TableName:d.TableName, Key:d.Key, UpdateExpression:'SET #owner = :owner',
        ConditionExpression:'attribute_not_exists(#owner) AND #plan = :plan AND #rev = :rev AND #data = :data',
        ExpressionAttributeNames:{ '#owner':'Owner','#plan':'PlanID','#rev':'Revision','#data':'Data' },
        ExpressionAttributeValues:{ ':owner':{S:owner}, ':plan':before.item.PlanID, ':rev':before.item.Revision, ':data':before.item.Data } }));
    }
    await put(r, before, begun);
  }
  async function complete(r) {
    const begun = load(r, 'journal-begun');
    let next = load(r, 'journal-complete');
    if (!next) {
      next = clone(begun); next.revision++; next.updatedAt = new Date().toISOString();
      for (const [name, receipt] of Object.entries(r.stages?.['core-migrate'] || {})) {
        need(receipt.ok && receipt.result?.journal?.preservation, 'Core migration receipt missing');
        next.upgrade.baseline[name] = receipt.result.journal.preservation;
      }
      next.runtime.images = clone(next.upgrade.to); next.runtime.sidecars = next.upgrade.sidecars;
      next.upgrade.phase = 'complete'; next.upgrade.observedAt = next.updatedAt;
      for (const name of Object.keys(next.upgrade.completed)) next.upgrade.completed[name] = true;
      next.deployment.genesisCoreHeight = r.anchor.height;
      store(r, 'journal-complete', next);
    }
    const current = await read(r);
    if (current.data.revision !== next.revision || current.item.Data.S !== JSON.stringify(next)) await put(r, { data:begun }, next);
    // Public UI choices reflect the resolved manifest, not a mutable tag that may
    // now point elsewhere. Initial deployment/lock/compute plans stay immutable.
    const lock = readJSON(file(r, 'candidate-lock'));
    let yaml = readFileSync(join(dir(r), 'candidate.yaml'), 'utf8');
    if (lock) yaml = candidateYaml(yaml, Object.fromEntries(lock.images.filter((i) => Object.keys(r.resolvedChoices || {}).includes(i.component)).map((i) => [i.component, i.pinned])));
    writeAtomic(join(work(r), 'network-current.yaml'), yaml, 0o600);
    const path = join(dirs.data, 'devnets.json'), registry = readJSON(path, {});
    registry[r.network] = { ...registry[r.network], images:imagesOf(yaml), updatedAt:next.updatedAt };
    writeAtomic(path, JSON.stringify(registry));
    writeAtomic(join(work(r), 'platform-reset.json'), JSON.stringify({ operation:r.id, anchor:r.anchor, verifiedAt:next.updatedAt }), 0o600);
    if (current.item.Owner) {
      const d = db(r);
      await d.client.send(new UpdateItemCommand({ TableName:d.TableName, Key:d.Key, UpdateExpression:'REMOVE #owner', ConditionExpression:'#owner = :owner AND #plan = :plan AND #rev = :rev',
        ExpressionAttributeNames:{'#owner':'Owner','#plan':'PlanID','#rev':'Revision'}, ExpressionAttributeValues:{':owner':{S:`status-reset-${r.id}`},':plan':{S:d.plan.bootstrap.compute.id},':rev':{N:String(next.revision)}} }));
    }
  }
  return { prepare, seal, begin, complete, original: (r) => load(r, 'journal-before').data };
}
