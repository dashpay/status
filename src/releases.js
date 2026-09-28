// Release selection for one-click upgrades (pure; shared by the UI and tests).
// Running release per component, from what the nodes report.
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/;
export function reported(h, c) {
  const v = { core: /Dash Core:(\d+\.\d+\.\d+)/.exec(h.core?.version || '')?.[1], drive: h.dapi?.driveVersion, dapi: h.dapi?.dapiVersion, tenderdash: h.platform?.version }[c]
    || h.containers.find((k) => k.component === c)?.version;
  return SEMVER.test(v || '') ? v.replace(/^v/, '') : null;
}
export const cmp = (a, b) => {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  for (const i of [1, 2, 3]) if (+x[i] !== +y[i]) return +x[i] - +y[i];
  if (!x[4] || !y[4]) return (x[4] ? -1 : 0) - (y[4] ? -1 : 0);
  return x[4] === y[4] ? +x[5] - +y[5] : x[4] < y[4] ? -1 : 1;
};
// Newest release in the running major line; prereleases only where the
// network already runs one. Majors (e.g. Core 23 -> 24) are chosen by hand.
export function newestRelease(tags, running) {
  const r = running && SEMVER.exec(running);
  const ok = tags.map((t) => t.name).filter((t) => SEMVER.test(t) && !/nightly|dev|pr/.test(t)).filter((t) => {
    const m = SEMVER.exec(t);
    return (!r || m[1] === r[1]) && (!m[4] || (r && r[4]));
  });
  const best = ok.sort(cmp).pop();
  return best && (!running || cmp(best, running) > 0) ? best : null;
}
