// Runtime health is distinct from inventory. Read-only and independently fresh.
import { EC2Client, DescribeInstanceStatusCommand } from '@aws-sdk/client-ec2';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { join } from 'node:path';
import { readJSON, writeAtomic } from '../shared/settings.js';

export function createAwsHealth({ dataDir, clock = Date.now, ec2 = (region) => new EC2Client({ region }), cloudwatch = (region) => new CloudWatchClient({ region }), log = () => {} }) {
  let running = false, last = 0;
  async function tick() {
    if (running || clock() - last < 5 * 60_000) return;
    const inventory = readJSON(join(dataDir, 'aws', 'inventory.json'));
    if (!inventory?.regions?.length) return;
    running = true; last = clock();
    try {
      const result = { at: new Date(clock()).toISOString(), regions: inventory.regions, instances: [], alarms: [], errors: [] };
      for (let offset = 0; offset < inventory.regions.length; offset += 4) await Promise.all(inventory.regions.slice(offset, offset + 4).map(async (region) => {
        const gather = async (scope, fn) => { try { await fn(); } catch (e) { result.errors.push({ region, scope, error: e.name || 'collection failed' }); } };
        await gather('ec2:DescribeInstanceStatus', async () => {
          const client = ec2(region); let token;
          const complete = [];
          do {
            const r = await client.send(new DescribeInstanceStatusCommand({ IncludeAllInstances: true, NextToken: token, MaxResults: 100 }), { abortSignal: AbortSignal.timeout(20_000) });
            complete.push(...(r.InstanceStatuses || []).map((i) => ({ region, id: i.InstanceId, state: i.InstanceState?.Name, instanceStatus: i.InstanceStatus?.Status, systemStatus: i.SystemStatus?.Status, events: (i.Events || []).map((e) => ({ code: e.Code, notBefore: e.NotBefore?.toISOString() })) })));
            token = r.NextToken;
          } while (token);
          result.instances.push(...complete);
        });
        await gather('cloudwatch:DescribeAlarms', async () => {
          const client = cloudwatch(region); let token;
          const complete = [];
          do {
            const r = await client.send(new DescribeAlarmsCommand({ AlarmTypes: ['MetricAlarm', 'CompositeAlarm'], NextToken: token, MaxRecords: 100 }), { abortSignal: AbortSignal.timeout(20_000) });
            complete.push(...[...(r.MetricAlarms || []), ...(r.CompositeAlarms || [])].map((a) => ({ region, name: a.AlarmName, state: a.StateValue, updatedAt: a.StateUpdatedTimestamp?.toISOString() })));
            token = r.NextToken;
          } while (token);
          result.alarms.push(...complete);
        });
      }));
      result.at = new Date(clock()).toISOString();
      writeAtomic(join(dataDir, 'aws', 'health.json'), JSON.stringify(result), 0o600);
      log(`aws health: ${result.instances.length} instances, ${result.alarms.length} alarms, ${result.errors.length} collection errors`);
    } finally { running = false; }
  }
  return { tick };
}
