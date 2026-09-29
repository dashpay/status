#!/usr/bin/env python3
"""Read-only Mainnet observer for the separate observer/fullnode host.

The observer never touches the mainnet-support fleet. It reads the local Core
and Evolution-fullnode containers, checks the public quorum list server, and
pushes a bounded public report to the status console.
"""
import json
import os
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

STATUS_URL = os.environ.get('STATUS_URL', 'https://status.testnet.networks.dash.org').rstrip('/')
REPORT_TOKEN = os.environ.get('MAINNET_REPORT_TOKEN', '')
STATE = Path(os.environ.get('OBSERVER_STATE', '/var/lib/dash-mainnet-observer/last.json'))
QUORUM_URL = os.environ.get('QUORUM_URL', 'https://quorums.mainnet.networks.dash.org')
CORE_STALL = int(os.environ.get('CORE_STALL_SECONDS', '1800'))
PLATFORM_STALL = int(os.environ.get('PLATFORM_STALL_SECONDS', '1800'))
TIMEOUT = int(os.environ.get('OBSERVER_TIMEOUT_SECONDS', '30'))


def run(args, timeout=TIMEOUT):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=timeout, text=True).strip()


def json_run(args):
    return json.loads(run(args))


def containers():
    rows = []
    try:
        raw = run(['docker', 'ps', '-a', '--format', '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}'])
    except Exception:
        return rows
    for line in raw.splitlines():
        parts = line.split('\t', 3)
        if len(parts) != 4:
            continue
        cid, image, name, state = parts
        if not any(x in image.lower() for x in ('dashpay/dashd', 'dashpay/tenderdash', 'dashpay/drive', 'dashpay/rs-dapi', 'dashpay/envoy')):
            continue
        rows.append({'id': cid, 'image': image, 'name': name, 'state': state})
    return rows


def find_container(rows, needle):
    return next((r for r in rows if needle in r['image'].lower() or needle in r['name'].lower()), None)


def core_status(rows):
    c = find_container(rows, 'dashd')
    if not c:
        raise RuntimeError('local Dash Core container not found')
    def cli(*args):
        return json_run(['docker', 'exec', c['id'], 'dash-cli', *args])
    info = cli('getblockchaininfo')
    net = cli('getnetworkinfo')
    lock = cli('getbestchainlock')
    lock_height = lock.get('height') if isinstance(lock, dict) else None
    lock_time = None
    if isinstance(lock, dict) and lock.get('blockhash'):
        try:
            header = cli('getblockheader', lock['blockhash'])
            lock_time = header.get('time')
        except Exception:
            pass
    return {
        'chain': info.get('chain'), 'blocks': info.get('blocks'), 'headers': info.get('headers'),
        'bestBlockHash': info.get('bestblockhash'), 'blockTime': info.get('time'),
        'ibd': info.get('initialblockdownload'), 'synced': not info.get('initialblockdownload', True),
        'subversion': net.get('subversion'), 'protocol': net.get('protocolversion'),
        'connections': net.get('connections'), 'chainLockHeight': lock_height,
        '_chainLockTime': lock_time,
    }


def tenderdash_status(rows):
    c = find_container(rows, 'tenderdash')
    if not c:
        return None
    for command in ('curl', 'wget'):
        try:
            if command == 'curl':
                raw = run(['docker', 'exec', c['id'], 'curl', '-fsS', '--max-time', '10', 'http://127.0.0.1:26657/status'])
            else:
                raw = run(['docker', 'exec', c['id'], 'wget', '-qO-', '-T', '10', 'http://127.0.0.1:26657/status'])
            value = json.loads(raw).get('result', {})
            sync = value.get('sync_info', {})
            node = value.get('node_info', {})
            return {'height': int(sync.get('latest_block_height') or 0), 'blockTime': sync.get('latest_block_time'),
                    'network': node.get('network'), 'catchingUp': bool(sync.get('catching_up')), 'peers': None,
                    'version': node.get('version')}
        except Exception:
            continue
    return None


def quorum_status():
    start = time.time()
    out = {'status': None, 'latencyMs': None, 'quorums': None, 'banned': None, 'enabled': None, 'versionFailures': None}
    ctx = ssl.create_default_context()
    try:
        def get(path):
            with urllib.request.urlopen(QUORUM_URL + path, timeout=TIMEOUT, context=ctx) as response:
                return response.status, json.loads(response.read(4 * 1024 * 1024))
        status, _ = get('/health')
        out['status'] = status
        status, body = get('/masternodes')
        out['status'] = status if status != 200 else out['status']
        nodes = body.get('data') if isinstance(body, dict) else None
        if isinstance(nodes, list):
            out['banned'] = sum(1 for n in nodes if n.get('status') == 'POSE_BANNED')
            out['enabled'] = sum(1 for n in nodes if n.get('status') == 'ENABLED')
            out['versionFailures'] = sum(1 for n in nodes if n.get('versionCheck') == 'fail')
        status, body = get('/quorums')
        data = body.get('data') if isinstance(body, dict) else None
        if isinstance(data, list): out['quorums'] = len(data)
    except Exception as exc:
        out['error'] = str(exc)[:200]
    out['latencyMs'] = round((time.time() - start) * 1000)
    return out


def main():
    if not REPORT_TOKEN:
        raise SystemExit('MAINNET_REPORT_TOKEN is required')
    now = int(time.time())
    rows = containers()
    core = core_status(rows)
    platform = tenderdash_status(rows)
    quorum = quorum_status()
    previous = {}
    try: previous = json.loads(STATE.read_text())
    except Exception: pass
    core_same = previous.get('coreBlocks') == core.get('blocks')
    platform_same = previous.get('platformHeight') == (platform or {}).get('height')
    previous_at = int(previous.get('at', now))
    report = {
        'network': 'mainnet', 'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now)),
        'probeMs': 0, 'core': {k: v for k, v in core.items() if not k.startswith('_')}, 'platform': platform,
        'quorumServer': quorum,
        'mainnet': {
            'chainLockAgeSeconds': max(0, now - int(core['_chainLockTime'])) if core.get('_chainLockTime') else None,
            'bigBans': quorum.get('banned'), 'coreStall': core_same and now - previous_at >= CORE_STALL,
            'platformStall': bool(platform) and platform_same and now - previous_at >= PLATFORM_STALL,
        },
        'containers': [{'name': r['name'], 'repo': r['image'].split('@')[0].split(':')[0], 'image': r['image'], 'running': 'Up ' in r['state'], 'state': r['state']} for r in rows],
    }
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps({'at': now, 'coreBlocks': core.get('blocks'), 'platformHeight': (platform or {}).get('height')}))
    tmp.replace(STATE)
    request = urllib.request.Request(STATUS_URL + '/api/mainnet/report', data=json.dumps(report).encode(), method='POST', headers={'content-type': 'application/json', 'authorization': 'Bearer ' + REPORT_TOKEN})
    with urllib.request.urlopen(request, timeout=TIMEOUT, context=ssl.create_default_context()) as response:
        if response.status != 202: raise RuntimeError('status console rejected report')
    print(json.dumps({'network': 'mainnet', 'core': core.get('blocks'), 'platform': (platform or {}).get('height'), 'bans': quorum.get('banned'), 'coreStall': report['mainnet']['coreStall'], 'platformStall': report['mainnet']['platformStall']}))


if __name__ == '__main__':
    main()
