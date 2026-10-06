import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('explorer_chain', Path(__file__).with_name('explorer-chain.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Fake(m.Explorer):
    def __init__(self, root):
        super().__init__('devnet-test/wallet-001', 'dash-devnet-test', root)
        self.db = 'old_index'
        self.hash = 'a' * 64
        self.dbs = {'old_index': 'b' * 64}
        self.calls = []
        self.spec = {'services': {s: {'image': 'fork:' + s, 'environment': {'KEEP': 'yes'}} for s in m.SERVICES}}
        self.containers = {s: {'Image': 'sha256:' + s} for s in m.SERVICES}
        self.fail_migration = False
        self.path.write_text(json.dumps(self.spec))

    def inventory(self):
        self.spec = json.loads(self.path.read_text())
        return {'installed': True, 'database': self.db}

    def identity(self):
        return self.hash

    def first(self, db):
        return self.dbs.get(db, '')

    def sql(self, db, query):
        self.calls.append(query)
        if query.startswith('SELECT 1 FROM pg_database'):
            return '1' if query.split("'")[1] in self.dbs else ''
        if query.startswith('CREATE DATABASE'):
            self.dbs[query.split('"')[1]] = ''
            return ''
        if 'count(*)' in query:
            return '1' if self.dbs[db] else '0'
        raise AssertionError(query)

    def backup(self, directory, db):
        self.calls.append(('backup', db))
        directory.mkdir(parents=True)

    def compose(self, *args):
        self.calls.append(args)
        if 'explorer-indexer' in args and args[0] == 'up':
            self.db = self.spec['services']['explorer-indexer']['environment']['POSTGRES_DB']
            self.dbs[self.db] = self.hash

    def run(self, args, **kwargs):
        if args[:2] == ['docker', 'wait']:
            return '1' if self.fail_migration else '0'
        raise AssertionError(args)

    def verify(self, first_hash):
        self.calls.append(('verify', self.db))
        assert self.dbs[self.db] == first_hash
        return {'database': self.db, 'firstBlock': first_hash, 'indexed': 8, 'chain': 8}


class ExplorerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.e = Fake(Path(self.tmp.name))

    def test_changed_chain_is_backed_up_and_rotated_without_deleting_old_index(self):
        result = self.e.reconcile()
        self.assertEqual(result['database'], 'pe_chain_' + 'a' * 24)
        self.assertEqual(self.e.dbs['old_index'], 'b' * 64)
        self.assertEqual(self.e.calls.count(('backup', 'old_index')), 1)
        for service in m.SERVICES:
            self.assertEqual(self.e.spec['services'][service]['image'], 'sha256:' + service)
            self.assertEqual(self.e.spec['services'][service]['environment']['KEEP'], 'yes')
        self.assertFalse(any('DROP' in str(c) or 'TRUNCATE' in str(c) for c in self.e.calls))
        self.assertTrue((self.e.record / ('a' * 64) / 'compose.before.json').exists())
        self.e.calls.clear()
        self.e.reconcile()
        self.assertEqual(self.e.calls, [('verify', self.e.db)])

    def test_failed_migration_resumes_same_database_and_backup(self):
        self.e.fail_migration = True
        with self.assertRaisesRegex(RuntimeError, 'migration failed'):
            self.e.reconcile()
        self.assertFalse(any(c[0] == 'verify' for c in self.e.calls if isinstance(c, tuple)))
        self.e.fail_migration = False
        self.e.reconcile()
        self.assertEqual(self.e.calls.count(('backup', 'old_index')), 1)
        self.assertEqual(sum(str(c).startswith('CREATE DATABASE') for c in self.e.calls), 1)
        self.assertEqual(self.e.dbs['old_index'], 'b' * 64)

    def test_same_chain_adopts_current_database_without_rebuild(self):
        self.e.dbs['old_index'] = self.e.hash
        self.e.reconcile()
        self.assertEqual(self.e.calls, [('verify', 'old_index')])

    def test_services_redeploy_keeps_hotfix_and_rotated_db(self):
        old = {'services': {'explorer-indexer': {'image': 'sha256:fork', 'environment': {'POSTGRES_DB': 'pe_new'}}, 'faucet': {'image': 'old'}}}
        new = {'services': {'explorer-indexer': {'image': 'upstream:old'}, 'faucet': {'image': 'new'}}}
        result = m.retained_explorer(old, new)
        self.assertEqual(result['services']['explorer-indexer'], old['services']['explorer-indexer'])
        self.assertEqual(result['services']['faucet']['image'], 'new')
        result['services']['explorer-indexer']['environment']['POSTGRES_DB'] = 'changed'
        self.assertEqual(old['services']['explorer-indexer']['environment']['POSTGRES_DB'], 'pe_new')

    def test_standard_release_upgrade_preserves_rotated_database(self):
        old = {'services': {'explorer-indexer': {'image': 'ghcr.io/pshenmic/platform-explorer-indexer:2.5.3', 'environment': {'POSTGRES_DB': 'pe_current'}}}}
        new = {'services': {'explorer-indexer': {'image': 'ghcr.io/pshenmic/platform-explorer-indexer:3.0'}}}
        result = m.retained_explorer(old, new)
        self.assertTrue(result['services']['explorer-indexer']['image'].endswith(':3.0'))
        self.assertEqual(result['services']['explorer-indexer']['environment']['POSTGRES_DB'], 'pe_current')

    def test_mainnet_and_unknown_ownership_refused(self):
        with self.assertRaises(RuntimeError):
            m.Explorer('mainnet/wallet-001', 'dash-mainnet')
        with self.assertRaises(RuntimeError):
            m.Explorer('devnet-x/wallet-001', 'dash-mainnet')


if __name__ == '__main__':
    unittest.main()
