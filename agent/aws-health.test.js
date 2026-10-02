import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAwsHealth } from './aws-health.js';
import { writeAtomic, readJSON } from '../shared/settings.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
import { deriveIssues, reconcile } from '../server/incidents.js';

const fixture = JSON.parse(readFileSync(new URL('../shared/fixtures/dynamodb-scale-in.json', import.meta.url)));
const now = Date.parse('2026-10-02T18:00:00Z');
async function collect(t, { alarms = fixture.alarms, policies = fixture.policies, autoScaling, cloudwatch } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aws-health-semantics-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeAtomic(join(dataDir, 'aws', 'inventory.json'), JSON.stringify({ regions: [fixture.region] }));
  await createAwsHealth({ dataDir, clock: () => now, ec2: () => ({ send: async () => ({ InstanceStatuses: [] }) }),
    cloudwatch: cloudwatch || (() => ({ send: async () => ({ MetricAlarms: alarms.map((a) => ({ ...a,
      StateUpdatedTimestamp: new Date(a.StateUpdatedTimestamp), AlarmConfigurationUpdatedTimestamp: new Date(a.AlarmConfigurationUpdatedTimestamp) })) }) })),
    autoScaling: autoScaling || (() => ({ send: async (cmd) => {
      assert.equal(cmd.input.ServiceNamespace, 'dynamodb');
      return { ScalingPolicies: policies };
    } })) }).tick();
  return readJSON(join(dataDir, 'aws', 'health.json'));
}
const derive = (health, time = now) => deriveIssues({ settings: { ...DEFAULT_SETTINGS, networks: [] }, states: {}, now: time,
  aws: { at: new Date(time).toISOString(), errors: [], volumes: [], addresses: [], health } });

test('runtime health paginates and does not publish partial pages as complete', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aws-health-'));
  writeAtomic(join(dataDir, 'aws', 'inventory.json'), JSON.stringify({ regions: ['r1', 'r2'] }));
  const ec2 = (region) => ({ send: async (cmd) => {
    if (!cmd.input.NextToken) return { InstanceStatuses: [{ InstanceId: `${region}-1`, SystemStatus: { Status: 'impaired' } }], NextToken: 'page2' };
    if (region === 'r2') throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
    return { InstanceStatuses: [{ InstanceId: 'r1-2', SystemStatus: { Status: 'ok' } }] };
  } });
  const cloudwatch = () => ({ send: async () => ({ MetricAlarms: [{ AlarmName: 'alarm', StateValue: 'ALARM' }] }) });
  const c = createAwsHealth({ dataDir, ec2, cloudwatch }); await c.tick();
  const h = readJSON(join(dataDir, 'aws', 'health.json'));
  assert.deepEqual(h.instances.map((i) => i.id), ['r1-1', 'r1-2']);
  assert.deepEqual(h.errors, [{ region: 'r2', scope: 'ec2:DescribeInstanceStatus', error: 'AccessDenied' }]);
  assert.equal(h.alarms.length, 2);
});

test('exact read/write alarms replay as verified informational controls and positively clear historical misclassification', async (t) => {
  const health = await collect(t);
  assert.equal(health.alarms.length, 2);
  assert.equal(health.errors.length, 0);
  for (const alarm of health.alarms) {
    assert.equal(alarm.state, 'ALARM');
    assert.equal(alarm.scalingControl.verifiedAt, health.at);
    assert.equal(alarm.scalingControl.resourceId, 'table/terraform_locks');
    assert.equal(alarm.comparisonOperator, 'LessThanThreshold');
    assert.equal(alarm.threshold, 30);
    assert.equal(alarm.evaluationPeriods, 15);
    assert.ok(alarm.updatedAt.startsWith('2023-04-27')); // state transition age is not collection age
  }
  const oldHealth = { ...health, at: new Date(now - 60_000).toISOString(), alarms: health.alarms.map(({ region, name, state }) => ({ region, name, state })) };
  const prior = reconcile(null, derive(oldHealth, now - 60_000), now - 60_000);
  assert.equal(prior.issues.filter((i) => i.code === 'aws_alarm').length, 2);
  const current = derive(health);
  assert.equal(current.issues.filter((i) => i.code === 'aws_alarm').length, 0);
  assert.equal(current.issues.filter((i) => i.code === 'aws_scaling_control' && i.severity === 'info').length, 2);
  const next = reconcile(prior, current, now);
  for (const issue of next.issues.filter((i) => i.code === 'aws_alarm')) {
    assert.equal(issue.status, 'resolved');
    assert.equal(issue.resolutionEvidence.reason, 'verified_control_signal');
    assert.equal(issue.resolutionEvidence.state, 'ALARM');
    assert.match(issue.resolutionEvidence.explanation, /not evidence of table recovery/);
    assert.ok(next.outbox.some((e) => e.issue.id === issue.id && e.transition === 'resolved' && e.issue.resolutionEvidence));
  }
});

test('policy pagination must finish; access denied and partial pages retain actionable alarms', async (t) => {
  for (const partial of [false, true]) {
    const health = await collect(t, { autoScaling: () => ({ send: async (cmd) => {
      if (partial && !cmd.input.NextToken) return { ScalingPolicies: fixture.policies, NextToken: 'page2' };
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    } }) });
    assert.equal(health.errors[0].scope, 'application-autoscaling:DescribeScalingPolicies');
    assert.ok(health.alarms.every((a) => !a.scalingControl));
    assert.equal(derive(health).issues.filter((i) => i.code === 'aws_alarm').length, 2);
    assert.ok(derive(health).issues.some((i) => i.code === 'aws_health_missing'));
  }
  const health = await collect(t, { autoScaling: () => ({ send: async (cmd) => cmd.input.NextToken
    ? { ScalingPolicies: fixture.policies.slice(1) } : { ScalingPolicies: fixture.policies.slice(0, 1), NextToken: 'page2' } }) });
  assert.ok(health.alarms.every((a) => a.scalingControl));
});

