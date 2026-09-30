// Bounded, restart-persistent observations. A missing sample or replaced EC2
// identity breaks continuity; last-good data is never a current success.
export function observe(hosts, previous, now = Date.now()) {
  const byId = new Map((previous?.hosts || []).map((h) => [h.instanceId, h]));
  for (const h of hosts) {
    const old = byId.get(h.instanceId), data = h.probe?.ok ? h.probe.data : null;
    const at = Date.parse(h.probe?.at);
    const oldAt = Date.parse(old?.probe?.at);
    const continuous = data && old?.probe?.ok && at > oldAt && at - oldAt <= 180_000;
    const history = continuous ? (old.observation?.samples || []).filter((s) => now - s.at < 3600_000).slice(-119) : [];
    if (!data) { h.observation = { samples: [], continuous: false }; continue; }
    const sample = { at, core: data.core?.blocks ?? null, platform: data.tenderdash?.height ?? null,
      platformTime: Date.parse(data.tenderdash?.blockTime) || null, paid: data.core?.masternode?.lastPaidHeight ?? null,
      restarts: Object.fromEntries((data.containers || []).filter((c) => c.running).map((c) => [c.name, { id: c.id, count: c.restarts || 0, started: c.startedAt }])) };
    const prior = history.at(-1);
    const chain = (key, syncing) => {
      if (syncing !== false || sample[key] == null || !prior || prior[key] == null) return { stalledSeconds: null, blocks: null, intervalSeconds: null };
      // Height regression/reorg resets the clock instead of claiming a stall.
      let since = at;
      for (let i = history.length - 1; i >= 0; i--) { if (history[i][key] !== sample[key]) break; since = history[i].at; }
      const first = history.find((s) => s[key] != null && s[key] < sample[key]);
      const elapsed = key === 'platform' && first?.platformTime && sample.platformTime ? sample.platformTime - first.platformTime : first ? at - first.at : null;
      return { stalledSeconds: Math.floor((at - since) / 1000), blocks: sample[key] - prior[key], intervalSeconds: first && elapsed > 0 ? Math.round(elapsed / (sample[key] - first[key]) / 100) / 10 : null };
    };
    const restarts = prior ? Object.entries(sample.restarts).reduce((n, [name, c]) => {
      const p = prior.restarts?.[name];
      return n + (!p ? 0 : c.id && p.id && c.id !== p.id ? 1 : Math.max(0, c.count - p.count) || (c.started !== p.started ? 1 : 0));
    }, 0) : null;
    h.observation = { samples: [...history, sample], continuous: !!continuous, windowSeconds: history.length ? Math.floor((at - history[0].at) / 1000) : 0,
      core: chain('core', data.core?.ibd), platform: chain('platform', data.tenderdash?.catchingUp),
      paymentAdvanced: prior?.paid != null && sample.paid != null ? sample.paid > prior.paid : null, restarts };
  }
  return hosts;
}
