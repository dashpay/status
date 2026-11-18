#!/usr/bin/env python3
"""Bounded, unauthenticated homepage probes. Run only on the status host."""
import argparse
import concurrent.futures
import datetime
import fcntl
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.parse import urljoin, urlsplit

SITES = ('dash.dev', 'dash.org')
INTERVAL = 300
RETENTION = 7 * 86400
MAX_BYTES = 4 * 1024 * 1024


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def allowed(url, site):
    u = urlsplit(url)
    return (u.scheme == 'https' and u.hostname in (site, 'www.' + site)
            and u.port in (None, 443) and not u.username and not u.password)


class PageHints(HTMLParser):
    def __init__(self):
        super().__init__()
        self.counts = dict(scripts=0, blockingScripts=0, stylesheets=0, images=0, imagesWithoutDimensions=0)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'script' and a.get('src'):
            self.counts['scripts'] += 1
            if not any(k in a for k in ('async', 'defer')) and a.get('type', '').lower() != 'module':
                self.counts['blockingScripts'] += 1
        if tag == 'link' and 'stylesheet' in a.get('rel', '').lower().split():
            self.counts['stylesheets'] += 1
        if tag == 'img':
            self.counts['images'] += 1
            if not a.get('width') or not a.get('height'):
                self.counts['imagesWithoutDimensions'] += 1


def fetch_hop(url, directory):
    body, headers = Path(directory) / 'body', Path(directory) / 'headers'
    p = subprocess.run(['curl', '--disable', '--silent', '--show-error', '--noproxy', '*',
                        '--ipv4', '--compressed', '--proto', '=https', '--max-time', '20',
                        '--connect-timeout', '8', '--max-filesize', str(MAX_BYTES),
                        '--user-agent', 'DashStatusWebsiteProbe/1.0', '--dump-header', str(headers),
                        '--output', str(body), '--write-out', '%{json}', url],
                       capture_output=True, text=True, timeout=25)
    if p.returncode:
        # Do not publish raw curl diagnostics, headers, addresses, or cookies.
        codes = {6: 'DNS lookup failed', 7: 'Connection failed', 28: 'Request timed out',
                 60: 'TLS certificate validation failed', 63: 'HTML exceeds the 4 MiB probe limit'}
        raise ValueError(codes.get(p.returncode, 'HTTPS probe failed (curl %d)' % p.returncode))
    metrics = json.loads(p.stdout)
    selected = {}
    for line in headers.read_text(errors='replace').splitlines():
        if line.startswith('HTTP/'):
            selected = {}
        elif ':' in line:
            key, value = line.split(':', 1)
            if key.lower() in ('location', 'content-type', 'content-encoding', 'cache-control', 'age', 'cf-cache-status', 'x-cache'):
                selected[key.lower()] = value.strip()[:300]
    return metrics, selected, body.read_bytes()[:MAX_BYTES]


def probe(site, fetch=fetch_hop):
    result = {'site': site, 'at': stamp(), 'ok': False}
    url = 'https://' + site + '/'
    hops = []
    try:
        with tempfile.TemporaryDirectory() as directory:
            for _ in range(5):
                if not allowed(url, site):
                    raise ValueError('Redirect outside the approved HTTPS website')
                m, h, body = fetch(url, directory)
                code = int(m['http_code'])
                t = lambda key: float(m.get('time_' + key, 0)) * 1000
                hop = {'status': code, 'dnsMs': t('namelookup'),
                       'tcpMs': max(0, t('connect') - t('namelookup')),
                       'tlsMs': max(0, t('appconnect') - t('connect')),
                       'waitMs': max(0, t('starttransfer') - t('pretransfer')),
                       'ttfbMs': t('starttransfer'), 'totalMs': t('total'),
                       'downloadMs': max(0, t('total') - t('starttransfer'))}
                hops.append(hop)
                if code in (301, 302, 303, 307, 308):
                    if not h.get('location'):
                        raise ValueError('Redirect has no destination')
                    url = urljoin(url, h['location'])
                    continue
                result.update(status=code, finalUrl=urlsplit(url)._replace(query='', fragment='').geturl(),
                              redirects=len(hops) - 1, httpVersion=str(m.get('http_version', 'unknown')),
                              transferBytes=int(m.get('size_download', 0)), htmlBytes=len(body),
                              encoding=h.get('content-encoding', 'none'), cacheControl=h.get('cache-control', 'not sent'),
                              cacheStatus=h.get('cf-cache-status', h.get('x-cache', 'not reported')), age=h.get('age'),
                              redirectMs=round(sum(x['totalMs'] for x in hops[:-1]), 1),
                              ttfbMs=round(sum(x['totalMs'] for x in hops[:-1]) + hop['ttfbMs'], 1),
                              totalMs=round(sum(x['totalMs'] for x in hops), 1),
                              phases={k: round(sum(x[k] for x in hops), 1) for k in ('dnsMs', 'tcpMs', 'tlsMs', 'waitMs', 'downloadMs')})
                if not 200 <= code < 300:
                    raise ValueError('Homepage returned HTTP %d' % code)
                if 'text/html' not in h.get('content-type', '').lower():
                    raise ValueError('Homepage did not return HTML')
                hints = PageHints()
                hints.feed(body.decode('utf-8', errors='replace'))
                result.update(ok=True, hints=hints.counts)
                return result
            raise ValueError('Too many redirects (maximum four followed)')
    except (ValueError, OSError, subprocess.TimeoutExpired) as e:
        result['error'] = str(e) if isinstance(e, ValueError) else 'Probe could not complete'
    return result


def percentile(values, q):
    return sorted(values)[max(0, math.ceil(len(values) * q) - 1)] if values else None


def summarize(samples, now):
    recent = [s for s in samples if datetime.datetime.fromisoformat(s['at']).timestamp() >= now - 86400]
    good = [s for s in recent if s['ok']]
    return dict(samples=len(recent), successes=len(good),
                successPercent=round(100 * len(good) / len(recent), 1) if recent else None,
                ttfbP50Ms=percentile([s['ttfbMs'] for s in good], .5),
                ttfbP95Ms=percentile([s['ttfbMs'] for s in good], .95),
                totalP50Ms=percentile([s['totalMs'] for s in good], .5))


def collect(output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with (output.parent / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            previous = json.loads(output.read_text())
        except (OSError, ValueError):
            previous = {}
        now = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            latest = list(pool.map(probe, SITES))
        sites = []
        for item in latest:
            old = next((s.get('history', []) for s in previous.get('sites', []) if s.get('site') == item['site']), [])
            history = [s for s in old if datetime.datetime.fromisoformat(s['at']).timestamp() > now - RETENTION]
            history = (history + [item])[-2200:]
            sites.append(dict(site=item['site'], latest=item, history=history, summary24h=summarize(history, now)))
        report = dict(schemaVersion=1, generatedAt=stamp(), intervalSeconds=INTERVAL,
                      location='AWS us-west-2 · Oregon · status host', sites=sites)
        temporary = output.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, separators=(',', ':')))
        temporary.chmod(0o644)
        os.replace(temporary, output)
        print(json.dumps({'generatedAt': report['generatedAt'], 'sites': [{'site': s['site'], 'ok': s['latest']['ok'], 'ttfbMs': s['latest'].get('ttfbMs'), 'error': s['latest'].get('error')} for s in sites]}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    collect(parser.parse_args().output)
