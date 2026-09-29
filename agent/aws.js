// AWS inventory for the board's AWS page: what runs where and what it costs.
// Read-only (IAM inline policy status-inventory on the agent's role). Resources
// every 10 minutes across the account's enabled regions; ECR sizes, snapshots
// and instance-type facts every 6 hours; Cost Explorer (billed per request)
// every 12 hours. Writes data/aws/inventory.json for the web.
import { EC2Client, DescribeRegionsCommand, DescribeInstanceTypesCommand, paginateDescribeInstances, paginateDescribeVolumes, DescribeAddressesCommand, paginateDescribeNatGateways, paginateDescribeSnapshots } from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2Client, paginateDescribeLoadBalancers as paginateAlb } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ElasticLoadBalancingClient, paginateDescribeLoadBalancers as paginateClb } from '@aws-sdk/client-elastic-load-balancing';
import { CloudFrontClient, paginateListDistributions } from '@aws-sdk/client-cloudfront';
import { LambdaClient, paginateListFunctions } from '@aws-sdk/client-lambda';
import { DynamoDBClient, paginateListTables } from '@aws-sdk/client-dynamodb';
import { ECRClient, paginateDescribeRepositories, paginateDescribeImages } from '@aws-sdk/client-ecr';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON, writeAtomic } from '../shared/settings.js';

const MIN = 60_000, HOUR = 60 * MIN;
const TAGS = ['Name', 'DashNetwork', 'Project', 'Environment', 'Owner', 'dashnet:network', 'aws:cloudformation:stack-name'];

const tagMap = (tags) => Object.fromEntries((tags || []).filter((t) => TAGS.includes(t.Key)).map((t) => [t.Key, String(t.Value).slice(0, 120)]));
const iso = (d) => (d ? new Date(d).toISOString() : null);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

async function all(paginator, pick) {
  const out = [];
  for await (const page of paginator) out.push(...(pick(page) || []));
  return out;
}

export function defaultClients() {
  const cache = new Map();
  const make = (Kind, region) => {
    const k = `${Kind.name}:${region}`;
    if (!cache.has(k)) cache.set(k, new Kind({ region, maxAttempts: 4 }));
    return cache.get(k);
  };
  return {
    ec2: (r) => make(EC2Client, r), alb: (r) => make(ElasticLoadBalancingV2Client, r), clb: (r) => make(ElasticLoadBalancingClient, r),
    lambda: (r) => make(LambdaClient, r), dynamodb: (r) => make(DynamoDBClient, r), ecr: (r) => make(ECRClient, r),
    cloudfront: () => make(CloudFrontClient, 'us-east-1'), s3: () => make(S3Client, 'us-east-1'), ce: () => make(CostExplorerClient, 'us-east-1'),
  };
}

