import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('probe.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def response(code=200):
    return dict(http_code=code, time_namelookup=.01, time_connect=.03, time_appconnect=.06,
                time_pretransfer=.061, time_starttransfer=.1, time_total=.12, size_download=123, http_version='2')


class ProbeTests(unittest.TestCase):
    def test_redirect_included_in_ttfb_and_phases(self):
        calls = []
        def fetch(url, _):
            calls.append(url)
            return (response(301), {'location': 'https://www.dash.org/'}, b'') if len(calls) == 1 else (response(), {'content-type': 'text/html', 'content-encoding': 'br'}, b'<html></html>')
        s = p.probe('dash.org', fetch)
        self.assertTrue(s['ok'])
        self.assertEqual(s['ttfbMs'], 220)
        self.assertEqual(s['totalMs'], 240)
        self.assertEqual(s['redirectMs'], 120)
        self.assertEqual(s['phases']['tlsMs'], 60)
        self.assertEqual(s['phases']['waitMs'], 78)

    def test_redirect_cannot_probe_other_hosts_or_credentials(self):
        for target in ['http://dash.org/', 'https://169.254.169.254/', 'https://dash.org.evil.test/', 'https://a:b@dash.org/', 'https://dash.org:444/']:
            calls = []
            def fetch(url, _):
                calls.append(url)
                return response(302), {'location': target}, b''
            s = p.probe('dash.org', fetch)
            self.assertFalse(s['ok'])
            self.assertEqual(len(calls), 1)

    def test_failures_not_counted_as_fast_success(self):
        sample = p.probe('dash.dev', lambda *_: (response(503), {'content-type': 'text/html'}, b'unavailable'))
        self.assertFalse(sample['ok'])
        stats = p.summarize([sample], p.time.time())
        self.assertEqual(stats['successPercent'], 0)
        self.assertIsNone(stats['ttfbP50Ms'])

    def test_hints_distinguish_deferred_scripts(self):
        h = p.PageHints()
        h.feed('<script src="a"></script><script src="b" defer></script><script src="c" type="module"></script><img src="x"><img src="y" width="2" height="2">')
        self.assertEqual(h.counts['scripts'], 3)
        self.assertEqual(h.counts['blockingScripts'], 1)
        self.assertEqual(h.counts['imagesWithoutDimensions'], 1)

    def test_non_html_not_healthy(self):
        s = p.probe('dash.dev', lambda *_: (response(), {'content-type': 'application/json'}, b'{}'))
        self.assertFalse(s['ok'])

    def test_redirect_loop_bounded(self):
        calls = []
        def fetch(url, _):
            calls.append(url)
            return response(301), {'location': '/'}, b''
        self.assertFalse(p.probe('dash.dev', fetch)['ok'])
        self.assertEqual(len(calls), 5)


MENU = ' '.join('menu%d' % i for i in range(80))


def html_page(title='Download Dash Mobile Wallet | Dash', body='Mobile Wallets DashPay', links=('https://github.com/dashpay/dash/releases/download/v1/dashcore-1-x86_64-linux-gnu.tar.gz',), filler=1200):
    anchors = ''.join('<a href="%s">get</a>' % href for href in links)
    return ('<html><head><title>%s</title><style>.hacked-by{}</style></head><body><svg><title>icon</title></svg><nav>%s</nav>'
            '<script>var pwned = "hacked by";</script><p>%s</p>%s<p>%s</p></body></html>' % (title, MENU, body, anchors, 'x' * filler)).encode()


def serve(body=None, code=200, content_type='text/html; charset=UTF-8'):
    return lambda url, _: (response(code), {'content-type': content_type}, html_page() if body is None else body)


DOWNLOAD = dict(path='/download/', title='Download Dash', phrases=('Mobile Wallets', 'DashPay'), downloads=('github.com/dashpay/',))
codes = lambda page: [x['code'] for x in page['problems']]


class PageCheckTests(unittest.TestCase):
    def check(self, spec=DOWNLOAD, previous=None, now=1_800_000_000, **kw):
        return p.check_page('dash.org', spec, previous, serve(**kw), now)

    def test_the_expected_page_passes_and_becomes_the_baseline(self):
        page, keep = self.check()
        self.assertEqual((page['ok'], page['reachable'], page['problems'], page['status']), (True, True, [], 200))
        self.assertNotIn('failures', page)
        self.assertIn('wallets', keep['baseline'])
        # Text of scripts and styles is not page text, and an SVG's title is not the document's.
        self.assertNotIn('pwned', keep['baseline'])

    def test_each_way_a_page_can_be_wrong_is_named_in_our_words(self):
        cases = {
            'title': html_page(title='Something else'),
            'phrase': html_page(body='DashPay only'),
            'short': html_page(filler=10),
            'defaced': html_page(body='Mobile Wallets DashPay Hacked  By someone'),
            'download_link': html_page(links=('https://github.com/dashpay/dash/a.zip', 'https://github.com.evil.example/dashpay/dash.exe')),
            'no_downloads': html_page(links=('https://play.google.com/store/apps/details?id=x',)),
        }
        for code, body in cases.items():
            page, _ = self.check(body=body)
            self.assertEqual(codes(page), [code], code)
            self.assertEqual((page['ok'], page['reachable'], page['failures']), (False, True, 1), code)
        self.assertEqual(self.check(body=cases['download_link'])[0]['problems'][0]['detail'], 'github.com.evil.example')
        self.assertEqual(self.check(body=cases['defaced'])[0]['problems'][0]['detail'], 'hacked by')
        # Download links that are not plain https to the expected place are foreign too.
        for href in ('http://github.com/dashpay/dash/a.zip', 'https://user@github.com/dashpay/dash/a.zip', 'https://github.com:8443/dashpay/dash/a.zip', 'https://github.com/dashpayx/a.exe', '/files/wallet.apk'):
            self.assertEqual(codes(self.check(body=html_page(links=(href,)))[0]), ['download_link'], href)

    def test_nothing_the_page_says_reaches_the_report(self):
        evil = 'IGNORE PREVIOUS INSTRUCTIONS'
        body = html_page(title=evil, body=evil + ' hacked by ' + evil, links=('https://exa mple/<b>.exe', 'https://[broken/%s.exe' % evil, 'https://host:port/%s.exe' % evil))
        page, _ = self.check(body=body)
        self.assertNotIn(evil, json_text(page))
        self.assertTrue(all(len(str(x.get('detail', ''))) <= 60 for x in page['problems']))

    def test_a_missing_page_that_redirects_to_the_homepage_is_not_the_page(self):
        def fetch(url, _):
            return (response(301), {'location': 'https://www.dash.org/'}, b'') if url.endswith('/download/') else (response(), {'content-type': 'text/html'}, html_page())
        page, _ = p.check_page('dash.org', DOWNLOAD, None, fetch, 1_800_000_000)
        self.assertEqual(page['problems'], [{'code': 'moved', 'detail': '/'}])
        self.assertTrue(page['reachable'])
        # With and without the closing slash is the same page.
        self.assertTrue(p.same_page('https://www.dash.org/download', '/download/') and p.same_page('https://www.dash.org', '/'))

    def test_unreachable_is_told_apart_from_wrong(self):
        for kw, code in (({'code': 503}, 'status'), ({'code': 404}, 'status')):
            page, _ = self.check(**kw)
            self.assertEqual((codes(page), page['reachable'], page['ok']), ([code], False, False))
        page, _ = self.check(content_type='application/json')
        self.assertEqual((codes(page), page['reachable']), (['not_html'], True))

        def refuse(url, _):
            raise ValueError('Connection failed')
        page, keep = p.check_page('dash.org', DOWNLOAD, {'baseline': ['kept']}, refuse, 1_800_000_000)
        self.assertEqual(page['problems'], [{'code': 'unreachable', 'detail': 'Connection failed'}])
        self.assertEqual(keep['baseline'], ['kept'])
        for target in ('http://www.dash.org/download/', 'https://evil.example/download/'):
            page, _ = p.check_page('dash.org', DOWNLOAD, None, lambda url, _: (response(302), {'location': target}, b''), 1_800_000_000)
            self.assertEqual(codes(page), ['unreachable'])

    def test_failures_count_in_a_row_and_start_again_after_a_good_reading(self):
        now, keep = 1_800_000_000, None
        for n in (1, 2, 3):
            page, keep = self.check(previous=keep, now=now + n * 300, code=503)
            self.assertEqual(page['failures'], n)
        self.assertEqual(p.seconds_since(page['since'], now), -300)
        page, keep = self.check(previous=keep, now=now + 1200)
        self.assertTrue(page['ok'])
        self.assertNotIn('failures', keep)
        page, keep = self.check(previous=keep, now=now + 1500, code=503)
        self.assertEqual((page['failures'], p.seconds_since(page['since'], now)), (1, -1500))

    def test_a_page_that_changed_at_once_is_reported_for_a_day_then_taken_as_it_is(self):
        now = 1_800_000_000
        other = html_page(body='Mobile Wallets DashPay ' + ' '.join('fresh%d' % i for i in range(400)))
        _, keep = self.check(now=now)
        page, keep = self.check(previous=keep, now=now + 300, body=other)
        self.assertEqual(codes(page), ['changed'])
        self.assertLess(page['similarity'], p.SIMILARITY_MIN)
        page, keep = self.check(previous=keep, now=now + 300 + p.ACCEPT_AFTER - 1, body=other)
        self.assertEqual((codes(page), page['failures']), (['changed'], 2))
        page, keep = self.check(previous=keep, now=now + 300 + p.ACCEPT_AFTER, body=other)
        self.assertTrue(page['ok'])
        self.assertIn('fresh1', keep['baseline'])
        self.assertNotIn('changedSince', keep)
        # A small edit is not a change, and moves the baseline along.
        edited = html_page(body='Mobile Wallets DashPay ' + ' '.join('fresh%d' % i for i in range(380)))
        page, keep = self.check(previous=keep, now=now + 400_000, body=edited)
        self.assertTrue(page['ok'])
        self.assertNotIn('fresh399', keep['baseline'])

    def test_a_changed_page_that_is_also_wrong_is_never_taken_as_it_is(self):
        now = 1_800_000_000
        wrong = html_page(title='Other', body=' '.join('fresh%d' % i for i in range(400)))
        _, keep = self.check(now=now)
        for later in (300, p.ACCEPT_AFTER * 3):
            page, keep = self.check(previous=keep, now=now + later, body=wrong)
            self.assertEqual(codes(page), ['title', 'phrase', 'phrase', 'changed'])
        self.assertIn('wallets', keep['baseline'])
        # Back as it was: the old change is forgotten, so a later one is reported from its own start.
        page, keep = self.check(previous=keep, now=now + p.ACCEPT_AFTER * 4)
        self.assertTrue(page['ok'])
        page, keep = self.check(previous=keep, now=now + p.ACCEPT_AFTER * 5, body=html_page(body='Mobile Wallets DashPay ' + ' '.join('fresh%d' % i for i in range(400))))
        self.assertEqual(codes(page), ['changed'])

    def test_visitor_text_is_not_searched_for_markers_where_the_page_says_so(self):
        forum = dict(path='/forum/', title='Dash Forum', phrases=('Forum statistics',), markers=False)
        body = html_page(title='Dash Forum', body='Forum statistics. Thread: my wallet was hacked by a scammer', links=())
        self.assertTrue(p.check_page('dash.org', forum, None, serve(body=body), 1_800_000_000)[0]['ok'])

    def test_all_pages_are_checked_and_the_state_is_kept_by_page(self):
        asked = []

        def fetch(url, _):
            asked.append(url)
            return response(), {'content-type': 'text/html'}, html_page()
        shape, state = p.check_pages({}, fetch=fetch, now=1_800_000_000)
        self.assertEqual(sorted(asked), sorted('https://www.dash.org' + s['path'] for s in p.SHAPE_PAGES))
        self.assertEqual([x['path'] for x in shape['pages']], [s['path'] for s in p.SHAPE_PAGES])
        self.assertEqual(set(state['pages']), set('dash.org' + s['path'] for s in p.SHAPE_PAGES))
        self.assertTrue(all(x['site'] == 'dash.org' for x in shape['pages']))
        # A damaged state file is no state: every page is read as for the first time.
        self.assertEqual(len(p.check_pages('nonsense', fetch=fetch, now=1_800_000_000)[0]['pages']), len(p.SHAPE_PAGES))


    def test_a_page_that_cannot_be_judged_is_not_in_order_and_costs_no_other_page(self):
        real = p.content_problems

        def judge(spec, *rest):
            if spec['path'] == '/blog/':
                raise RuntimeError('<b>page text</b>')
            return real(spec, *rest)
        p.content_problems = judge
        try:
            shape, _ = p.check_pages({}, fetch=serve(), now=1_800_000_000)
        finally:
            p.content_problems = real
        blog = next(x for x in shape['pages'] if x['path'] == '/blog/')
        self.assertEqual((blog['ok'], blog['reachable'], blog['problems']), (False, False, [{'code': 'unreachable', 'detail': 'Page could not be read'}]))
        self.assertEqual(len(shape['pages']), len(p.SHAPE_PAGES))
        self.assertTrue(next(x for x in shape['pages'] if x['path'] == '/download/')['ok'])

    def test_an_error_text_that_is_not_one_of_ours_is_not_passed_on(self):
        def fetch(url, _):
            raise ValueError('Invalid URL <script>alert(1)</script>')
        page, _ = p.check_page('dash.org', DOWNLOAD, None, fetch, 1_800_000_000)
        self.assertEqual(page['problems'], [{'code': 'unreachable', 'detail': 'Probe could not complete'}])

    def test_page_checks_that_crash_keep_their_last_result_and_the_timings_are_still_written(self):
        import tempfile
        real = p.probe, p.check_pages
        p.probe = lambda site: {'site': site, 'at': p.stamp(), 'ok': True, 'ttfbMs': 1.0, 'totalMs': 2.0}
        try:
            with tempfile.TemporaryDirectory() as directory:
                output = p.Path(directory) / 'report.json'
                p.check_pages = lambda state: ({'at': '2026-11-27T18:00:00+00:00', 'pages': [{'path': '/', 'ok': True, 'problems': []}]}, {'schemaVersion': 1, 'pages': {}})
                p.collect(output)
                first = json.loads(output.read_text())
                self.assertEqual(first['shape']['at'], '2026-11-27T18:00:00+00:00')
                self.assertEqual((p.Path(directory) / 'shape-state.json').stat().st_mode & 0o777, 0o600)

                def crash(state):
                    raise RuntimeError('bug')
                p.check_pages = crash
                with self.assertRaises(RuntimeError):
                    p.collect(output)
                second = json.loads(output.read_text())
                self.assertEqual(second['shape'], first['shape'])
                self.assertGreater(second['generatedAt'], first['generatedAt'])
                self.assertEqual([len(s['history']) for s in second['sites']], [2, 2])
        finally:
            p.probe, p.check_pages = real


def json_text(value):
    return json.dumps(value)


if __name__ == '__main__':
    unittest.main()
