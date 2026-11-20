"""Public BIP32 vectors and fail-closed export tests; no live private material."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('devnet_keys', Path(__file__).with_name('devnet-keys.py'))
keys = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keys)

# https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki#test-vector-1
VECTORS = [
    'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
    'xprv9uHRZZhk6KAJC1avXpDAp4MDc3sQKNxDiPvvkX8Br5ngLNv1TxvUxt4cV1rGL5hj6KCesnDYUhd7oWgT11eZG7XnxHrnYeSvkzY7d2bhkJ7',
    'xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs',
    'xprv9z4pot5VBttmtdRTWfWQmoH1taj2axGVzFqSb8C9xaxKymcFzXBDptWmT7FwuEzG3ryjH4ktypQSAewRiNMjANTtpgP4mLTj34bhnZX7UiM',
    'xprvA2JDeKCSNNZky6uBCviVfJSKyQ1mDYahRjijr5idH2WwLsEd4Hsb2Tyh8RfQMuPh7f7RtyzTtdrbdqqsunu5Mm3wDvUAKRHSC34sJ7in334',
    'xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76',
]


def testnet_extended(vector):
    raw = keys.b58decode(vector)
    return keys.b58encode(bytes.fromhex('04358394') + raw[4:])


class Derivation(unittest.TestCase):
    def test_bip32_hardened_and_normal_children(self):
        raw = keys.b58decode(VECTORS[0])
        key, code = int.from_bytes(raw[46:], 'big'), raw[13:45]
        for index, expected in zip([2**31, 1, 2**31 + 2, 2, 1000000000], VECTORS[1:]):
            key, code = keys.child_key(key, code, index)
            expected = keys.b58decode(expected)
            self.assertEqual(key.to_bytes(32, 'big'), expected[46:])
            self.assertEqual(code, expected[13:45])

    def test_descriptor_from_master_and_account_roots(self):
        full_path = 'm/0h/1/2h/2/1000000000'
        master = 'pkh(' + testnet_extended(VECTORS[0]) + '/0h/1/2h/2/*)'
        account = 'pkh([3442193e/0h/1/2h]' + testnet_extended(VECTORS[3]) + '/2/*)'
        expected = b'\xef' + keys.b58decode(VECTORS[-1])[46:] + b'\x01'
        self.assertEqual(keys.b58decode(keys.descriptor_key(master, full_path)), expected)
        self.assertEqual(keys.b58decode(keys.descriptor_key(account, full_path)), expected)
        self.assertEqual(keys.descriptor_key(account, full_path.replace('h', "'")), keys.descriptor_key(master, full_path))

    def test_reject_wrong_chain_path_depth_and_script(self):
        root = testnet_extended(VECTORS[0])
        cases = [
            ('pkh(' + VECTORS[0] + '/0/*)', 'm/0/1'),
            ('pkh(' + root + '/0/*)', 'm/1/1'),
            ('pkh([3442193e/0h]' + root + '/0/*)', 'm/0h/0/1'),
            ('wpkh(' + root + '/0/*)', 'm/0/1'),
            ('pkh(' + root + '/0/*/*)', 'm/0/1/1'),
        ]
        for desc, path in cases:
            with self.assertRaises(AssertionError):
                keys.descriptor_key(desc, path)

    def test_base58_checksum_and_scalar_checks(self):
        with self.assertRaises(AssertionError):
            keys.b58decode(VECTORS[0][:-1] + '1')
        for scalar in [0, keys.ORDER]:
            with self.assertRaises(AssertionError):
                keys.public_key(scalar)


class Exports(unittest.TestCase):
    def rpc(self, method, params=None, wallet=None):
        self.calls.append((method, wallet))
        if method == 'getwalletinfo':
            return {'descriptors': self.descriptors}
        if method == 'dumpprivkey':
            return 'synthetic-private'
        if method == 'getaddressinfo':
            return {'ismine': self.owned, 'iswatchonly': False, 'hdkeypath': 'm/0h/1/2h/2/1000000000'}
        if method == 'listdescriptors':
            return {'descriptors': [{'desc': self.desc}] * self.match_count + [{'desc': d} for d in self.fixed]}
        if method == 'deriveaddresses':
            if len(params) == 2:  # Core independently identifies the parent.
                # Core: "Range should not be specified for an un-ranged descriptor" (-8).
                assert '*' in params[0], 'range given for a fixed descriptor'
                return ['synthetic-address']
            return [self.derived_address]
        if method == 'getdescriptorinfo':
            return {'hasprivatekeys': True, 'isrange': False, 'descriptor': 'pkh(synthetic-public)'}
        raise AssertionError('unexpected RPC')

    def setUp(self):
        self.calls = []
        self.descriptors = True
        self.owned = True
        self.match_count = 1
        self.fixed = []
        self.derived_address = 'synthetic-address'
        self.desc = 'pkh([3442193e/0h/1/2h]' + testnet_extended(VECTORS[3]) + '/2/*)'

    def test_descriptor_export_verifies_address_and_caches(self):
        export = keys.wallet_exporter(self.rpc)
        result = export('synthetic-address', 'dashnet')
        before = len(self.calls)
        self.assertEqual(export('synthetic-address', 'dashnet'), result)
        self.assertEqual(len(self.calls), before)
        self.assertEqual(keys.b58decode(result)[1:-1], keys.b58decode(VECTORS[-1])[46:])
        self.assertNotIn(('dumpprivkey', 'dashnet'), self.calls)

    def test_fixed_descriptor_beside_the_hd_parent_does_not_end_the_export(self):
        # An imported single key sits next to the ranged parent; it must never be probed with a range.
        self.fixed = ['pkh(synthetic-imported-key)#abcdefgh', 'pkh([3442193e/0h]' + testnet_extended(VECTORS[1]) + '/1)']
        result = keys.wallet_exporter(self.rpc)('synthetic-address', 'dashnet')
        self.assertEqual(keys.b58decode(result)[1:-1], keys.b58decode(VECTORS[-1])[46:])

    def test_legacy_wallet_remains_supported(self):
        self.descriptors = False
        self.assertEqual(keys.wallet_exporter(self.rpc)('synthetic-address', 'faucet'), 'synthetic-private')
        self.assertIn(('dumpprivkey', 'faucet'), self.calls)
        self.assertNotIn(('listdescriptors', 'faucet'), self.calls)

    def test_wrong_derived_address_rejected(self):
        self.derived_address = 'wrong-address'
        with self.assertRaises(AssertionError):
            keys.wallet_exporter(self.rpc)('synthetic-address', 'dashnet')

    def test_unowned_or_ambiguous_descriptor_rejected(self):
        self.owned = False
        with self.assertRaises(AssertionError):
            keys.wallet_exporter(self.rpc)('synthetic-address', 'dashnet')
        self.owned = True
        for count in [0, 2]:
            self.match_count = count
            with self.assertRaises(AssertionError):
                keys.wallet_exporter(self.rpc)('synthetic-address', 'dashnet')

    def test_spork_must_match_registered_address(self):
        self.derived_address = 'different-spork'
        with self.assertRaises(AssertionError):
            keys.verified_address(self.rpc, 'synthetic-spork', 'synthetic-address')


if __name__ == '__main__':
    unittest.main()
