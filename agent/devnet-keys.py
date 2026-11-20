#!/usr/bin/env python3
"""Read-only, identity-checked devnet key export; stdout is private transport only."""
import base64
import hashlib
import hmac
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.request


ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def b58encode(raw):
    data = raw + hashlib.sha256(hashlib.sha256(raw).digest()).digest()[:4]
    value, out = int.from_bytes(data, 'big'), ''
    while value:
        value, digit = divmod(value, 58)
        out = ALPHABET[digit] + out
    return '1' * (len(data) - len(data.lstrip(b'\0'))) + out


def b58decode(text):
    assert 0 < len(text) < 120
    value = 0
    for char in text:
        value = value * 58 + ALPHABET.index(char)
    data = b'\0' * (len(text) - len(text.lstrip('1'))) + value.to_bytes((value.bit_length() + 7) // 8, 'big')
    raw, checksum = data[:-4], data[-4:]
    assert hashlib.sha256(hashlib.sha256(raw).digest()).digest()[:4] == checksum
    return raw


def public_key(key):
    assert 0 < key < ORDER
    # OpenSSL handles secp256k1; the scalar is stdin only, never argv/files/errors.
    der = bytes.fromhex('302e0201010420') + key.to_bytes(32, 'big') + bytes.fromhex('a00706052b8104000a')
    result = subprocess.run(['openssl', 'ec', '-inform', 'DER', '-pubout', '-outform', 'DER', '-conv_form', 'compressed'],
                            input=der, capture_output=True, timeout=10)
    assert result.returncode == 0 and len(result.stdout) == 56
    pub = result.stdout[-33:]
    assert pub[0] in (2, 3)
    return pub


def child_key(key, chain_code, index):
    assert 0 <= index < 2 ** 32 and 0 < key < ORDER and len(chain_code) == 32
    data = b'\0' + key.to_bytes(32, 'big') if index >= 2 ** 31 else public_key(key)
    digest = hmac.new(chain_code, data + index.to_bytes(4, 'big'), hashlib.sha512).digest()
    left = int.from_bytes(digest[:32], 'big')
    child = (left + key) % ORDER
    assert left < ORDER and child != 0
    return child, digest[32:]


def path_parts(path):
    parts = []
    for item in path.split('/'):
        assert re.fullmatch(r"[0-9]+['hH]?", item)
        hardened = item[-1] in "'hH"
        value = int(item[:-1] if hardened else item)
        assert value < 2 ** 31
        parts.append(value + (2 ** 31 if hardened else 0))
    return parts


def descriptor_key(descriptor, hd_path):
    # Managed wallets use single-key P2PKH descriptors, not arbitrary scripts.
    match = re.fullmatch(r"pkh\((?:\[([0-9a-fA-F]{8})((?:/[0-9]+['hH]?)*?)\])?([1-9A-HJ-NP-Za-km-z]+)((?:/(?:[0-9]+['hH]?|\*))+?)\)(?:#[a-z0-9]{8})?", descriptor)
    assert match and hd_path.startswith('m/')
    origin = path_parts(match[2][1:]) if match[2] else []
    actual = path_parts(hd_path[2:])
    suffix = match[4][1:].split('/')
    assert suffix[-1] == '*' and suffix.count('*') == 1
    relative = path_parts('/'.join(suffix[:-1])) if len(suffix) > 1 else []
    assert actual == origin + relative + [actual[-1]] and actual[-1] < 2 ** 31
    raw = b58decode(match[3])
    # Test/devnet extended private key, exact depth/origin, never Mainnet.
    assert len(raw) == 78 and raw[:4] == bytes.fromhex('04358394') and raw[4] == len(origin) and raw[45] == 0
    key, code = int.from_bytes(raw[46:], 'big'), raw[13:45]
    for index in relative + [actual[-1]]:
        key, code = child_key(key, code, index)
    return b58encode(b'\xef' + key.to_bytes(32, 'big') + b'\x01')


def verified_address(rpc, key, address):
    info = rpc('getdescriptorinfo', ['pkh(' + key + ')'])
    assert info.get('hasprivatekeys') is True and info.get('isrange') is False
    assert key not in info['descriptor']
    assert rpc('deriveaddresses', [info['descriptor']]) == [address]
    return key


def wallet_exporter(rpc):
    wallets, descriptors, exported = {}, {}, {}

    def export(address, wallet):
        cache_key = (wallet, address)
        if cache_key in exported:
            return exported[cache_key]
        if wallet not in wallets:
            wallets[wallet] = rpc('getwalletinfo', wallet=wallet)
        if not wallets[wallet].get('descriptors', False):
            key = rpc('dumpprivkey', [address], wallet)
        else:
            info = rpc('getaddressinfo', [address], wallet)
            assert info.get('ismine') is True and not info.get('iswatchonly', False)
            if wallet not in descriptors:
                entries = rpc('listdescriptors', [True], wallet)['descriptors']
                # Ranged only: Core refuses a range for a fixed descriptor (RPC -8),
                # which would end the export before the HD parent is compared.
                descriptors[wallet] = [e['desc'] for e in entries if e['desc'].startswith('pkh(') and '*' in e['desc']]
            index = path_parts(info['hdkeypath'][2:])[-1]
            assert index < 2 ** 31
            # Core's normalized parent descriptor may move hardened derivation
            # into the extended key. Match the actual address, not its spelling.
            matching = [d for d in descriptors[wallet]
                        if rpc('deriveaddresses', [d, [index, index]]) == [address]]
            assert len(matching) == 1
            private = matching[0]
            key = descriptor_key(private, info['hdkeypath'])
        exported[cache_key] = verified_address(rpc, key, address)
        return key
    return export


def collect(q):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    token = opener.open(urllib.request.Request('http://169.254.169.254/latest/api/token', method='PUT', headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'}), timeout=5).read().decode()
    instance = opener.open(urllib.request.Request('http://169.254.169.254/latest/meta-data/instance-id', headers={'X-aws-ec2-metadata-token': token}), timeout=5).read().decode()
    assert instance == q['host']['instanceId']
    ids = subprocess.check_output(['docker', 'ps', '-q', '--filter', 'label=dashnet.node=' + q['host']['name']], timeout=10).decode().split()
    assert ids
    containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], timeout=10))
    assert any(c['Config'].get('Labels', {}).get('dashnet.network') == q['network'] and c['Name'].endswith('-core') for c in containers)
    secret = json.loads(Path('/var/lib/dashnet/secrets.json').read_text())

    def rpc(method, params=None, wallet=None):
        auth = base64.b64encode(('dashnet:' + secret['rpcPassword']).encode()).decode()
        req = urllib.request.Request('http://127.0.0.1:20002/' + ('wallet/' + wallet if wallet else ''), data=json.dumps({'jsonrpc': '1.0', 'id': 'key-export', 'method': method, 'params': params or []}).encode(), headers={'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json'})
        with opener.open(req, timeout=20) as response:
            data = json.load(response)
        assert not data.get('error')
        return data['result']

    assert rpc('getblockchaininfo')['chain'] == q['chain']
    if q['host']['role'] == 'validator':
        h = q['host']
        state = rpc('protx', ['info', h['proTxHash']])['state']
        assert state['pubKeyOperator'] == h['operatorPublicKey'] == secret['operatorPublicKey']
        assert state['platformNodeID'].lower() == h['platformNodeId'].lower() == secret['platformNodeID'].lower()
        return {'operatorPrivateKey': secret['operatorPrivateKey'], 'platformNodePrivateKey': secret['nodePrivateKey']}

    assert q['host']['role'] == 'wallet'
    export = wallet_exporter(rpc)
    keys = {}
    for h in q['validators']:
        info = rpc('protx', ['info', h['proTxHash']])
        state = info['state']
        assert state['pubKeyOperator'] == h['operatorPublicKey']
        assert state['platformNodeID'].lower() == h['platformNodeId'].lower()
        fields = {'owner': state['ownerAddress'], 'voting': state['votingAddress'], 'collateral': info['collateralAddress']}
        row = {}
        for kind, address in fields.items():
            row[kind + 'Address'] = address
            row[kind + 'PrivateKey'] = export(address, 'dashnet')
        keys[h['name']] = row
    network = {}
    for kind, address, wallet in [('spork', q.get('sporkAddress'), 'dashnet'), ('payout', q.get('payoutAddress'), 'dashnet'), ('faucet', q.get('faucetAddress'), 'faucet')]:
        if address:
            network[kind + 'Address'] = address
            network[kind + 'PrivateKey'] = (verified_address(rpc, secret['sporkKey'], address)
                                           if kind == 'spork' and secret.get('sporkKey') else export(address, wallet))
    return {'validators': keys, 'networkKeys': network}


if __name__ == '__main__':
    try:
        request = json.loads(sys.argv[1])
        print(json.dumps(collect(request)))
    except Exception:
        # Never expose RPC bodies, subprocess errors or secret-bearing tracebacks.
        print('Devnet key read or identity verification failed', file=sys.stderr)
        sys.exit(1)
