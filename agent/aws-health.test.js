import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAwsHealth } from './aws-health.js';
import { writeAtomic, readJSON } from '../shared/settings.js';

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
