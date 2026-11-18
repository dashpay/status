// Options are immutable plan inputs, never execution-time overrides.
export function rolloutFor(request) {
  const o = request.options || {};
  if (o.concurrency === undefined && o.pauseMining === undefined) return null;
  if (request.action !== 'upgrade') throw new Error('rollout options apply to upgrades only');
  const concurrency = o.concurrency === undefined ? 1 : o.concurrency, pauseMining = o.pauseMining === undefined ? false : o.pauseMining;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('concurrency must be an integer from 1 to 16');
  if (typeof pauseMining !== 'boolean') throw new Error('pauseMining must be true or false');
  if (o.allowCoreConfigRestart) throw new Error('rollout options cannot be combined with a configuration migration');
  return { concurrency, pauseMining };
}

export function rolloutArgs(rollout, miners) {
  if (!rollout) return [];
  return ['--concurrency', String(rollout.concurrency), ...(rollout.pauseMining ? ['--pause-mining', ...(miners ? ['--miners', miners.join(',')] : [])] : [])];
}

export function reviewedRollout(plan, requested, miners) {
  if (!requested) return null;
  const actual = plan?.rollout;
  // CLI emits omitempty false/empty values. Never display requested options as
  // verified when an older executor silently omitted them.
  if (!actual || actual.concurrency !== requested.concurrency || !!actual.pauseMining !== requested.pauseMining
    || JSON.stringify(actual.miners || []) !== JSON.stringify(requested.pauseMining ? miners : [])) {
    throw new Error('executor did not bind the requested rollout options; update dashnet and prepare a new plan');
  }
  return { concurrency: actual.concurrency, pauseMining: !!actual.pauseMining, miners: actual.miners || [], resumeMining: 'automatic' };
}

export function trackRollout(progress, line, native = false) {
  const m = (native ? /^upgrade (\S+) (applying|verified)(?:;.*)?$/ : /^managed target (\S+) (applying|applied)$/).exec(line);
  if (!m) return;
  progress.active ??= [];
  if (m[2] === 'applying') {
    if (!progress.active.includes(m[1])) progress.active.push(m[1]);
  } else {
    progress.active = progress.active.filter((n) => n !== m[1]);
    if (!progress.completed.includes(m[1])) progress.completed.push(m[1]);
  }
  progress.current = progress.active[0] || null;
}
