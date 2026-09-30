import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('observer', Path(__file__).with_name('mainnet-observer.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ObserverTest(unittest.TestCase):
    def test_tenderdash_bare_and_enveloped(self):
        value = {'sync_info': {'latest_block_height': '10', 'latest_block_time': '2026-09-30T08:00:00Z', 'catching_up': True}, 'node_info': {'network': 'evo1'}}
        for body in [value, {'result': value}]:
            self.assertEqual(m.parse_platform(body)['height'], 10)
            self.assertTrue(m.parse_platform(body)['catchingUp'])
        with self.assertRaises(KeyError):
            m.parse_platform({'error': 'unavailable'})

    def test_progress_clocks_are_independent_and_persist_across_polls(self):
        state = {}
        for now in range(10000, 11900, 60):
            report, state = m.signals({'blocks': 10, 'ibd': False}, {'height': now, 'catchingUp': False}, state, now)
        self.assertTrue(report['coreStall'])
        self.assertFalse(report['platformStall'])
        report, state = m.signals({'blocks': 11, 'ibd': False}, {'height': 12000, 'catchingUp': False}, state, 11920)
        self.assertFalse(report['coreStall'])
        report, _ = m.signals({'blocks': 11, 'ibd': False}, None, state, 15000)
        self.assertIsNone(report['coreStall'], 'sampling gap is not proof of a chain stall')
        self.assertIsNone(report['platformStall'])

    def test_syncing_never_claims_chain_stall(self):
        state = {}
        for now in range(10000, 11900, 60):
            report, state = m.signals({'blocks': 0, 'ibd': True}, {'height': 10, 'catchingUp': True}, state, now)
        self.assertIsNone(report['coreStall'])
        self.assertIsNone(report['platformStall'])

    def test_new_bans_not_historical_total_or_missing_sample(self):
        report, state = m.signals({'blocks': 5, 'ibd': False, '_banned': ['a']}, None, {}, 10000)
        self.assertEqual(report['bigBans'], 1)
        self.assertIsNone(report['newBans'])
        report, state = m.signals({'blocks': 6, 'ibd': False, '_banned': ['a', 'b']}, None, state, 10060)
        self.assertEqual(report['newBans'], 1)
        report, state = m.signals(None, None, state, 10120)
        self.assertIsNone(report['bigBans'])
        report, _ = m.signals({'blocks': 7, 'ibd': False, '_banned': ['a', 'b']}, None, state, 10180)
        self.assertIsNone(report['newBans'])

    def test_one_source_failure_does_not_hide_other_signals(self):
        with patch.object(m, 'containers', return_value=[]), patch.object(m, 'core_status', side_effect=ValueError('private value')), patch.object(m, 'platform_status', return_value={'height': 10, 'catchingUp': False}), patch.object(m, 'quorum_status', return_value={'status': 200}):
            report, _ = m.collect({}, 10000)
        self.assertIsNone(report['core'])
        self.assertEqual(report['platform']['height'], 10)
        self.assertEqual(report['errors'], ['Core: ValueError'])

    def test_container_selection_cannot_match_another_project_or_service(self):
        with patch.object(m, 'run', return_value='') as run:
            with self.assertRaises(RuntimeError):
                m.containers()
            self.assertIn('label=com.docker.compose.project=' + m.PROJECT, run.call_args.args[0])
        with self.assertRaises(RuntimeError):
            m.find([{'name': 'other-dashd-1'}], 'core')


if __name__ == '__main__':
    unittest.main()
