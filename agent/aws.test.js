import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ElasticLoadBalancingClient } from '@aws-sdk/client-elastic-load-balancing';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ECRClient } from '@aws-sdk/client-ecr';
import { S3Client } from '@aws-sdk/client-s3';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { createAwsInventory } from './aws.js';

const T0 = Date.parse('2026-09-29T12:00:00Z');

// Real client classes (paginators check instanceof) with a scripted send().
function fakeClients(calls) {
  const denied = Object.assign(new Error('not authorized to perform lambda:ListFunctions'), { name: 'AccessDeniedException' });
  const answers = {
    DescribeRegionsCommand: () => ({ Regions: [{ RegionName: 'us-west-2' }, { RegionName: 'eu-west-1' }] }),
    DescribeInstancesCommand: (r) => ({ Reservations: r === 'us-west-2' ? [{ Instances: [
      { InstanceId: 'i-1', InstanceType: 't4g.small', State: { Name: 'running' }, Placement: { AvailabilityZone: 'us-west-2c' }, PublicIpAddress: '68.67.122.65', Architecture: 'arm64', Tags: [{ Key: 'Name', Value: 'dn-testnet-masternode-36' }, { Key: 'DashNetwork', Value: 'testnet' }, { Key: 'secret-ish', Value: 'x' }], BlockDeviceMappings: [{ Ebs: { VolumeId: 'vol-1' } }] },
      { InstanceId: 'i-2', InstanceType: 't3.large', State: { Name: 'stopped' }, Tags: [] },
    ] }] : [] }),
    DescribeVolumesCommand: (r) => ({ Volumes: r === 'us-west-2' ? [{ VolumeId: 'vol-1', Size: 50, VolumeType: 'gp3', State: 'in-use', Attachments: [{ InstanceId: 'i-1' }] }, { VolumeId: 'vol-2', Size: 200, VolumeType: 'gp2', State: 'available', Attachments: [] }] : [] }),
    DescribeAddressesCommand: (r) => ({ Addresses: r === 'us-west-2' ? [{ PublicIp: '1.2.3.4', AllocationId: 'eipalloc-1', AssociationId: 'a', InstanceId: 'i-1' }, { PublicIp: '5.6.7.8', AllocationId: 'eipalloc-2' }] : [] }),
    DescribeNatGatewaysCommand: () => ({ NatGateways: [] }),
    DescribeLoadBalancersCommand: (r, input, client) => (client instanceof ElasticLoadBalancingClient ? { LoadBalancerDescriptions: [] } : { LoadBalancers: r === 'eu-west-1' ? [{ LoadBalancerName: 'alb', Type: 'application', Scheme: 'internet-facing', DNSName: 'alb.example', State: { Code: 'active' } }] : [] }),
    ListFunctionsCommand: (r) => { if (r === 'eu-west-1') throw denied; return { Functions: [] }; },
    ListTablesCommand: (r) => ({ TableNames: r === 'us-west-2' ? ['dashnet-managed-state'] : [] }),
    DescribeInstanceTypesCommand: (r, input) => ({ InstanceTypes: input.InstanceTypes.map((t) => ({ InstanceType: t, VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: t === 't3.large' ? 8192 : 2048 } })) }),
    DescribeSnapshotsCommand: (r) => ({ Snapshots: r === 'us-west-2' ? [{ VolumeSize: 100, StartTime: new Date('2025-01-01') }, { VolumeSize: 30, StartTime: new Date('2026-01-01') }] : [] }),
    DescribeRepositoriesCommand: (r) => ({ repositories: r === 'eu-west-1' ? [{ repositoryName: 'rs-dapi', createdAt: new Date('2025-06-01') }] : [] }),
    DescribeImagesCommand: (r, input) => (input.nextToken ? { imageDetails: [{ imageSizeInBytes: 3e9, imagePushedAt: new Date('2026-09-28') }] }
      : { imageDetails: [{ imageSizeInBytes: 5e9, imageTags: ['v1'], imagePushedAt: new Date('2026-09-01') }], nextToken: 'p2' }),
    ListDistributionsCommand: () => ({ DistributionList: { Items: [{ Id: 'E2C5OWJNZP3AJD', DomainName: 'd8kptsz5luhgd.cloudfront.net', Aliases: { Items: ['quorums.testnet.networks.dash.org'] }, Status: 'Deployed', Enabled: true }] } }),
    ListBucketsCommand: () => ({ Buckets: [{ Name: 'b1', CreationDate: new Date('2024-01-01') }] }),
    GetCostAndUsageCommand: () => ({ ResultsByTime: [
      { TimePeriod: { Start: '2026-08-31' }, Groups: [{ Keys: ['Amazon Elastic Compute Cloud - Compute'], Metrics: { UnblendedCost: { Amount: '90' } } }] },
      { TimePeriod: { Start: '2026-09-27' }, Groups: [{ Keys: ['Amazon Elastic Compute Cloud - Compute'], Metrics: { UnblendedCost: { Amount: '30' } } }, { Keys: ['Amazon EC2 Container Registry (ECR)'], Metrics: { UnblendedCost: { Amount: '8' } } }] },
      { TimePeriod: { Start: '2026-09-28' }, Groups: [{ Keys: ['Amazon Elastic Compute Cloud - Compute'], Metrics: { UnblendedCost: { Amount: '31' } } }, { Keys: ['Tax'], Metrics: { UnblendedCost: { Amount: '0.001' } } }] },
    ] }),
    GetCostForecastCommand: () => ({ ForecastResultsByTime: [{ MeanValue: '35' }, { MeanValue: '36' }] }),
  };
  const make = (Kind, region) => {
    const c = new Kind({ region, credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
    c.send = async (cmd) => { calls.push([cmd.constructor.name, region]); return answers[cmd.constructor.name](region, cmd.input, c); };
    return c;
  };
  const cache = new Map();
  const get = (Kind, region) => { const k = `${Kind.name}:${region}`; if (!cache.has(k)) cache.set(k, make(Kind, region)); return cache.get(k); };
  return {
    ec2: (r) => get(EC2Client, r), alb: (r) => get(ElasticLoadBalancingV2Client, r), clb: (r) => get(ElasticLoadBalancingClient, r),
    lambda: (r) => get(LambdaClient, r), dynamodb: (r) => get(DynamoDBClient, r), ecr: (r) => get(ECRClient, r),
    cloudfront: () => get(CloudFrontClient, 'us-east-1'), s3: () => get(S3Client, 'us-east-1'), ce: () => get(CostExplorerClient, 'us-east-1'),
  };
}

test('AWS inventory: every enabled region, waste signals, ECR sizes, costs; denied services are reported, not fatal', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aws-'));
  const calls = [];
  let now = T0;
  const aws = createAwsInventory({ dataDir, clients: fakeClients(calls), clock: () => now });
  const inv = await aws.collect();
  assert.deepEqual(inv.regions, ['eu-west-1', 'us-west-2']);
  assert.equal(inv.instances.length, 2);
  const mn = inv.instances.find((i) => i.id === 'i-1');
  assert.deepEqual(mn.tags, { Name: 'dn-testnet-masternode-36', DashNetwork: 'testnet' });
  assert.equal(mn.vcpus, 2);
  assert.equal(mn.memoryMiB, 2048);
  assert.deepEqual(inv.volumes.filter((v) => !v.attachedTo).map((v) => v.id), ['vol-2']);
  assert.deepEqual(inv.addresses.filter((a) => !a.associated).map((a) => a.publicIp), ['5.6.7.8']);
  assert.equal(inv.loadBalancers[0].name, 'alb');
  assert.deepEqual(inv.ecr, [{ region: 'eu-west-1', name: 'rs-dapi', images: 2, bytes: 8e9, lastPush: '2026-09-28T00:00:00.000Z', untagged: 1, createdAt: '2025-06-01T00:00:00.000Z' }]);
  assert.deepEqual(inv.snapshots, [{ region: 'us-west-2', count: 2, sizeGiB: 130, oldest: '2025-01-01T00:00:00.000Z' }]);
  assert.equal(inv.cloudfront[0].aliases[0], 'quorums.testnet.networks.dash.org');
  assert.equal(inv.errors.length, 1);
  assert.match(inv.errors[0].scope, /lambda:ListFunctions/);
  assert.equal(inv.errors[0].region, 'eu-west-1');
  assert.equal(inv.costs.monthToDate, 69.001);
  assert.equal(inv.costs.lastMonth, 90);
  assert.equal(inv.costs.monthEndEstimate, 69.001 + 71);
  assert.deepEqual(inv.costs.byService.map((s) => s.service), ['Amazon Elastic Compute Cloud - Compute', 'Amazon EC2 Container Registry (ECR)']);
  assert.ok(JSON.parse(readFileSync(join(dataDir, 'aws', 'inventory.json'), 'utf8')).at);

  // Ten minutes later: resources again; ECR, snapshots and Cost Explorer are not re-read.
  now += 10 * 60_000;
  const before = calls.length;
  const again = await aws.collect();
  const second = calls.slice(before).map((c) => c[0]);
  assert.ok(second.includes('DescribeInstancesCommand'));
  for (const slow of ['DescribeImagesCommand', 'DescribeSnapshotsCommand', 'GetCostAndUsageCommand', 'GetCostForecastCommand']) assert.ok(!second.includes(slow), slow);
  assert.equal(again.ecr[0].bytes, 8e9);
  assert.equal(again.costs.monthToDate, 69.001);
});

test('AWS inventory keeps a region\'s previous ECR and snapshot figures when their listing fails', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aws-'));
  let now = T0;
  const clients = fakeClients([]);
  const aws = createAwsInventory({ dataDir, clients, clock: () => now });
  await aws.collect();
  const fail = (c) => { const send = c.send; c.send = async (cmd) => { if (/Snapshots|Images/.test(cmd.constructor.name)) throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' }); return send(cmd); }; };
  fail(clients.ec2('us-west-2')); fail(clients.ecr('eu-west-1'));
  now += 7 * 3_600_000; // the next 6-hourly pass
  const inv = await aws.collect();
  assert.deepEqual(inv.snapshots.map((x) => [x.region, x.count]), [['us-west-2', 2]]);
  assert.deepEqual(inv.ecr.map((x) => [x.name, x.bytes]), [['rs-dapi', 8e9]]);
  assert.ok(inv.errors.some((e) => /DescribeSnapshots/.test(e.scope)) && inv.errors.some((e) => /DescribeImages/.test(e.scope)));
});
