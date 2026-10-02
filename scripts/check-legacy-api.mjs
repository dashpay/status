// Check the original public API contract without printing node data or credentials.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function checkLegacyAPI(origin, { expectedNodes, token, events = true, consoleEnabled = true } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const json = async (path, status = 200) => {
    const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, status, `${path}: unexpected status`);
    assert.match(response.headers.get('content-type') || '', /^application\/json/);
    return response.json();
  };
  const nodes = await json('/api/nodes');
  assert.ok(Array.isArray(nodes) && nodes.length > 0, 'Original node array required');
  if (expectedNodes !== undefined) assert.equal(nodes.length, expectedNodes, 'Node coverage changed');
  assert.equal(new Set(nodes.map((node) => node.name)).size, nodes.length);
  for (const node of nodes) {
    for (const key of ['name', 'num', 'type', 'host', 'publicIp', 'privateIp', 'protx', 'status', 'health', 'error', 'lastUpdated', 'proposerRole']) {
      assert.ok(Object.hasOwn(node, key), `Original node field missing: ${key}`);
    }
  }
  const detail = await json('/api/nodes/' + encodeURIComponent(nodes[0].name));
  assert.equal(detail.name, nodes[0].name);
  assert.equal(detail.host, nodes[0].host);
  assert.deepEqual(await json('/api/nodes/not-a-node', 400), { error: 'Invalid node name' });
  assert.deepEqual(await json('/api/nodes/masternode-99999999', 404), { error: 'Node not found' });
  assert.equal(typeof (await json('/api/config')).networkName, 'string');
  const proposer = await json('/api/proposer');
  for (const key of ['currentProposer', 'nextProposer', 'currentProposerNode', 'nextProposerNode', 'platformHeight', 'updatedAt']) {
    assert.ok(Object.hasOwn(proposer, key), `Proposer field missing: ${key}`);
  }
  const health = await json('/api/health');
  assert.equal(health.totalNodes, nodes.length);
  let total = 0;
  for (const key of ['healthy', 'syncing', 'error', 'banned', 'warning', 'unreachable', 'unknown']) {
    assert.ok(Number.isInteger(health[key]), `Health count missing: ${key}`);
    total += health[key];
  }
  assert.equal(total, nodes.length);
  assert.ok(Number.isInteger(health.sseClients));
  if (consoleEnabled) {
    const overview = await json('/api/overview');
    assert.ok(overview.networks.some((network) => network.name === 'testnet'));
    assert.ok(overview.networks.some((network) => network.name === 'mainnet'));
    assert.ok(!overview.networks.some((network) => network.name === 'devnet-moutai'), 'Retired Moutai must not return in the default overview');
    assert.equal((await json('/api/session')).user, null);
    const response = await fetch(origin + '/api/networks/testnet/ops', { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 401, 'Operator authorization must remain intact');
  }
  if (events) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(origin + '/api/events', { headers, signal: controller.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /^text\/event-stream/);
      const reader = response.body.getReader();
      let pending = '', found = false;
      const decoder = new TextDecoder();
      while (!found) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'SSE stream closed before an update');
        pending += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const message = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          if (!message.includes('event: nodeUpdate\n')) continue;
          const data = JSON.parse(message.split('\n').find((line) => line.startsWith('data: ')).slice(6));
          assert.ok(nodes.some((node) => node.name === data.name), 'SSE node outside original inventory');
          assert.ok(Object.hasOwn(data, 'health'));
          found = true;
        }
      }
      await reader.cancel();
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return { nodes: nodes.length, originalJSONRoutes: 'passed', eventStream: events ? 'passed' : 'not-checked', consoleRoutes: consoleEnabled ? 'passed' : 'not-checked' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2], 'Usage: node scripts/check-legacy-api.mjs ORIGIN [EXPECTED_NODES]');
  console.log(JSON.stringify(await checkLegacyAPI(process.argv[2], {
    expectedNodes: process.argv[3] ? Number(process.argv[3]) : undefined,
    token: process.env.STATUS_API_TOKEN,
  })));
}
