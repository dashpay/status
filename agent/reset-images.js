import { createHash } from 'node:crypto';

// Sidecars are selected by the target dashmate release, not by the operator.
// Resolve changed requests once for all architectures; retain existing pins for
// unchanged requests, including mutable redis:alpine. Tor is always preserved.
export async function resetSidecars(existing, requests, architectures, fetcher = fetch) {
  if (Object.keys(requests).some((s) => !['core_tor','gateway_rate_limiter','gateway_rate_limiter_redis'].includes(s))) throw Error('unsupported target release sidecar');
  const output = [];
  for (const [service, requested] of Object.entries(requests).sort(([a],[b]) => a.localeCompare(b))) {
    const old = existing.find((s) => s.service === service);
    if (old?.requested === requested) { output.push(old); continue; }
    if (service === 'core_tor') throw Error('target release changes preserved Core Tor image');
    let ref = requested.replace(/^(?:index\.)?docker\.io\//, '');
    if (!/^[a-z0-9/_.-]+(?::[A-Za-z0-9_.-]+)?(?:@sha256:[0-9a-f]{64})?$/.test(ref)) throw Error('unsupported sidecar registry reference');
    const parts = ref.split('@'), tagAt = parts[0].lastIndexOf(':');
    let repo = tagAt < 0 ? parts[0] : parts[0].slice(0,tagAt);
    ref = parts[1] || (tagAt < 0 ? 'latest' : parts[0].slice(tagAt+1));
    if (!repo.includes('/')) repo = 'library/' + repo;
    const auth = await fetcher(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`, { signal:AbortSignal.timeout(30000) });
    if (!auth.ok) throw Error(`sidecar registry authentication failed (${auth.status})`);
    const token = (await auth.json()).token;
    const manifest = async (reference) => {
      const reply = await fetcher(`https://registry-1.docker.io/v2/${repo}/manifests/${reference}`, { headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'}, signal:AbortSignal.timeout(30000) });
      if (!reply.ok) throw Error(`sidecar manifest resolution failed (${reply.status})`);
      const bytes = Buffer.from(await reply.arrayBuffer()), digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
      if (reference.startsWith('sha256:') && digest !== reference) throw Error('sidecar manifest digest mismatch');
      return { data:JSON.parse(bytes), digest };
    };
    const root = await manifest(ref), platforms = [];
    for (const architecture of architectures) {
      const child = root.data.manifests?.find((x) => x.platform?.os === 'linux' && x.platform.architecture === architecture);
      if (!child) throw Error(`target sidecar lacks linux/${architecture}`);
      await manifest(child.digest); // verify content-addressed child actually exists
      platforms.push({architecture,digest:child.digest});
    }
    output.push({service,requested,pinned:`index.docker.io/${repo}@${root.digest}`,platforms});
  }
  return output;
}
export function sidecarsFor(sidecars, architecture) {
  return Object.fromEntries(sidecars.map((s) => {
    const p = s.platforms.find((p) => p.architecture === architecture);
    if (!p) throw Error('sidecar architecture missing');
    return [s.service, s.pinned.split('@')[0] + '@' + p.digest];
  }));
}
