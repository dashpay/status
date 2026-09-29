// The AWS inventory before sign-in: spend and breakdowns only. No resource
// names, ids, addresses, DNS names or tags beyond the Dash network, and no
// list of idle resources (that is for members).
const add = (map, key, fields) => {
  const e = map.get(key) || { label: key, count: 0, vcpus: 0, memoryGiB: 0 };
  e.count += 1; e.vcpus += fields.vcpus || 0; e.memoryGiB += (fields.memoryMiB || 0) / 1024;
  map.set(key, e);
};
const rows = (map) => [...map.values()].map((e) => ({ ...e, memoryGiB: Math.round(e.memoryGiB) })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

export function publicInventory(inv) {
  const running = inv.instances.filter((i) => i.state === 'running');
  const byNetwork = new Map(), byRegion = new Map(), byFamily = new Map(), byArch = new Map();
  for (const i of running) {
    add(byNetwork, i.tags?.DashNetwork || i.tags?.['dashnet:network'] || 'other', i);
    add(byRegion, i.region, i);
    add(byFamily, String(i.type || 'unknown').split('.')[0], i);
    add(byArch, i.arch === 'arm64' ? 'arm64 (Graviton)' : i.arch === 'x86_64' ? 'x86_64' : i.arch || 'unknown', i);
  }
  const ebsByType = new Map();
  for (const v of inv.volumes) ebsByType.set(v.type || 'unknown', (ebsByType.get(v.type || 'unknown') || 0) + (v.sizeGiB || 0));
  const lbByType = {};
  for (const l of inv.loadBalancers) lbByType[l.type] = (lbByType[l.type] || 0) + 1;
  const c = inv.costs;
  return {
    public: true, at: inv.at, regions: inv.regions.length,
    regionsInUse: new Set([...inv.instances, ...inv.volumes, ...inv.addresses, ...inv.loadBalancers, ...inv.natGateways].map((x) => x.region)).size,
    instances: { running: running.length, stopped: inv.instances.filter((i) => i.state === 'stopped').length,
      vcpus: running.reduce((a, i) => a + (i.vcpus || 0), 0), memoryGiB: Math.round(running.reduce((a, i) => a + (i.memoryMiB || 0), 0) / 1024) },
    byNetwork: rows(byNetwork), byRegion: rows(byRegion), byFamily: rows(byFamily), byArch: rows(byArch),
    storage: { volumes: inv.volumes.length, ebsGiB: inv.volumes.reduce((a, v) => a + (v.sizeGiB || 0), 0),
      ebsByType: [...ebsByType].map(([label, gib]) => ({ label, gib })).sort((a, b) => b.gib - a.gib),
      snapshotsGiB: inv.snapshots.reduce((a, s) => a + (s.sizeGiB || 0), 0), ecrBytes: inv.ecr.reduce((a, r) => a + (r.bytes || 0), 0),
      ecrImages: inv.ecr.reduce((a, r) => a + (r.images || 0), 0), s3Buckets: inv.s3.length },
    network: { loadBalancers: inv.loadBalancers.length, loadBalancersByType: lbByType, natGateways: inv.natGateways.length, elasticIps: inv.addresses.length, cloudfront: inv.cloudfront.length },
    serverless: { lambda: inv.lambda.length, dynamodb: inv.dynamodb.length },
    costs: c ? { at: c.at, month: c.month, currency: c.currency, monthToDate: c.monthToDate, monthEndEstimate: c.monthEndEstimate, lastMonth: c.lastMonth, byService: c.byService, daily: c.daily } : null,
  };
}
