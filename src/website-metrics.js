export const METRICS = { ttfbMs: 'Time to first byte', totalMs: 'Total HTML response', dnsMs: 'DNS lookup', tcpMs: 'TCP connection', tlsMs: 'TLS handshake', waitMs: 'Server wait' };
export const valueOf = (sample, metric) => sample?.ok ? (sample[metric] ?? sample.phases?.[metric] ?? null) : null;
export function segments(history, metric, start, end, interval = 300_000) {
  const groups = []; let current = [];
  for (const s of history || []) {
    const t = Date.parse(s.at), value = valueOf(s, metric);
    if (t < start || t > end) continue;
    if (value == null || (current.length && t - current.at(-1).t > interval * 2)) {
      if (current.length) groups.push(current);
      current = [];
    }
    if (value != null) current.push({ t, value });
  }
  if (current.length) groups.push(current);
  return groups;
}
export function recommendations(s) {
  if (!s?.ok) return [s?.error || 'No successful response to analyse yet.'];
  const hints = [];
  if (s.ttfbMs > 800) hints.push(`First byte took ${Math.round(s.ttfbMs)} ms. Check the timing breakdown: investigate origin work/cache misses if server wait dominates; connection or redirect time may also contribute.`);
  if (s.redirects) hints.push(`${s.redirects} redirect${s.redirects === 1 ? '' : 's'}${Number.isFinite(s.redirectMs) ? ` added ${Math.round(s.redirectMs)} ms` : ''}. Link directly to the final canonical URL and remove unnecessary redirect hops.`);
  if (s.encoding === 'none' && s.htmlBytes > 10000) hints.push('HTML was not compressed. Check Brotli/gzip support at the origin or CDN.');
  if (s.htmlBytes > 150000) hints.push(`HTML is ${Math.round(s.htmlBytes / 1024)} KiB before compression. Review duplicated markup and inline data.`);
  if (/no-store|private|no-cache/i.test(s.cacheControl) || s.cacheControl === 'not sent') hints.push('Review HTML caching policy for anonymous traffic. Cache only content that is safe to share; do not cache personalised responses.');
  if (s.hints?.blockingScripts) hints.push(`${s.hints.blockingScripts} external script tag(s) lack async/defer/module. Review whether non-critical scripts can be deferred; confirm rendering impact in a browser trace.`);
  if (s.hints?.imagesWithoutDimensions) hints.push(`${s.hints.imagesWithoutDimensions} image tag(s) lack explicit dimensions. Check CSS aspect-ratio or reserve space to avoid layout shifts.`);
  if (!hints.length) hints.push('No obvious issues in this HTML response. A browser audit can assess images, JavaScript and rendering.');
  return hints;
}
