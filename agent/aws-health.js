// Runtime health is distinct from inventory. Read-only and independently fresh.
import { EC2Client, DescribeInstanceStatusCommand } from '@aws-sdk/client-ec2';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { ApplicationAutoScalingClient, DescribeScalingPoliciesCommand } from '@aws-sdk/client-application-auto-scaling';
import { join } from 'node:path';
import { readJSON, writeAtomic } from '../shared/settings.js';
import { dynamoScaleInControl } from '../shared/aws-alarm-semantics.js';

export function createAwsHealth({ dataDir, clock = Date.now, ec2 = (region) => new EC2Client({ region }), cloudwatch = (region) => new CloudWatchClient({ region }),
  autoScaling = (region) => new ApplicationAutoScalingClient({ region }), log = () => {} }) {
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
            const alarm = (a, type) => ({ region, type, name: a.AlarmName, arn: a.AlarmArn, state: a.StateValue,
              updatedAt: a.StateUpdatedTimestamp?.toISOString(), configurationUpdatedAt: a.AlarmConfigurationUpdatedTimestamp?.toISOString(),
              namespace: a.Namespace, metricName: a.MetricName, dimensions: a.Dimensions,
              comparisonOperator: a.ComparisonOperator, threshold: a.Threshold, statistic: a.Statistic,
              extendedStatistic: a.ExtendedStatistic, period: a.Period, evaluationPeriods: a.EvaluationPeriods,
              datapointsToAlarm: a.DatapointsToAlarm, treatMissingData: a.TreatMissingData,
              alarmActions: a.AlarmActions, actionsEnabled: a.ActionsEnabled, metrics: a.Metrics, alarmRule: a.AlarmRule });
            complete.push(...(r.MetricAlarms || []).map((a) => alarm(a, 'MetricAlarm')), ...(r.CompositeAlarms || []).map((a) => alarm(a, 'CompositeAlarm')));
            token = r.NextToken;
          } while (token);
          result.alarms.push(...complete);
        });
        const candidates = result.alarms.filter((a) => a.region === region && a.namespace === 'AWS/DynamoDB'
          && a.comparisonOperator === 'LessThanThreshold' && ['ConsumedReadCapacityUnits', 'ConsumedWriteCapacityUnits'].includes(a.metricName));
        if (candidates.length) await gather('application-autoscaling:DescribeScalingPolicies', async () => {
          const client = autoScaling(region), policies = []; let token;
          do {
            const r = await client.send(new DescribeScalingPoliciesCommand({ ServiceNamespace: 'dynamodb', NextToken: token, MaxResults: 50 }), { abortSignal: AbortSignal.timeout(20_000) });
            policies.push(...(r.ScalingPolicies || [])); token = r.NextToken;
          } while (token);
          // Publish no association from incomplete pagination or failed reads.
          for (const a of candidates) {
            const matches = policies.filter((p) => dynamoScaleInControl(a, p));
            if (matches.length === 1) {
              const p = matches[0];
              a.scalingControl = { ...dynamoScaleInControl(a, p), policy: { PolicyARN: p.PolicyARN, PolicyType: p.PolicyType,
                ServiceNamespace: p.ServiceNamespace, ResourceId: p.ResourceId, ScalableDimension: p.ScalableDimension,
                Alarms: p.Alarms, TargetTrackingScalingPolicyConfiguration: p.TargetTrackingScalingPolicyConfiguration } };
            }
          }
        });
      }));
      result.at = new Date(clock()).toISOString();
      for (const a of result.alarms) if (a.scalingControl) a.scalingControl.verifiedAt = result.at;
      writeAtomic(join(dataDir, 'aws', 'health.json'), JSON.stringify(result), 0o600);
      log(`aws health: ${result.instances.length} instances, ${result.alarms.length} alarms, ${result.errors.length} collection errors`);
    } finally { running = false; }
  }
  return { tick };
}
