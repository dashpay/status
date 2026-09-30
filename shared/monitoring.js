// Only observed evidence is green. Missing, idle or protected sources stay
// explicitly unknown; none of these probes sends a payment or changes a node.
const sameImage = (container, reference) => {
  if (typeof reference !== 'string') return false;
  const digest = reference.split('@')[1];
  return digest ? container.digest === digest || container.image?.endsWith('@' + digest) : container.image?.replace(/^(index\.)?docker\.io\//, '') === reference.replace(/^(index\.)?docker\.io\//, '');
};
export function expectations(operations = [], now = Date.now()) {
  const targets = {};
  for (const op of [...operations].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    if (!op.confirmedAt || !op.progress || !['running', 'succeeded', 'failed', 'interrupted', 'cancelled'].includes(op.status)) continue;
    const active = op.status === 'running' && now - Date.parse(op.updatedAt) < 15 * 60_000;
    for (const c of [...(op.review?.changes || []), ...(op.artifacts?.phases || []).flatMap((p) => p.changes || [])]) {
      if (typeof c.to !== 'string' || !c.node || !c.component) continue;
      targets[c.node] ??= {};
      targets[c.node][c.component] = { to: c.to, from: c.from, active, since: op.finishedAt || op.confirmedAt };
    }
  }
  return targets;
}
export function convergence(host, data, network, expected, componentOf) {
  const pins = expected[host.name] || {};
  const checks = [];
  for (const c of (data.containers || []).filter((v) => v.running)) {
    const component = componentOf[c.repo];
    if (!component) continue;
    const pin = pins[component];
    const target = pin?.to || network.images?.[component];
    if (!target) { checks.push({ component, status: 'unknown' }); continue; }
    const status = sameImage(c, target) ? 'matched' : pin && Date.parse(host.probe?.at) < Date.parse(pin.since) ? 'awaiting-sample'
      : pin?.active && (!pin.from || sameImage(c, pin.from)) ? 'rolling' : 'drift';
    checks.push({ component, status, expected: target });
  }
  for (const [component, pin] of Object.entries(pins)) if (!checks.some((c) => c.component === component)) checks.push({ component, status: !host.probe?.ok ? 'unknown' : pin.active ? 'rolling' : 'missing', expected: pin.to });
  return checks;
}
const count = (values) => ({ observed: values.filter((v) => v != null).length, total: values.length, failed: values.filter((v) => v === false).length });
export function monitoringSummary(rows, endpoints, now = Date.now()) {
  const current = rows.filter((r) => r.host.state === 'running' && !r.host.duplicate);
  const cores = current.filter((r) => r.data.core);
  const validators = current.filter((r) => r.host.role === 'validator');
  const payouts = current.flatMap((r) => [...(r.data.faucet?.payouts || []), ...(r.data.core?.payouts || [])]).filter((p) => p.time && now / 1000 - p.time < 86400 && p.time <= now / 1000 + 60);
  const dkg = cores.flatMap((r) => r.data.core.dkg || []);
  const services = current.flatMap((r) => r.data.services || []);
  const min = (vs) => vs.filter(Number.isFinite).length ? Math.min(...vs.filter(Number.isFinite)) : null;
  const max = (vs) => vs.filter(Number.isFinite).length ? Math.max(...vs.filter(Number.isFinite)) : null;
  const checks = current.flatMap((r) => r.convergence || []);
  const seeds = endpoints.filter((e) => e.kind === 'dapi');
  const seedHeights = seeds.filter((e) => e.ok && Number.isFinite(e.height)).map((e) => e.height);
  return {
    quorum: { locks: count(current.filter((r) => ['validator','masternode','seed','fullnode','web','wallet','miner','mixer'].includes(r.host.role)).map((r) => r.data.core?.chainLockHeight > 0 ? true : null)), dkgSessions: dkg.length, dkgAborted: dkg.filter((d) => d.aborted).length,
      quorumTypes: [...new Set(cores.flatMap((r) => Object.keys(r.data.core.quorums || {})))], recentInstantLocks: payouts.filter((p) => p.instantlock === true).length, observedPayouts: payouts.length },
    wallets: { rpcMaxMs: max(cores.filter((r) => r.host.role === 'wallet').map((r) => r.data.core.rpcLatencyMs)), recentPayouts: payouts.length,
      confirmed: payouts.filter((p) => p.confirmations > 0 || p.chainlock === true).length, abandoned: payouts.filter((p) => p.abandoned).length,
      queues: current.filter((r) => r.data.faucet?.queue).map((r) => ({ host: r.host.name, kind: r.data.faucet.kind, ...r.data.faucet.queue })),
      publicFaucets: endpoints.filter((e) => e.kind === 'faucet').map((e) => ({ label: e.label, ok: e.ok, state: e.state, height: e.height })) },
    explorers: { queries: count(current.filter((r) => r.host.role === 'web' || r.data.insight).map((r) => r.data.insight?.query?.ok ?? null)) },
    dapi: { queries: count(validators.map((r) => r.data.dapi?.query?.ok ?? null)), maxMs: max(validators.map((r) => r.data.dapi?.query?.latencyMs)),
      seeds: count(seeds.map((e) => e.ok)), seedHeightSpread: seedHeights.length === seeds.length && seeds.length > 0 ? Math.max(...seedHeights) - Math.min(...seedHeights) : null,
      seedChains: [...new Set(seeds.filter((e) => e.ok).map((e) => e.chainId).filter(Boolean))] },
    consensus: { commits: count(validators.map((r) => r.data.tenderdash?.thresholdSigned ?? null)), maxRound: max(validators.map((r) => r.data.tenderdash?.round)),
      activeMembers: validators.filter((r) => r.data.tenderdash?.inValidatorSet).length, observedVotingPower: validators.reduce((n,r) => n+(r.data.tenderdash?.inValidatorSet ? r.data.tenderdash.votingPower || 0 : 0),0),
      intervalSeconds: min(validators.map((r) => r.host.observation?.platform?.intervalSeconds)), samplingSeconds: max(validators.map((r) => r.host.observation?.windowSeconds)) },
    core: { headerLag: max(cores.map((r) => r.data.core.headers-r.data.core.blocks)), minOutboundGroups: min(cores.map((r) => r.data.core.peerDiversity?.groups)),
      paymentsAdvanced: current.filter((r) => r.host.observation?.paymentAdvanced).length, samplingSeconds: max(cores.map((r) => r.host.observation?.windowSeconds)) },
    services: { checks: count(services.map((s) => s.ok)), unobservedRoles: current.filter((r) => r.host.probe?.skipped).map((r) => r.host.role),
      details: current.flatMap((r) => (r.data.services || []).map((s) => ({ host: r.host.name,...s }))) },
    convergence: { matched: checks.filter((c) => c.status==='matched').length, rolling: checks.filter((c) => ['rolling','awaiting-sample'].includes(c.status)).length,
      drift: checks.filter((c) => ['drift','missing'].includes(c.status)).length, unknown: checks.filter((c) => c.status==='unknown').length,
      restarts: current.some((r) => r.host.observation?.restarts != null) ? current.reduce((n,r) => n+(r.host.observation?.restarts || 0),0) : null },
  };
}
