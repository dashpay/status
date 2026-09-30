import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('probe.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def container(image, cmd=None, env=None):
    return {'Config': {'Image': image, 'Cmd': cmd or [], 'Env': env or []},
            'State': {'Running': True}, 'HostConfig': {'PortBindings': {}, 'NetworkMode': 'bridge'},
            'NetworkSettings': {'Networks': {'local': {'IPAddress': '172.20.0.2'}}}}


class Probes(unittest.TestCase):
    def test_malformed_protobuf_is_bounded(self):
        for data in [b'\x80'*100,b'\x0a\x08a',b'\x09a',b'\x0da']:
            with self.assertRaises(ValueError): p.protobuf(data)

    def test_zero_epoch_is_valid(self):
        self.assertEqual(p.protobuf(b'\x08\x00\x10\x01'), {1: 0, 2: 1})

    def test_prometheus_route_prefix_and_target_failure(self):
        for flags in [['--web.external-url=https://example.org/prometheus'],
                      ['--web.external-url=https://example.org/other', '--web.route-prefix', '/prometheus']]:
            def get(url, timeout, opener):
                self.assertEqual(url, 'http://172.20.0.2:9090/prometheus/api/v1/targets')
                return 200, {'status': 'success', 'data': {'activeTargets': [{'health': 'down'}]}}, 1
            with patch.object(p, 'get_json', get):
                check = p.role_services({'prom': container('prom/prometheus:latest', flags)})[0]
            self.assertTrue(check['ok'])
            self.assertEqual(check['down'], 1)

    def test_elasticsearch_auth_is_local_nonredirecting_and_red_is_failed(self):
        def get(req, timeout, opener):
            self.assertEqual(req.full_url, 'http://172.20.0.2:9200/_cluster/health')
            self.assertEqual(req.get_header('Authorization'), 'Basic ZWxhc3RpYzpEdW1teVNlY3JldA==')
            self.assertIs(opener, p.LOCAL_AUTH_OPENER)
            return 200, {'status': 'red', 'unassigned_shards': 35}, 1
        with patch.object(p, 'get_json', get):
            check = p.role_services({'es': container('docker.elastic.co/elasticsearch/elasticsearch:8', env=['ELASTIC_PASSWORD=DummySecret'])})[0]
        self.assertFalse(check['ok'])
        self.assertNotIn('DummySecret', json.dumps(check))
        self.assertIsNone(p.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://external.invalid'))

    def test_insight_devnet_decodes_public_output_locally(self):
        def get(url):
            path = url.split('/insight-api/')[1]
            return {'status?q=getInfo': {'info': {'blocks': 42}}, 'sync': {'status': 'finished'},
                    'block-index/42': {'blockHash': 'block'}, 'block/block': {'height': 42, 'tx': ['tx']},
                    'tx/tx': {'txid': 'tx', 'vout': [{'scriptPubKey': {'hex': '76a914' + '00' * 20 + '88ac'}}]},
                    'addr/devnet-address?noTxList=1': {'addrStr': 'devnet-address'}}[path]
        def run(args, timeout):
            self.assertEqual(args[:2], ['dash-cli', 'decodescript'])
            return b'{"address":"devnet-address"}'
        with patch.object(p, 'http_json', get), patch.object(p, 'core_cli', return_value=(['dash-cli'], 'native')), patch.object(p, 'run', run):
            check = p.insight({'insight': container('dashpay/insight:latest')})
        self.assertTrue(check['query']['ok'])
        self.assertNotIn('devnet-address', json.dumps(check))


if __name__ == '__main__':
    unittest.main()
