#!/usr/bin/env python3
"""Bounded, unauthenticated website probes. Run only on the status host.

Two things are measured. How fast the homepages answer (`probe`, for the
Websites page), and whether a list of pages still are the pages they are
supposed to be (`check_page`, "page checks": monitoring files a fault when one
is not, see README.md beside this file).
"""
import argparse
import concurrent.futures
import datetime
import fcntl
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import urljoin, urlsplit

SITES = ('dash.dev', 'dash.org')
INTERVAL = 300
RETENTION = 7 * 86400
MAX_BYTES = 4 * 1024 * 1024

# Page checks. Each page is asked for at https://www.<site><path> and must be
# that page: the address it ends at, its title, and a phrase or two of its own
# text. The phrases are the page's content, not the menu every page carries.
# `markers` off: the page shows text written by visitors (forum thread titles),
# where a word such as "hacked" is conversation. `downloads`: every link to an
# installer or archive on the page must point below one of these addresses, and
# there must be at least one.
SHAPE_SITE = 'dash.org'
SHAPE_PAGES = (
    dict(path='/', title='Dash is Digital Cash', phrases=('Download Wallet', 'Integrate Dash payments')),
    dict(path='/download/', title='Download Dash', phrases=('Mobile Wallets', 'DashPay'), downloads=('github.com/dashpay/',)),
    dict(path='/dashpay/', title='DashPay', phrases=('The most secure way to hold and use Dash',)),
    dict(path='/buy/', title='Buy Dash', phrases=('Buying Dash online',)),
    dict(path='/masternodes/', title='Masternodes', phrases=('How Masternodes Work',)),
    dict(path='/developers/', title='Build Next Generation Apps', phrases=('Dash Developer Portal',)),
    dict(path='/evolution/', title='Evolution', phrases=('Dash Evolution Changes Everything',)),
    dict(path='/community/', title='Connect, Learn', phrases=('Engage with the community',)),
    dict(path='/blog/', title='Blog', phrases=('Read Article',)),
    dict(path='/forum/', title='Dash Forum', phrases=('Forum statistics', 'XenForo'), markers=False),
)
MIN_TEXT = 1000  # characters of visible text; an error page or an empty shell has fewer
# Words a defaced page carries and these pages do not. The name is what is reported, never the page's text.
MARKERS = (('hacked by', re.compile(r'\bhacked\s+by\b', re.I)), ('defaced', re.compile(r'\bdefaced\b', re.I)),
           ('pwned', re.compile(r'\b(?:pwn(?:e)?d|0wned)\b', re.I)), ('h4ck', re.compile(r'\bh4ck', re.I)))
DOWNLOAD = re.compile(r'\.(?:apk|aab|ipa|dmg|pkg|exe|msi|zip|gz|tgz|xz|bz2|deb|rpm|appimage|asc|sig)$', re.I)
# How alike the words of a page are to those of its last good reading (shared
# words over all words). Two different pages of dash.org score up to 0.5, the
# same page read twice 1.0.
SIMILARITY_MIN = 0.6
# A page that changed that much at once is reported for this long, and then the
# new text is taken as what the page says now: nobody has to reset anything.
ACCEPT_AFTER = 24 * 3600
MAX_TOKENS = 4000
SHAPE_HOPS = 3
SAFE_PATH = re.compile(r'^/[A-Za-z0-9/_.~%-]{0,200}$')
SAFE_HOST = re.compile(r'^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$')
PLAIN_ERROR = re.compile(r'^[A-Za-z0-9 ().,-]{1,80}$')


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


