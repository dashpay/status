#!/usr/bin/env python3
"""Read-only, identity-checked devnet key export; stdout is private transport only."""
import base64
import json
from pathlib import Path
import subprocess
import sys
import urllib.request


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
            row[kind + 'PrivateKey'] = rpc('dumpprivkey', [address], 'dashnet')
        keys[h['name']] = row
    network = {}
    for kind, address, wallet in [('spork', q.get('sporkAddress'), 'dashnet'), ('payout', q.get('payoutAddress'), 'dashnet'), ('faucet', q.get('faucetAddress'), 'faucet')]:
        if address:
            network[kind + 'Address'] = address
            network[kind + 'PrivateKey'] = rpc('dumpprivkey', [address], wallet)
    return {'validators': keys, 'networkKeys': network}


if __name__ == '__main__':
    try:
        request = json.loads(sys.argv[1])
        print(json.dumps(collect(request)))
    except Exception:
        # Never expose RPC bodies, subprocess errors or secret-bearing tracebacks.
        print('Devnet key read or identity verification failed', file=sys.stderr)
        sys.exit(1)
