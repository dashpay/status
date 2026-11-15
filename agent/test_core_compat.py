"""The Core-facing code against a real dashd, one image per run.

Fixtures cannot show that a new Core version changed an RPC, a default or an
error. This starts the image named by CORE_COMPAT_IMAGE as a lone regtest node
and runs the code that talks to Core in production: the read-only probe for
every role, and the faucet wallet setup and funding of the service installer.
CI runs it once per supported Core major (.github/workflows/core-compat.yml),
and it can be dispatched by hand against any tag, such as a release candidate.

Without CORE_COMPAT_IMAGE the whole module is skipped, so the ordinary test
runs need neither Docker nor a network. A lone regtest node has no masternodes,
quorums or ChainLocks: the registered-masternode paths are checked only as far
as "the RPC exists and fails for that reason".
"""
import ast
import base64
import importlib.util
import json
import os
import re
import secrets
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
IMAGE = os.environ.get('CORE_COMPAT_IMAGE', '')
IMAGE_OK = re.fullmatch(r'(docker\.io/)?dashpay/dashd(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})', IMAGE)
CONF = '/etc/dash/dash.conf'   # where dash-network-go deployments mount it
RPC_PORT = 19898
# RPC names that are not Dash Core's (Tenderdash) or are exercised separately.
NOT_CORE = {'status', 'genesis', 'help'}

spec = importlib.util.spec_from_file_location('probe', HERE / 'probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def sh(*args, timeout=180):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def rpcs_used():
    """Every Core RPC the agent scripts name, read from the scripts themselves so
    a newly added call is covered without touching this test."""
    names = set()
    for path in sorted(HERE.glob('*.py')):
        if path.name.startswith('test_') or path.name == 'explorer-chain.py':
            continue
        text = path.read_text()
        for pattern in [r"\b(?:rpc|call)\(\s*'([a-z]+)'", r"\bcall,\s*'([a-z]+)'", r"\bcall,\s*'-rpcwallet='\s*\+\s*\w+,\s*'([a-z]+)'",
                        r"\bcore_cli\(\s*\w+,\s*'([a-z]+)'"]:
            names.update(re.findall(pattern, text))
    return sorted(names - NOT_CORE)


def service_functions(namespace):
    """The service installer configures a wallet host when imported, so only its
    Core RPC client and faucet functions are loaded (as agent/faucet.test.js
    does), here bound to the real node instead of a scripted one."""
    path = HERE / 'services-remote.py'
    wanted = {'rpc', 'fund_faucet', 'faucet_wallet', 'MAX_INPUTS', 'FEE_PER_KB'}
    tree = ast.parse(path.read_text())
    keep = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in wanted)
            or (isinstance(n, ast.Assign) and any(getattr(t, 'id', None) in wanted for t in n.targets))]
    assert {getattr(n, 'name', None) or n.targets[0].id for n in keep} == wanted, 'services-remote.py no longer defines the faucet functions'
    exec(compile(ast.Module(body=keep, type_ignores=[]), str(path), 'exec'), namespace)
    return namespace