test('alarm-name resemblance, high/throttle/error metrics and mismatched policies never suppress actionable alarms', async (t) => {
  const cases = [
    ['high comparison', (a) => { a.ComparisonOperator = 'GreaterThanThreshold'; }],
    ['throttle', (a) => { a.MetricName = 'ReadThrottleEvents'; }],
    ['service error', (a) => { a.MetricName = 'SystemErrors'; }],
    ['namespace', (a) => { a.Namespace = 'Custom/DynamoDB'; }],
    ['wrong resource', (a) => { a.Dimensions[0].Value = 'another_table'; }],
    ['index dimension', (a) => { a.Dimensions.push({ Name: 'GlobalSecondaryIndexName', Value: 'idx' }); }],
    ['metric math', (a) => { a.Metrics = [{ Id: 'expr', Expression: 'm1' }]; }],
    ['missing treated as breaching', (a) => { a.TreatMissingData = 'breaching'; }],
    ['wrong statistic', (a) => { a.Statistic = 'Average'; }],
    ['unrelated action', (a) => { a.AlarmActions = ['arn:aws:sns:eu-west-1:854439639386:page']; }],
    ['extra action', (a) => { a.AlarmActions.push('arn:aws:sns:eu-west-1:854439639386:page'); }],
    ['policy action prefix spoof', (a) => { a.AlarmActions[0] += '-suffix'; }],
    ['no policy alarms', (_a, p) => { p.Alarms = []; }],
    ['unassociated alarm ARN', (a) => { a.AlarmArn += '-unbound'; }],
    ['cross account', (_a, p) => { p.PolicyARN = p.PolicyARN.replace('854439639386', '111111111111'); }],
    ['cross region', (_a, p) => { p.PolicyARN = p.PolicyARN.replace('eu-west-1', 'us-east-1'); }],
    ['policy resource', (_a, p) => { p.ResourceId = 'table/other'; }],
    ['policy type', (_a, p) => { p.PolicyType = 'StepScaling'; }],
    ['wrong capacity direction', (_a, p) => { p.ScalableDimension = 'dynamodb:table:ReadCapacityUnits'; }],
    ['custom target', (_a, p) => { p.TargetTrackingScalingPolicyConfiguration.CustomizedMetricSpecification = {}; }],
    ['wrong predefined target', (_a, p) => { p.TargetTrackingScalingPolicyConfiguration.PredefinedMetricSpecification.PredefinedMetricType = 'DynamoDBReadCapacityUtilization'; }],
    ['disabled scale in', (_a, p) => { p.TargetTrackingScalingPolicyConfiguration.DisableScaleIn = true; }],
  ];
  for (const [label, mutate] of cases) {
    const alarm = structuredClone(fixture.alarms[0]);
    const policy = structuredClone(fixture.policies.find((p) => p.ScalableDimension.endsWith('WriteCapacityUnits')));
    mutate(alarm, policy);
    const health = await collect(t, { alarms: [alarm], policies: [policy] });
    assert.equal(health.alarms[0].scalingControl, undefined, label);
    assert.equal(derive(health).issues.filter((i) => i.code === 'aws_alarm').length, 1, label);
  }
});

test('classification follows exact semantics and association, not an AlarmLow name pattern', async (t) => {
  const alarm = structuredClone(fixture.alarms[0]), policy = structuredClone(fixture.policies[1]);
  const previousArn = alarm.AlarmArn;
  alarm.AlarmName = 'capacity-control-without-low-in-name';
  alarm.AlarmArn = `arn:aws:cloudwatch:${fixture.region}:854439639386:alarm:${alarm.AlarmName}`;
  const association = policy.Alarms.find((a) => a.AlarmARN === previousArn);
  association.AlarmName = alarm.AlarmName; association.AlarmARN = alarm.AlarmArn;
  const health = await collect(t, { alarms: [alarm], policies: [policy] });
  assert.ok(health.alarms[0].scalingControl);
});

test('stale, missing, insufficient-data or incomplete evidence cannot clear historical alarms', async (t) => {
  const health = await collect(t);
  const oldHealth = { ...health, at: new Date(now - 60_000).toISOString(), alarms: health.alarms.map(({ region, name, state }) => ({ region, name, state })) };
  const prior = reconcile(null, derive(oldHealth, now - 60_000), now - 60_000);
  const cases = [
    { ...health, at: new Date(now - 11 * 60_000).toISOString() },
    { ...health, alarms: [] },
    { ...health, alarms: health.alarms.map((a) => ({ ...a, state: 'INSUFFICIENT_DATA' })) },
    { ...health, errors: [{ region: fixture.region, scope: 'cloudwatch:DescribeAlarms', error: 'AccessDenied' }] },
    { ...health, alarms: health.alarms.map((a) => ({ ...a, scalingControl: { ...a.scalingControl, verifiedAt: oldHealth.at } })) },
    { ...health, alarms: health.alarms.map((a) => ({ ...a, scalingControl: { kind: 'dynamodb_target_tracking_scale_in', verifiedAt: health.at } })) },
  ];
  for (const snapshot of cases) {
    const next = reconcile(prior, derive(snapshot), now);
    assert.ok(next.issues.filter((i) => i.code === 'aws_alarm').every((i) => i.status === 'open'));
  }
});
