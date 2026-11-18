"""Managed reset PV at the filesystem boundary; no Docker or live hosts."""
import ast
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock


class ManagedPVTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).with_name('reset-remote.py').read_text()
        tree = ast.parse(source)
        tree.body = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef))]
        self.ns = {'DM_HOME':Path('/fixture')}
        exec(compile(tree, '<managed-reset>', 'exec'), self.ns)
        self.ns['Q'] = {'genesisProtocolVersion':15, 'anchorHeight':123, 'images':{'tenderdash':'dashpay/tenderdash:new'}}

    def test_optional_pv_and_invalid_values(self):
        genesis = {'chain_id':'preserved','consensus_params':{'version':{'app_version':'14'}}}
        self.ns['Q'].pop('genesisProtocolVersion')
        self.assertEqual(self.ns['genesis_protocol'](genesis)['consensus_params']['version']['app_version'],'14')
        self.ns['Q']['genesisProtocolVersion'] = 15
        self.assertEqual(self.ns['genesis_protocol'](genesis)['consensus_params']['version']['app_version'],'15')
        for pv in [0, -1, True, '15', 1.5, 4294967296]:
            self.ns['Q']['genesisProtocolVersion'] = pv
            with self.assertRaisesRegex(self.ns['Fail'],'Platform version'):
                self.ns['genesis_protocol'](genesis)

    def test_seed_apply_matches_validator_pv_preserving_identity_and_other_genesis_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / 'tenderdash/config'
            config.mkdir(parents=True)
            genesis = {'chain_id':'preserved','genesis_time':'preserved','initial_core_chain_locked_height':1,
                       'consensus_params':{'version':{'app_version':'14'},'block':{'max_bytes':'123'}}}
            (config/'genesis.json').write_text(json.dumps(genesis))
            (config/'node_key.json').write_text('{"fixture":"same"}')
            compose = root/'docker-compose.yml'
            compose.write_text('services:\n  tenderdash:\n    image: dashpay/tenderdash:old\n')
            self.ns.update(ROLE='seed',SEED=root,SEED_COMPOSE=compose,
                           load_json=lambda _: {'nodeKey':self.ns['sha'](config/'node_key.json')},preserved=Mock())
            self.ns['apply']()
            result = json.loads((config/'genesis.json').read_text())
            genesis['initial_core_chain_locked_height'] = 123
            genesis['consensus_params']['version']['app_version'] = '15'
            self.assertEqual(result,genesis)
            self.assertIn('dashpay/tenderdash:new',compose.read_text())
            self.ns['preserved'].assert_called_once()


if __name__ == '__main__':
    unittest.main()