class PageText(HTMLParser):
    """The text a visitor reads, the document's title and where its links go."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.title_parts, self.links = [], [], []
        self._hidden = self._titles = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self._hidden += 1
        elif tag == 'title':
            # The document's title is the first one; an inline SVG has titles of its own.
            self._titles += 1
            self._in_title = self._titles == 1
        elif tag == 'a':
            href = dict(attrs).get('href')
            if href:
                self.links.append(href)

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self._hidden = max(0, self._hidden - 1)
        elif tag == 'title':
            self._in_title = False

    def handle_data(self, data):
        if self._hidden:
            return
        if self._in_title:
            self.title_parts.append(data)
        self.parts.append(data)

    @property
    def text(self):
        return ' '.join(' '.join(self.parts).split())

    @property
    def title(self):
        return ' '.join(' '.join(self.title_parts).split())


def words(text):
    return sorted(set(w for w in re.split(r'[^a-z0-9]+', text.lower()) if len(w) >= 4))[:MAX_TOKENS]


def alike(a, b):
    a, b = set(a), set(b)
    return len(a & b) / len(a | b) if a and b else 0.0


def seconds_since(at, now):
    try:
        return now - datetime.datetime.fromisoformat(at).timestamp()
    except (TypeError, ValueError):
        return None


def fetch_page(url, site, fetch):
    """Follow redirects inside the site. Returns (status, final URL, content type, body)."""
    with tempfile.TemporaryDirectory() as directory:
        for _ in range(SHAPE_HOPS + 1):
            if not allowed(url, site):
                raise ValueError('Redirect outside the approved HTTPS website')
            m, h, body = fetch(url, directory)
            code = int(m['http_code'])
            if code in (301, 302, 303, 307, 308):
                if not h.get('location'):
                    raise ValueError('Redirect has no destination')
                url = urljoin(url, h['location'])
                continue
            return code, url, h.get('content-type', '').lower(), body
    raise ValueError('Too many redirects (maximum %d followed)' % SHAPE_HOPS)


def same_page(final_url, path):
    return (urlsplit(final_url).path.rstrip('/') or '/') == (path.rstrip('/') or '/')


def content_problems(spec, site, final_url, body):
    """What is wrong with a page that answered with HTML, and its words.

    Nothing the page says is reported: a detail is a phrase or a name from the
    list above, a number, or a host name of a restricted alphabet. Whoever reads
    a fault (a person, an agent) reads our words, not the page's.
    """
    problems = []

    def add(code, detail=None):
        problems.append({'code': code, **({'detail': detail} if detail else {})})

    if not same_page(final_url, spec['path']):
        ended = urlsplit(final_url).path
        add('moved', ended if SAFE_PATH.match(ended) else None)
    page = PageText()
    page.feed(body.decode('utf-8', errors='replace'))
    page.close()
    text, lowered = page.text, page.text.casefold()
    if len(text) < spec.get('minText', MIN_TEXT):
        add('short', '%d characters' % len(text))
    if spec['title'].casefold() not in page.title.casefold():
        add('title', spec['title'])
    for phrase in spec.get('phrases', ()):
        if phrase.casefold() not in lowered:
            add('phrase', phrase)
    if spec.get('markers', True):
        for name, pattern in MARKERS:
            if pattern.search(text):
                add('defaced', name)
    if spec.get('downloads'):
        files, foreign = 0, set()
        for href in page.links:
            try:
                u = urlsplit(urljoin(final_url, href))
                path, host, plain = u.path, (u.hostname or '').lower(), u.scheme == 'https' and not u.username and u.port in (None, 443)
            except ValueError:  # an address that cannot be read is not the expected one
                path, host, plain = href.split('?')[0].split('#')[0], '', False
            if not DOWNLOAD.search(path):
                continue
            files += 1
            if not plain or not any((host + path).startswith(p) for p in spec['downloads']):
                foreign.add(host if SAFE_HOST.match(host) else 'another host')
        for host in sorted(foreign)[:5]:
            add('download_link', host)
        if not files:
            add('no_downloads')
    return problems, words(text)


def check_page(site, spec, previous, fetch=fetch_hop, now=None):
    """One page check. `previous` is what the last run kept for this page; returns (page, what to keep)."""
    now = time.time() if now is None else now
    at = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat()
    previous = previous if isinstance(previous, dict) else {}
    page = {'site': site, 'path': spec['path'], 'at': at, 'ok': False, 'reachable': False, 'problems': []}
    keep = {k: previous[k] for k in ('baseline', 'baselineAt', 'changedSince') if previous.get(k)}
    try:
        status, final_url, content_type, body = fetch_page('https://www.%s%s' % (site, spec['path']), site, fetch)
    except (ValueError, OSError, subprocess.TimeoutExpired) as e:
        # Our own sentences only: an error text that carries anything else is not passed on.
        said = str(e) if isinstance(e, ValueError) and PLAIN_ERROR.match(str(e)) else 'Probe could not complete'
        page['problems'] = [{'code': 'unreachable', 'detail': said}]
    else:
        page['status'] = status
        try:
            judged = content_problems(spec, site, final_url, body) if 200 <= status < 300 and 'text/html' in content_type else None
        except Exception:  # a page that cannot be judged is not in order, and must not cost the other pages their check
            judged = False
        if judged is False:
            page['problems'] = [{'code': 'unreachable', 'detail': 'Page could not be read'}]
        elif not 200 <= status < 300:
            page['problems'] = [{'code': 'status', 'detail': 'HTTP %d' % status}]
        elif judged is None:
            page['reachable'] = True
            page['problems'] = [{'code': 'not_html'}]
        else:
            page['reachable'] = True
            problems, tokens = judged
            baseline, changed_since = keep.get('baseline'), keep.pop('changedSince', None)
            if baseline:
                page['similarity'] = round(alike(tokens, baseline), 3)
                if page['similarity'] < SIMILARITY_MIN:
                    since = changed_since or at
                    waited = seconds_since(since, now)
                    if problems or waited is None or waited < ACCEPT_AFTER:
                        keep['changedSince'] = since
                        problems.append({'code': 'changed', 'detail': 'similarity %.2f' % page['similarity']})
            if not problems:
                # What the page says now is what it is compared with next time.
                keep = {'baseline': tokens, 'baselineAt': at}
            page['problems'] = problems
    page['ok'] = not page['problems']
    # One failed reading is not a fault yet: monitoring files one from the second in a row.
    if not page['ok']:
        keep['failures'] = (previous.get('failures') if isinstance(previous.get('failures'), int) else 0) + 1
        keep['since'] = previous.get('since') if previous.get('failures') and previous.get('since') else at
        page.update(failures=keep['failures'], since=keep['since'])
    return page, keep


def check_pages(state, site=SHAPE_SITE, pages=SHAPE_PAGES, fetch=fetch_hop, now=None):
    """All page checks. Returns (the report's `shape` section, the state to keep)."""
    old = state.get('pages', {}) if isinstance(state, dict) and isinstance(state.get('pages'), dict) else {}
    key = lambda spec: '%s%s' % (site, spec['path'])
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(lambda spec: check_page(site, spec, old.get(key(spec)), fetch, now), pages))
    return ({'at': stamp(), 'pages': [page for page, _ in results]},
            {'schemaVersion': 1, 'pages': {key(spec): keep for spec, (_, keep) in zip(pages, results)}})


