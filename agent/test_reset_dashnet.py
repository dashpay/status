"""Contract tests: real filesystem metadata with a fake Docker boundary.

No live containers or volumes are changed by these tests.
"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_reset', Path(__file__).with_name('reset-dashnet.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class ResetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.r = mod.Reset({'exec': '11111111-1111-4111-8111-111111111111', 'node': 'validators-001',
                            'config': 'devnet-sakura', 'anchorHeight': 123}, self.root / 'host', self.root / 'state')
        self.r.state.mkdir(parents=True)

    def containers(self):
        return {s: {'Id': s, 'Mounts': [{'Type': 'volume', 'Name': s+'-volume', 'Destination': d}]}
                for s,d in mod.DATA_MOUNTS.items()}

    def test_refuses_shared_or_bind_mounted_chain_data(self):
        cs = self.containers()
        with patch.object(self.r, 'all_containers', return_value=list(cs.values())):
            self.assertEqual(set(self.r.data_volumes(cs).values()), {'drive_abci-volume','drive_tenderdash-volume'})
        intruder = {'Id': 'core', 'Mounts': [{'Name': 'drive_abci-volume'}]}
        with patch.object(self.r, 'all_containers', return_value=[*cs.values(), intruder]):
            with self.assertRaisesRegex(mod.Fail, 'shared'):
                self.r.data_volumes(cs)
        cs['drive_abci']['Mounts'][0]['Type'] = 'bind'
        with self.assertRaisesRegex(mod.Fail, 'unsupported'):
            self.r.data_volumes(cs)

    def test_wipe_only_removes_reviewed_platform_data_volumes_not_core_or_logs(self):
        cs = self.containers()
        b = {'platform': {s: {'id': c['Id']} for s,c in cs.items()}, 'volumes': {s:s+'-volume' for s in cs}}
        mod.write(self.r.state / 'prepared.json', {'images':{},'files':{},'platform':{}})
        mod.write(self.r.state / 'wipe-started.json', {})
        calls, compose = [], []
        def run(args, **_):
            calls.append(args)
            return 'drive_abci-volume\ndrive_tenderdash-volume\ncore-data\ndrive-logs\n'
        with patch.object(self.r, 'desired', return_value={}), patch.object(self.r, 'baseline_record', return_value=b), patch.object(self.r, 'preserved'), \
             patch.object(self.r, 'owned', return_value=cs), patch.object(self.r, 'rpc', return_value={'state':'READY'}), \
             patch.object(self.r, 'compose', side_effect=lambda _, *args: compose.append(args)), patch.object(mod, 'run', side_effect=run):
            self.r.wipe()
        self.assertEqual(compose, [('stop', 'drive_abci','drive_tenderdash'), ('rm','--force','drive_abci','drive_tenderdash')])
        self.assertEqual([c for c in calls if c[:3] == ['docker','volume','rm']], [
            ['docker','volume','rm','drive_abci-volume'], ['docker','volume','rm','drive_tenderdash-volume']])

    def test_core_drift_stops_wipe_before_any_docker_command(self):
        with patch.object(self.r, 'baseline_record', return_value={'preserve': 'original'}), \
             patch.object(self.r, 'snapshot', return_value='changed'), patch.object(mod, 'run') as run:
            with self.assertRaisesRegex(mod.Fail, 'changed since preparation'):
                self.r.wipe()
            run.assert_not_called()

    def test_apply_keeps_core_ssl_and_writes_continuity_metadata(self):
        stage = self.r.state / 'render'
        files = {
            'config.json': '{}', '.envs': 'UNCHANGED=1', '.dashnet-compose.json': '{}',
            'validators-001/core/dash.conf': 'rendered salted core',
            'validators-001/platform/gateway/ssl/private.key': 'not-a-real-key-staged',
            'validators-001/platform/drive/tenderdash/genesis.json': '{"initial_core_chain_locked_height":123}',
            'validators-001/platform/drive/tenderdash/node_key.json': '{"test":"identity"}',
        }
        for name, data in files.items():
            for base in [stage, self.r.home]:
                p = base / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(data)
        core = self.r.config / 'core/dash.conf'
        ssl = self.r.config / 'platform/gateway/ssl/private.key'
        core.write_text('live exact core'); ssl.write_text('live mock certificate key')
        mod.write(self.r.state / 'prepared.json', {'anchor':123,'files':{name:mod.digest(stage/name) for name in files}})
        mod.write(self.r.state / 'wipe-started.json', {})
        mod.write(self.r.root / 'platform/inputs.json', {'genesisCoreHeight':1,'peers':['same']})
        with patch.object(self.r, 'baseline_record', return_value={}), patch.object(self.r, 'preserved'):
            self.r.apply()
        self.assertEqual(core.read_text(), 'live exact core')
        self.assertEqual(ssl.read_text(), 'live mock certificate key')
        self.assertEqual(mod.read(self.r.root / 'platform/inputs.json'), {'genesisCoreHeight':123,'peers':['same']})
        self.assertEqual(mod.read(self.r.root / 'platform/identity.json'), {n:mod.digest(self.r.td/n) for n in ['genesis.json','node_key.json']})
        (stage / '.envs').write_text('tampered')
        with patch.object(self.r, 'baseline_record', return_value={}), patch.object(self.r, 'preserved'):
            with self.assertRaisesRegex(mod.Fail, 'prepared files changed'):
                self.r.apply()

    def test_target_helper_core_migration_stops_before_canary_or_wipe(self):
        doc = {'configs': {'validators-001': {'core': {'rpc': {'users': {
            'drive_consensus': {'whitelist': ['getblockhash']}}}}}}}
        mod.write(self.r.home / 'config.json', doc)
        b = {'configHash': mod.digest(self.r.home / 'config.json'), 'helper': 'old'}
        def migrate(stage, action):
            self.assertEqual(action, 'migrate')
            value = mod.read(stage / 'config.json')
            value['configs']['validators-001']['core']['rpc']['users']['drive_consensus']['whitelist'].append('getspecialtxes')
            mod.write(stage / 'config.json', value)
        with patch.object(self.r, 'baseline_record', return_value=b), patch.object(self.r, 'preserved'), \
             patch.object(self.r, 'desired', return_value={'helper':'new'}), patch.object(self.r, 'helper', side_effect=migrate), \
             patch.object(mod.os, 'chown'), patch.object(mod, 'run') as run:
            with self.assertRaisesRegex(mod.Fail, 'Core RPC whitelist migration'):
                self.r.render()
            run.assert_not_called()
        self.assertEqual(mod.read(self.r.home / 'config.json'), doc)
        self.assertFalse((self.r.state / 'prepared.json').exists())
        self.assertFalse((self.r.state / 'wipe-started.json').exists())

    def test_prepared_target_drift_refused_before_destructive_commands(self):
        mod.write(self.r.state / 'prepared.json', {'images': {'drive':'old'}, 'files':{}})
        with patch.object(self.r, 'baseline_record', return_value={}), patch.object(self.r, 'preserved'), \
             patch.object(self.r, 'desired', return_value={'drive':'new'}), patch.object(mod, 'run') as run:
            with self.assertRaisesRegex(mod.Fail, 'target images changed'):
                self.r.wipe()
            run.assert_not_called()

    def test_command_errors_do_not_leak_rpc_or_compose_secrets(self):
        class Result:
            returncode = 1
            stdout = b'password=secret'
            stderr = b'rpcpassword=secret'
        with patch.object(mod.subprocess, 'run', return_value=Result()):
            with self.assertRaisesRegex(mod.Fail, '^docker failed \\(exit 1\\)$'):
                mod.run(['docker','compose','config'])


if __name__ == '__main__':
    unittest.main()
