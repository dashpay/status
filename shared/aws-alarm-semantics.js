// Deliberately narrow: a low consumed-capacity alarm is a control signal only
// when the independently fetched target-tracking policy owns that exact alarm.
// Names/descriptions and old transition timestamps are not classification proof.
export function dynamoScaleInControl(alarm, policy) {
  if (alarm?.type !== 'MetricAlarm' || alarm.namespace !== 'AWS/DynamoDB'
    || alarm.comparisonOperator !== 'LessThanThreshold' || alarm.statistic !== 'Sum'
    || alarm.period !== 60 || !Number.isSafeInteger(alarm.evaluationPeriods) || alarm.evaluationPeriods < 1
    || !Number.isFinite(alarm.threshold) || alarm.threshold <= 0
    || alarm.metrics?.length || alarm.extendedStatistic || alarm.alarmRule
    || (alarm.treatMissingData && !['missing', 'ignore'].includes(alarm.treatMissingData))) return null;
  const direction = { ConsumedReadCapacityUnits: 'Read', ConsumedWriteCapacityUnits: 'Write' }[alarm.metricName];
  const dimensions = alarm.dimensions;
  if (!direction || !Array.isArray(dimensions) || dimensions.length !== 1
    || dimensions[0]?.Name !== 'TableName' || !/^[A-Za-z0-9_.-]{3,255}$/.test(dimensions[0].Value)) return null;
  const resourceId = `table/${dimensions[0].Value}`;
  const arn = /^arn:([^:]+):cloudwatch:([^:]+):(\d{12}):alarm:(.+)$/.exec(alarm.arn || '');
  const policyArn = /^arn:([^:]+):autoscaling:([^:]+):(\d{12}):scalingPolicy:([^:]+):resource\/dynamodb\/(.+):policyName\/(.+)$/.exec(policy?.PolicyARN || '');
  if (!arn || arn[2] !== alarm.region || arn[4] !== alarm.name || !policyArn
    || policyArn[1] !== arn[1] || policyArn[2] !== arn[2] || policyArn[3] !== arn[3] || policyArn[5] !== resourceId
    || policy.ServiceNamespace !== 'dynamodb' || policy.ResourceId !== resourceId
    || policy.PolicyType !== 'TargetTrackingScaling' || policy.ScalableDimension !== `dynamodb:table:${direction}CapacityUnits`
    || !Array.isArray(policy.Alarms) || !policy.Alarms.some((a) => a?.AlarmARN === alarm.arn && a.AlarmName === alarm.name)) return null;
  const config = policy.TargetTrackingScalingPolicyConfiguration;
  if (!config || config.DisableScaleIn === true || config.CustomizedMetricSpecification
    || config.PredefinedMetricSpecification?.PredefinedMetricType !== `DynamoDB${direction}CapacityUtilization`
    || !Number.isFinite(config.TargetValue) || config.TargetValue <= 0 || config.TargetValue > 100) return null;
  // DynamoDB generated actions may append an exact createdBy UUID to the
  // policy ARN. Accept only that documented shape, never arbitrary prefixes.
  const matchesPolicy = (action) => action === policy.PolicyARN || (typeof action === 'string'
    && action.startsWith(`${policy.PolicyARN}:createdBy/`)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(action.slice(policy.PolicyARN.length + 11)));
  if (!Array.isArray(alarm.alarmActions) || alarm.alarmActions.length !== 1 || !matchesPolicy(alarm.alarmActions[0])) return null;
  return { kind: 'dynamodb_target_tracking_scale_in', resourceId, policyArn: policy.PolicyARN,
    scalableDimension: policy.ScalableDimension, targetValue: config.TargetValue };
}