def write_private(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, separators=(',', ':')))
    temporary.chmod(0o600)
    os.replace(temporary, path)


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
        # After the timing probes, so that these requests are not in their measurements.
        state_file = output.parent / 'shape-state.json'
        try:
            state = json.loads(state_file.read_text())
        except (OSError, ValueError):
            state = {}
        failed = None
        try:
            shape, state = check_pages(state)
            write_private(state_file, state)
        except Exception as e:
            # The timings are still written. The page checks keep their last
            # result and its time, so that they go stale and are filed as stale:
            # leaving them out would read as a collector that checks no pages.
            failed, shape = e, previous.get('shape') if isinstance(previous, dict) else None
        report = dict(schemaVersion=1, generatedAt=stamp(), intervalSeconds=INTERVAL,
                      location='AWS us-west-2 · Oregon · status host', sites=sites, **({'shape': shape} if isinstance(shape, dict) else {}))
        temporary = output.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, separators=(',', ':')))
        temporary.chmod(0o644)
        os.replace(temporary, output)
        print(json.dumps({'generatedAt': report['generatedAt'], 'sites': [{'site': s['site'], 'ok': s['latest']['ok'], 'ttfbMs': s['latest'].get('ttfbMs'), 'error': s['latest'].get('error')} for s in sites],
                          'pages': {'failed': type(failed).__name__} if failed else {'checked': len(shape['pages']), 'wrong': {p['path']: [x['code'] for x in p['problems']] for p in shape['pages'] if not p['ok']}}}))
        if failed:
            raise failed  # the unit fails and the journal has the trace


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    collect(parser.parse_args().output)
