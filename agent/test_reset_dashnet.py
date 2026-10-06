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

    def test_release_rpc_migrations_are_automatic_but_identity_and_credentials_are_preserved(self):
        before = {'rpc': {'users': {'drive_consensus': {'password':'test-only', 'whitelist':['getblockhash']}}},
                  'docker': {'image':'pinned-core'}, 'devnet': {'name':'sakura'}}
        after = json.loads(json.dumps(before))
        after['rpc']['users']['drive_consensus']['whitelist'].append('getspecialtxes')
        self.assertEqual(mod.Reset.core_changes(before, after), [{'user':'drive_consensus','added':['getspecialtxes'],'removed':[]}])
        for path, value in [('password','changed'), ('whitelist', None)]:
            broken = json.loads(json.dumps(after))
            broken['rpc']['users']['drive_consensus'][path] = value
            with self.assertRaises(mod.Fail):
                mod.Reset.core_changes(before, broken)
        after['devnet']['name'] = 'different-chain'
        with self.assertRaisesRegex(mod.Fail, 'preserved Core identity'):
            mod.Reset.core_changes(before, after)

    def test_template_rpc_compatibility_flags_migrate_without_relaxing_data_or_auth_guards(self):
        before = b'datadir=/data\nrpcauth=user:verified\nrpcwhitelist=drive:getblockhash\n'
        after = before + b'# Release compatibility\ndeprecatedrpc=masternode_list_v0\n'
        self.assertEqual(mod.Reset.core_compatibility_options(before, after), [{'option':'deprecatedrpc','added':['masternode_list_v0'],'removed':[]}])
        for setting in [b'datadir=/different', b'rpcpassword=changed', b'rpcbind=0.0.0.0', b'reindex=1']:
            with self.assertRaisesRegex(mod.Fail, 'preserved chain, data, credentials'):
                mod.Reset.core_compatibility_options(before, after + setting + b'\n')

    def test_core_migration_changes_only_reviewed_config_keeps_data_and_resumes(self):
        node = self.r.node
        self.r.q['coreChain'] = 'devnet-sakura'
        doc = {'configs': {node: {'core': {'rpc': {'users': {}}}}}}
        mod.write(self.r.home / 'config.json', doc)
        live = self.r.config / 'core/dash.conf'
        live.parent.mkdir(parents=True)
        live.write_text('rpcwhitelist=drive:getblockhash\n')
        overrides = {'services': {'core': {'labels': {'dashnet.config':'old'}}}}
        mod.write(self.r.home / '.dashnet-compose.json', overrides)
        stage = self.r.state / 'render'
        mod.write(stage / 'config.json', doc)
        changed = stage / node / 'core/dash.conf'
        changed.parent.mkdir(parents=True)
        changed.write_text('rpcwhitelist=drive:getblockhash,getspecialtxes\n')
        prepared = {'coreMigration':[{'user':'drive','added':['getspecialtxes'],'removed':[]}],
                    'coreFiles':[f'{node}/core/dash.conf'], 'coreFingerprints': {'core':'new'},
                    'files': {str(p.relative_to(stage)):mod.digest(p) for p in stage.rglob('*') if p.is_file()}}
        mod.write(self.r.state / 'prepared.json', prepared)
        mod.write(self.r.state / 'wipe-started.json', {})
        b = {'journal': {'preservation': {'coreConfig':'old-config','coreGenesis':'genesis'}}, 'preserve':{}}
        mod.write(self.r.state / 'baseline.json', b)
        core = {'Id':'old-core', 'State':{'Running':True}, 'Config':{'Labels':{'dashnet.config':'old'}}}
        owned = {'core':core}; calls=[]
        def compose(_home, *args):
            calls.append(('compose',args))
            owned['core']={'Id':'new-core','State':{'Running':True},'Config':{'Labels':{'dashnet.config':'new'}}}
        def rpc(method, *_):
            return {'getblockchaininfo':{'chain':'devnet-sakura','initialblockdownload':False},
                    'getblockhash':'genesis','mnsync':{'IsSynced':True},'masternode':{'state':'READY'},
                    'getconnectioncount':8,'getpeerinfo':[], 'protx':[], 'quorum':{'quorumConnections':[]}}[method]
        clock=iter(range(0,10000,31))
        journal={'preservation':{'coreConfig':mod.digest(changed),'coreId':'new-core'}}
        with patch.object(self.r,'preserved'), patch.object(self.r,'migration_guard'), \
             patch.object(self.r,'owned_optional',side_effect=lambda:owned), patch.object(self.r,'compose',side_effect=compose), \
             patch.object(self.r,'rpc',side_effect=rpc), patch.object(self.r,'journal_baseline',return_value=journal), \
             patch.object(self.r,'snapshot',return_value={'new':'snapshot'}), patch.object(mod.os,'chown'), \
             patch.object(mod.time,'monotonic',side_effect=lambda:next(clock)), patch.object(mod.time,'sleep'), \
             patch.object(mod,'run',side_effect=lambda args,**_:calls.append(('run',args))):
            first=self.r.core_migrate()
            second=self.r.core_migrate()
        self.assertTrue(first['migrated'] and second['migrated'])
        self.assertEqual(live.read_text(), changed.read_text())
        self.assertEqual(len([x for x in calls if x[0]=='compose']),1,'lost response resumes without restarting Core again')
        self.assertEqual([x for x in calls if x[0]=='run'], [('run',['docker','stop','--time','120','old-core'])])
        self.assertEqual(mod.read(self.r.state/'baseline.json'),b,'original preservation evidence retained')
        self.assertEqual(mod.read(self.r.state/'baseline-effective.json')['journal'],journal)
        self.assertEqual(mod.read(self.r.state/'core-migration.json')['phase'],'complete')

    def test_mining_pause_has_recovery_timer_and_resume_is_idempotent(self):
        self.r.q['role']='wallet'
        miner={'Id':'owned-miner','State':{'Running':True,'Paused':False}}
        calls=[]
        def run(args,**_):
            calls.append(args)
            if args[:2]==['docker','pause']: miner['State']['Paused']=True
            if args[:2]==['docker','unpause']: miner['State']['Paused']=False
            if args[:2]==['systemctl','show']: return 'loaded'
            return ''
        with patch.object(self.r,'miner',side_effect=lambda:miner), patch.object(self.r,'rpc',return_value=13), \
             patch.object(mod,'run',side_effect=run), patch.object(mod.time,'sleep'):
            self.assertTrue(self.r.mining_pause()['quiet'])
            self.assertTrue(self.r.mining_pause()['quiet'])
            self.assertTrue(self.r.mining_resume()['resumed'])
            self.assertTrue(self.r.mining_resume()['resumed'])
        self.assertIn('--on-active=15m',calls[0])
        self.assertEqual(calls[0][-3:],['/usr/bin/docker','unpause','owned-miner'])
        self.assertEqual(len([c for c in calls if c[:2]==['docker','unpause']]),1)
        self.assertEqual(len([c for c in calls if c[:2]==['systemctl','restart']]),1,'retry renews mining recovery lease')
        self.assertFalse(miner['State']['Paused'])
        calls.clear()
        with patch.object(self.r,'miner',return_value=miner), patch.object(self.r,'rpc',return_value=3), patch.object(mod,'run',side_effect=run):
            self.assertFalse(self.r.mining_pause()['quiet'])
        self.assertEqual(calls,[],'active DKG window never pauses mining')

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