@unittest.skipUnless(IMAGE, 'set CORE_COMPAT_IMAGE to a dashpay/dashd image to run against a real node')
class CoreCompat(unittest.TestCase):
    summary = {}

    @classmethod
    def setUpClass(cls):
        if not IMAGE_OK:
            raise AssertionError('CORE_COMPAT_IMAGE must be a dashpay/dashd image reference, got %r' % IMAGE)
        cls.work = tempfile.TemporaryDirectory()
        cls.password = secrets.token_hex(16)
        conf = Path(cls.work.name) / 'dash.conf'
        conf.write_text('\n'.join(['regtest=1', 'server=1', 'listen=0', 'dnsseed=0', 'printtoconsole=1', 'fallbackfee=0.0001',
                                   'rpcuser=dashnet', 'rpcpassword=' + cls.password, 'rpcallowip=0.0.0.0/0',
                                   '[regtest]', 'rpcbind=0.0.0.0', 'rpcport=%d' % RPC_PORT, '']))
        # The node runs as the image's own user and reads this through the mount.
        conf.chmod(0o644)
        os.chmod(cls.work.name, 0o755)
        cls.name = 'core-compat-' + secrets.token_hex(4)
        started = sh('docker', 'run', '-d', '--name', cls.name, '-p', '127.0.0.1:%d:%d' % (RPC_PORT, RPC_PORT),
                     '-v', '%s:%s:ro' % (conf, CONF), IMAGE, 'dashd', '-conf=' + CONF)
        if started.returncode:
            raise AssertionError('could not start %s: %s' % (IMAGE, started.stderr.strip()[-500:]))
        deadline = time.time() + 120
        while sh('docker', 'exec', cls.name, 'dash-cli', '-conf=' + CONF, 'getblockchaininfo').returncode:
            if time.time() > deadline:
                logs = sh('docker', 'logs', '--tail', '40', cls.name)
                raise AssertionError('%s did not answer RPC within two minutes:\n%s%s' % (IMAGE, logs.stdout[-3000:], logs.stderr[-3000:]))
            time.sleep(2)

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, 'name', None):
            sh('docker', 'rm', '-f', cls.name)
        if getattr(cls, 'work', None):
            cls.work.cleanup()
        if cls.summary:
            print('\ncore-compat ' + json.dumps(cls.summary, sort_keys=True), flush=True)

    def cli(self, *args, wallet=None):
        """dash-cli in the container. Returns (value, None) or (None, error text)."""
        cmd = ['docker', 'exec', self.name, 'dash-cli', '-conf=' + CONF] + (['-rpcwallet=' + wallet] if wallet else []) + [str(a) for a in args]
        p = sh(*cmd)
        if p.returncode:
            return None, (p.stderr or p.stdout).strip()[-400:]
        try:
            return json.loads(p.stdout), None
        except ValueError:
            return p.stdout.strip(), None

    def ok(self, *args, wallet=None):
        value, error = self.cli(*args, wallet=wallet)
        self.assertIsNone(error, '%s failed on %s: %s' % (' '.join(map(str, args)), IMAGE, error))
        return value

    def run_probe(self, role):
        """probe.core() exactly as the collector runs it for a host of this role."""
        probe.ROLE = role
        del probe.errors[:]
        _, raw = probe.docker()
        out = probe.core(raw)
        self.assertIsInstance(out, dict, 'the probe did not find the Core container')
        return out, list(probe.errors)

    def assert_only(self, errors, allowed, role):
        unexpected = [e for e in errors if not e.startswith(tuple(allowed))]
        self.assertEqual(unexpected, [], 'probe role %s reported errors other than those a lone regtest node explains (%s)' % (role, IMAGE))

    def test_1_image_is_the_version_it_claims(self):
        net = self.ok('getnetworkinfo')
        self.assertIsInstance(net.get('version'), int)
        self.assertIsInstance(net.get('subversion'), str)
        self.summary.update(image=IMAGE, version=net['version'], subversion=net['subversion'])
        major = re.search(r'dashd:(\d+)(?:[.-]|$)', IMAGE)
        if major:
            self.assertEqual(net['version'] // 10000, int(major.group(1)), 'the image tag and the running Core disagree')
        self.assertEqual(self.ok('getblockchaininfo').get('chain'), 'regtest')

    def test_2_every_rpc_the_scripts_call_still_exists(self):
        names = rpcs_used()
        # A guard on the scan itself: an empty list would pass vacuously.
        for expected in ['getblockchaininfo', 'getnetworkinfo', 'masternode', 'quorum', 'protx', 'mnsync', 'createwallet', 'listunspent', 'getbalances']:
            self.assertIn(expected, names)
        missing = [n for n in names if re.match(r'help: unknown command', str(self.ok('help', n)))]
        self.assertEqual(missing, [], 'RPCs the agent scripts call that %s does not have' % IMAGE)
        self.summary['rpcs'] = len(names)
        # Sub-commands and argument forms exactly as the scripts pass them.
        self.assertIsInstance(self.ok('mnsync', 'status'), dict)
        self.assertIsInstance(self.ok('quorum', 'list'), dict)
        self.assertIsInstance(self.ok('quorum', 'dkgstatus', '0'), dict)
        self.assertIsInstance(self.ok('quorum', 'dkgstatus'), dict)
        self.assertIsInstance(self.ok('getmempoolinfo').get('size'), int)
        self.assertIsInstance(self.ok('getpeerinfo'), list)
        # These need a registered masternode or a ChainLock. They must exist and
        # fail for that reason, not as an unknown method or a rejected argument.
        for args, reason in [(('masternode', 'status'), r'(?i)active masternode|not a masternode'), (('getbestchainlock',), r'(?i)chainlock')]:
            value, error = self.cli(*args)
            if error is not None:
                self.assertRegex(error, reason, '%s on %s' % (' '.join(args), IMAGE))
            else:
                self.assertIsInstance(value, dict)

    def test_3_probe_reads_core_for_node_roles(self):
        for role in ['seed', 'fullnode', 'validator', 'masternode']:
            with self.subTest(role=role):
                out, errors = self.run_probe(role)
                self.assertEqual(out['chain'], 'regtest')
                for key in ['blocks', 'headers', 'version', 'protocol', 'connections', 'mempool', 'rpcLatencyMs']:
                    self.assertIsInstance(out.get(key), int, '%s for role %s' % (key, role))
                for key in ['subversion', 'bestBlockHash', 'source']:
                    self.assertIsInstance(out.get(key), str, key)
                self.assertIsInstance(out.get('ibd'), bool)
                self.assertIsInstance(out.get('synced'), bool, 'mnsync status')
                self.assertIsInstance(out.get('peerDiversity'), dict)
                if role == 'seed':
                    self.assertIsInstance(out.get('quorums'), dict)
                if role in ('validator', 'masternode'):
                    self.assertIsInstance(out.get('dkg'), list, 'quorum dkgstatus 0')
                self.assert_only(errors, ['core chainlock:'] + (['core masternode status:'] if role in ('validator', 'masternode') else []), role)

    def test_4_probe_reads_single_wallet_roles(self):
        # The deployment tool creates this wallet with Core's default type:
        # legacy up to Core 23, descriptor from Core 24.
        _, error = self.cli('createwallet', 'dashnet')
        self.summary['defaultCreatewallet'] = 'ok' if error is None else error[:200]
        if error is not None:
            self.ok('-named', 'createwallet', 'wallet_name=dashnet', 'load_on_startup=true')
        self.summary['dashnetWalletDescriptors'] = self.ok('getwalletinfo', wallet='dashnet').get('descriptors')
        address = self.ok('getnewaddress', wallet='dashnet')
        # Recorded, not asserted: nothing in this repository exports a key from
        # this wallet, but dash-network-go reads the spork key this way.
        _, error = self.cli('dumpprivkey', address, wallet='dashnet')
        self.summary['dumpprivkeyOnDefaultWallet'] = 'ok' if error is None else error[:200]
        for _ in range(40):
            self.ok('generatetoaddress', 10, address)
            if self.ok('getbalance', wallet='dashnet') >= 4000:
                break
        self.assertGreaterEqual(self.ok('getbalance', wallet='dashnet'), 4000, 'could not mine spendable regtest coins')
        type(self).address = address
        # The masternode list is defined from the first block on, so this is
        # checked here rather than at genesis.
        self.assertIsInstance(self.ok('protx', 'list', 'valid'), list)
        out, errors = self.run_probe('miner')
        self.assertIsInstance(out.get('mining'), dict)
        self.assertEqual([w['name'] for w in out.get('wallets', [])], ['dashnet'])
        self.assertIsInstance(out['wallets'][0].get('trusted'), (int, float))
        self.assert_only(errors, ['core chainlock:'], 'miner')
        out, errors = self.run_probe('mixer')
        self.assertIsInstance(out.get('coinjoin'), dict, 'getcoinjoininfo')
        self.assert_only(errors, ['core chainlock:'], 'mixer')

    def test_5_faucet_wallet_is_created_funded_and_exportable(self):
        logs = []
        ns = service_functions(dict(json=json, base64=base64, urllib=urllib, RPC_PORT=RPC_PORT, PASSWORD=self.password,
                                    opener=urllib.request.build_opener(urllib.request.ProxyHandler({})), cfg=dict(faucetFunding=3000), log=logs.append))
        rpc = ns['rpc']
        self.assertEqual(ns['faucet_wallet'](), 3000, 'faucet funding from the dashnet wallet; log: %s' % logs)
        self.assertIn('faucet', rpc('listwallets'))
        # dash-faucet reads its key with dumpprivkey, which only a legacy wallet
        # allows. Core 24 creates descriptor wallets unless told otherwise.
        self.assertIs(rpc('getwalletinfo', wallet='faucet').get('descriptors', False), False, 'the faucet wallet must be a legacy wallet')
        key = rpc('dumpprivkey', [rpc('getnewaddress', wallet='faucet')], wallet='faucet')
        self.assertRegex(key, r'^[1-9A-HJ-NP-Za-km-z]{50,53}$')
        # Confirmed or not, a second run must not fund again.
        self.ok('generatetoaddress', 1, self.address)
        self.assertEqual(ns['faucet_wallet'](), 3000)
        self.assertEqual(len([t for t in rpc('listtransactions', ['*', 1000], wallet='faucet') if t.get('category') == 'receive']), 20)
        # After a Core restart the wallet is loaded, never created again.
        rpc('unloadwallet', ['faucet'])
        self.assertNotIn('faucet', rpc('listwallets'))
        self.assertEqual(ns['faucet_wallet'](), 3000)
        self.assertIn('faucet', rpc('listwallets'))
        self.assertEqual(len([t for t in rpc('listtransactions', ['*', 1000], wallet='faucet') if t.get('category') == 'receive']), 20)

    def test_6_probe_reads_the_wallet_host(self):
        out, errors = self.run_probe('wallet')
        wallets = {w['name']: w for w in out.get('wallets', [])}
        self.assertEqual(sorted(wallets), ['dashnet', 'faucet'])
        self.assertEqual(wallets['faucet']['trusted'], 3000)
        self.assertIsInstance(out.get('quorums'), dict)
        self.assertIsInstance(out.get('payouts'), list)
        self.assert_only(errors, ['core chainlock:'], 'wallet')


if __name__ == '__main__':
    unittest.main()
