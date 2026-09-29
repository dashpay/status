// Release selection for one-click upgrades (pure; shared by the UI and tests).
export const COMPONENTS = ['core', 'drive', 'tenderdash', 'dapi', 'gateway', 'helper'];
export const REPOS = { core: 'dashpay/dashd', drive: 'dashpay/drive', tenderdash: 'dashpay/tenderdash', dapi: 'dashpay/rs-dapi', gateway: 'dashpay/envoy', helper: 'dashpay/dashmate-helper' };
export const OPERABLE = ['validator', 'masternode', 'seed'];
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
  // Without a known running release there is no safe "newer" (a stable tag
  // could be older than a running prerelease): choose by hand.
  if (!running) return null;
  const r = SEMVER.exec(running);
  const ok = tags.map((t) => t.name).filter((t) => SEMVER.test(t) && !/nightly|dev|pr/.test(t)).filter((t) => {
    const m = SEMVER.exec(t);
    return m[1] === r[1] && (!m[4] || r[4]);
  });
  const best = ok.sort(cmp).pop();
  return best && cmp(best, running) > 0 ? best : null;
}

// dashmate renders a console devnet's services, so its helper follows Drive's
// release: the update that brings the helper to Drive's (new or running) tag.
export function helperFor(n, driveTag, helperTags) {
  if (!n?.dashmate || !driveTag) return null;
  const running = imageTag(n.images?.helper);
  return driveTag !== running && (helperTags || []).some((t) => t.name === driveTag) ? { c: 'helper', from: running, to: driveTag } : null;
}
// The tag of an image reference, if it has one.
export const imageTag = (ref) => /:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec((ref || '').split('@')[0])?.[1] || null;
// dashmate (the helper image) renders every console devnet node's services, so
// it follows Drive's release while the two are in step.
export function withImage(images, c, value) {
  const next = { ...images, [c]: value };
  if (c === 'drive' && imageTag(images.drive) && imageTag(images.drive) === imageTag(images.helper) && imageTag(value)) next.helper = `${REPOS.helper}:${imageTag(value)}`;
  return next;
}
