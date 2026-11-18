import importlib.util
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


if __name__ == '__main__':
    unittest.main()