export function createAwsInventory({ dataDir, home = 'us-west-2', clients = defaultClients(), clock = Date.now, log = () => {} }) {
  const dir = join(dataDir, 'aws');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'inventory.json');
  let inv = readJSON(path, null);
  const slow = { at: 0, ecr: inv?.ecr || [], snapshots: inv?.snapshots || [], types: inv?.instanceTypes || {} };
  let costsAt = inv?.costs?.at ? Date.parse(inv.costs.at) : 0;
  let running = false;

  async function regionScan(region, errors, heavy) {
    const ec2 = clients.ec2(region);
    const guard = async (scope, fn, fallback = []) => {
      try { return await fn(); } catch (e) { errors.push({ region, scope, error: String(e.name === e.message ? e.name : `${e.name}: ${e.message}`).slice(0, 200) }); return fallback; }
    };
    const [reservations, volumes, addresses, nats, albs, clbs, functions, tables] = await Promise.all([
      guard('ec2:DescribeInstances', () => all(paginateDescribeInstances({ client: ec2 }, {}), (p) => p.Reservations)),
      guard('ec2:DescribeVolumes', () => all(paginateDescribeVolumes({ client: ec2 }, {}), (p) => p.Volumes)),
      guard('ec2:DescribeAddresses', async () => (await ec2.send(new DescribeAddressesCommand({}))).Addresses),
      guard('ec2:DescribeNatGateways', () => all(paginateDescribeNatGateways({ client: ec2 }, {}), (p) => p.NatGateways)),
      guard('elasticloadbalancing:DescribeLoadBalancers', () => all(paginateAlb({ client: clients.alb(region) }, {}), (p) => p.LoadBalancers)),
      guard('elasticloadbalancing:DescribeLoadBalancers (classic)', () => all(paginateClb({ client: clients.clb(region) }, {}), (p) => p.LoadBalancerDescriptions)),
      guard('lambda:ListFunctions', () => all(paginateListFunctions({ client: clients.lambda(region) }, {}), (p) => p.Functions)),
      guard('dynamodb:ListTables', () => all(paginateListTables({ client: clients.dynamodb(region) }, {}), (p) => p.TableNames)),
    ]);
    const instances = reservations.flatMap((r) => r.Instances || []).map((i) => ({
      region, az: i.Placement?.AvailabilityZone || null, id: i.InstanceId, type: i.InstanceType, state: i.State?.Name, launchTime: iso(i.LaunchTime),
      publicIp: i.PublicIpAddress || null, privateIp: i.PrivateIpAddress || null, arch: i.Architecture, platform: i.PlatformDetails || null,
      lifecycle: i.InstanceLifecycle || 'on-demand', tags: tagMap(i.Tags), keyName: i.KeyName || null,
      volumes: (i.BlockDeviceMappings || []).map((b) => b.Ebs?.VolumeId).filter(Boolean),
    }));
    const out = {
      instances,
      volumes: volumes.map((v) => ({ region, id: v.VolumeId, sizeGiB: v.Size, type: v.VolumeType, state: v.State, iops: v.Iops || null, createTime: iso(v.CreateTime), attachedTo: v.Attachments?.[0]?.InstanceId || null, name: tagMap(v.Tags).Name || null })),
      addresses: addresses.map((a) => ({ region, publicIp: a.PublicIp, allocationId: a.AllocationId, instanceId: a.InstanceId || null, associated: !!a.AssociationId, name: tagMap(a.Tags).Name || null, pool: a.PublicIpv4Pool || null })),
      natGateways: nats.filter((n) => n.State !== 'deleted').map((n) => ({ region, id: n.NatGatewayId, state: n.State, vpcId: n.VpcId, publicIp: n.NatGatewayAddresses?.[0]?.PublicIp || null, createTime: iso(n.CreateTime), name: tagMap(n.Tags).Name || null })),
      loadBalancers: [
        ...albs.map((l) => ({ region, name: l.LoadBalancerName, type: l.Type, scheme: l.Scheme, dns: l.DNSName, state: l.State?.Code || null, createTime: iso(l.CreatedTime) })),
        ...clbs.map((l) => ({ region, name: l.LoadBalancerName, type: 'classic', scheme: l.Scheme, dns: l.DNSName, state: null, createTime: iso(l.CreatedTime), instances: (l.Instances || []).length })),
      ],
      lambda: functions.map((f) => ({ region, name: f.FunctionName, runtime: f.Runtime || f.PackageType, memoryMB: f.MemorySize, lastModified: f.LastModified })),
      dynamodb: tables.map((name) => ({ region, name })),
    };
    if (heavy) {
      const types = [...new Set(instances.map((i) => i.type))].filter((t) => !slow.types[t]);
      for (let i = 0; i < types.length; i += 100) {
        const r = await guard('ec2:DescribeInstanceTypes', async () => (await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: types.slice(i, i + 100) }))).InstanceTypes, []);
        for (const t of r) slow.types[t.InstanceType] = { vcpus: t.VCpuInfo?.DefaultVCpus || null, memoryMiB: t.MemoryInfo?.SizeInMiB || null };
      }
      // A failed listing keeps this region's previous figures (undefined), unlike "none" (null).
      const snaps = await guard('ec2:DescribeSnapshots', () => all(paginateDescribeSnapshots({ client: ec2 }, { OwnerIds: ['self'] }), (p) => p.Snapshots), null);
      out.snapshots = snaps === null ? slow.snapshots.find((x) => x.region === region) : snaps.length ? { region, count: snaps.length, sizeGiB: snaps.reduce((a, s) => a + (s.VolumeSize || 0), 0), oldest: iso(snaps.reduce((m, s) => (!m || s.StartTime < m ? s.StartTime : m), null)) } : null;
      const repos = await guard('ecr:DescribeRepositories', () => all(paginateDescribeRepositories({ client: clients.ecr(region) }, {}), (p) => p.repositories), null);
      if (!repos) out.ecr = slow.ecr.filter((x) => x.region === region);
      else {
        out.ecr = [];
        for (const repo of repos) {
          const images = await guard('ecr:DescribeImages', () => all(paginateDescribeImages({ client: clients.ecr(region) }, { repositoryName: repo.repositoryName, maxResults: 1000 }), (p) => p.imageDetails), null);
          const prev = slow.ecr.find((x) => x.region === region && x.name === repo.repositoryName);
          if (!images) { if (prev) out.ecr.push(prev); continue; }
          out.ecr.push({ region, name: repo.repositoryName, images: images.length, bytes: images.reduce((a, i) => a + (i.imageSizeInBytes || 0), 0),
            lastPush: iso(images.reduce((m, i) => (!m || i.imagePushedAt > m ? i.imagePushedAt : m), null)), untagged: images.filter((i) => !i.imageTags?.length).length, createdAt: iso(repo.createdAt) });
        }
      }
    }
    return out;
  }

  async function costs(errors) {
    const now = clock();
    const start = new Date(now); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 1);
    const end = day(now);
    try {
      const results = [];
      let token;
      do {
        const r = await clients.ce().send(new GetCostAndUsageCommand({ TimePeriod: { Start: day(start.getTime()), End: end }, Granularity: 'DAILY', Metrics: ['UnblendedCost'], GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }], NextPageToken: token }));
        results.push(...(r.ResultsByTime || []));
        token = r.NextPageToken;
      } while (token);
      const month = end.slice(0, 7), prev = day(start.getTime()).slice(0, 7);
      const byService = {}, daily = {}, lastMonth = { total: 0 };
      for (const d of results) {
        const date = d.TimePeriod.Start;
        for (const g of d.Groups || []) {
          const amount = Number(g.Metrics?.UnblendedCost?.Amount || 0);
          if (date.startsWith(month)) byService[g.Keys[0]] = (byService[g.Keys[0]] || 0) + amount;
          if (date.startsWith(prev)) lastMonth.total += amount;
          daily[date] = (daily[date] || 0) + amount;
        }
      }
      // Month to date runs through yesterday; forecast today to the month's end,
      // day by day (a MONTHLY forecast reports the whole month).
      let forecast = null;
      const monthEnd = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1));
      try {
        const f = await clients.ce().send(new GetCostForecastCommand({ TimePeriod: { Start: end, End: day(monthEnd.getTime()) }, Metric: 'UNBLENDED_COST', Granularity: 'DAILY' }));
        forecast = (f.ForecastResultsByTime || []).reduce((a, r) => a + Number(r.MeanValue || 0), 0);
      } catch (e) { errors.push({ region: 'global', scope: 'ce:GetCostForecast', error: String(e.message).slice(0, 200) }); }
      const mtd = Object.values(byService).reduce((a, b) => a + b, 0);
      return {
        at: new Date(now).toISOString(), currency: 'USD', month, monthToDate: mtd, monthEndEstimate: forecast != null ? mtd + forecast : null, lastMonth: lastMonth.total,
        byService: Object.entries(byService).map(([service, amount]) => ({ service, amount })).filter((s) => s.amount >= 0.01).sort((a, b) => b.amount - a.amount),
        daily: Object.entries(daily).map(([date, amount]) => ({ day: date, amount })).sort((a, b) => a.day.localeCompare(b.day)).slice(-31),
      };
    } catch (e) {
      errors.push({ region: 'global', scope: 'ce:GetCostAndUsage', error: String(e.message).slice(0, 200) });
      return inv?.costs || null;
    }
  }

  async function collect() {
    if (running) return inv;
    running = true;
    const t0 = clock();
    try {
      const errors = [];
      const heavy = t0 - slow.at > 6 * HOUR;
      let regions;
      try {
        regions = ((await clients.ec2(home).send(new DescribeRegionsCommand({}))).Regions || []).map((r) => r.RegionName).sort();
      } catch (e) {
        errors.push({ region: home, scope: 'ec2:DescribeRegions', error: String(e.message).slice(0, 200) });
        regions = [home];
      }
      const scans = [];
      for (let i = 0; i < regions.length; i += 6) scans.push(...(await Promise.all(regions.slice(i, i + 6).map((r) => regionScan(r, errors, heavy)))));
      if (heavy) {
        slow.at = t0;
        slow.ecr = scans.flatMap((s) => s.ecr || []);
        slow.snapshots = scans.map((s) => s.snapshots).filter(Boolean);
      }
      const global = async (scope, fn, fallback) => { try { return await fn(); } catch (e) { errors.push({ region: 'global', scope, error: String(e.message).slice(0, 200) }); return fallback; } };
      const cloudfront = await global('cloudfront:ListDistributions', () => all(paginateListDistributions({ client: clients.cloudfront() }, {}), (p) => p.DistributionList?.Items), inv?.cloudfront || []);
      const buckets = await global('s3:ListAllMyBuckets', async () => (await clients.s3().send(new ListBucketsCommand({}))).Buckets || [], null);
      let costData = inv?.costs || null;
      if (t0 - costsAt > 12 * HOUR) { costsAt = t0; costData = await costs(errors); }
      const pick = (k) => scans.flatMap((s) => s[k] || []);
      const instances = pick('instances').map((i) => ({ ...i, ...(slow.types[i.type] || {}) }));
      inv = {
        at: new Date(clock()).toISOString(), tookMs: clock() - t0, regions, errors,
        instances, volumes: pick('volumes'), addresses: pick('addresses'), natGateways: pick('natGateways'), loadBalancers: pick('loadBalancers'),
        lambda: pick('lambda'), dynamodb: pick('dynamodb'), ecr: slow.ecr, snapshots: slow.snapshots, instanceTypes: slow.types,
        cloudfront: cloudfront.map((d) => (d.Id ? { id: d.Id, domain: d.DomainName, aliases: d.Aliases?.Items || [], status: d.Status, enabled: d.Enabled, priceClass: d.PriceClass, comment: String(d.Comment || '').slice(0, 120) } : d)),
        s3: buckets ? buckets.map((b) => ({ name: b.Name, created: iso(b.CreationDate) })) : inv?.s3 || [],
        costs: costData,
      };
      writeAtomic(path, JSON.stringify(inv));
      log(`aws inventory: ${regions.length} regions, ${instances.length} instances, ${errors.length} errors, ${Math.round((clock() - t0) / 1000)}s`);
      return inv;
    } finally { running = false; }
  }
  return { collect, get: () => inv };
}

