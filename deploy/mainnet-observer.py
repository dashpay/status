#!/usr/bin/env python3
"""Read only the explicitly selected local Mainnet fullnode; send public facts."""
import datetime
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

STATE = Path(os.environ.get('OBSERVER_STATE', '/var/lib/dash-mainnet-observer/last.json'))
PROJECT = os.environ.get('OBSERVER_COMPOSE_PROJECT', 'dash-mainnet-observer')
TIMEOUT = 15


def run(args):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=TIMEOUT, text=True).strip()


def containers():
    ids = run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + PROJECT]).split()
    if not ids:
        raise RuntimeError('observer project has no containers')
    # Inspect only state/identity, never Docker environment or command lines.
    template = '{{json .State}}\t{{.Id}}\t{{.Name}}\t{{.Config.Image}}\t{{.RestartCount}}'
    rows = []
    for line in run(['docker', 'inspect', '--format', template, *ids]).splitlines():
        state, cid, name, image, restarts = line.split('\t')
        state = json.loads(state)
        rows.append(dict(id=cid, name=name.lstrip('/'), image=image, state=state['Status'],
                         running=state['Running'] and not state.get('Restarting'), restarts=int(restarts)))
    return rows


def find(rows, service):
    found = [r for r in rows if r['name'].endswith('-' + service + '-1')]
    if len(found) != 1:
        raise RuntimeError('exact observer service missing or ambiguous')
    return found[0]


def core_status(rows):
    c = find(rows, 'core')
    def cli(*args):
        return json.loads(run(['docker', 'exec', c['id'], 'dash-cli', *args]))
    info, net = cli('getblockchaininfo'), cli('getnetworkinfo')
    if info.get('chain') != 'main':
        raise RuntimeError('observer is not on mainnet')
    lock = {}
    try:
        lock = cli('getbestchainlock')
        lock['time'] = cli('getblockheader', lock['blockhash']).get('time')
    except Exception:
        pass  # Core progress still reaches the board if a ChainLock is unavailable.
    bans = None
    if not info.get('initialblockdownload', True):
        try:
            bans = sorted(k for k, v in cli('masternodelist', 'status').items() if v == 'POSE_BANNED')
        except Exception:
            pass
    return dict(chain='main', blocks=info.get('blocks'), headers=info.get('headers'),
                bestBlockHash=info.get('bestblockhash'), blockTime=info.get('time'),
                ibd=info.get('initialblockdownload'), synced=not info.get('initialblockdownload', True),
                subversion=net.get('subversion'), protocol=net.get('protocolversion'),
                connections=net.get('connections'), chainLockHeight=lock.get('height'),
                _chainLockTime=lock.get('time'), _banned=bans)


def parse_platform(value):
    value = value.get('result', value)  # Tenderdash serves both response formats.
    sync, node = value['sync_info'], value['node_info']
    return dict(height=int(sync['latest_block_height']), blockTime=sync['latest_block_time'],
                network=node['network'], catchingUp=sync['catching_up'],
                maxPeerHeight=int(sync.get('max_peer_block_height') or 0), version=node.get('version'))


def platform_status(rows):
    c = find(rows, 'drive_tenderdash')
    return parse_platform(json.loads(run(['docker', 'exec', c['id'], 'curl', '-fsS', '--max-time', '10',
                                         'http://127.0.0.1:26657/status'])))


def quorum_status():
    base = 'https://quorums.mainnet.networks.dash.org'
    start = time.monotonic()
    def get(path):
        with urllib.request.urlopen(base + path, timeout=TIMEOUT) as r:
            body = json.loads(r.read(4 * 1024 * 1024))
            if r.status != 200 or body.get('success') is not True or not isinstance(body.get('data'), list):
                raise ValueError('invalid quorum list response')
            return body['data']
    nodes, quorums = get('/masternodes'), get('/quorums')
    if not nodes or not quorums:
        raise ValueError('empty quorum list response')
    return dict(status=200, latencyMs=round((time.monotonic() - start) * 1000),
                quorums=len(quorums), listed=len(nodes),
                banned=sum(n.get('status') == 'POSE_BANNED' for n in nodes),
                enabled=sum(n.get('status') == 'ENABLED' for n in nodes),
                versionFailures=sum(n.get('versionCheck') == 'fail' for n in nodes))


def signals(core, platform, previous, now):
    """Independent progress clocks survive regular polls and process restarts.

    Sampling gaps/initial sync are observer coverage gaps, not chain-stall proof.
    The ban alert counts newly banned nodes over one hour, not historical totals.
    """
    state = {'at': now}
    continuous = 0 <= now - previous.get('at', 0) <= 180
    out = {'coreStall': None, 'platformStall': None,
           'chainLockAgeSeconds': max(0, now - core['_chainLockTime']) if core and core.get('_chainLockTime') else None,
           'bigBans': len(core['_banned']) if core and core.get('_banned') is not None else None,
           'newBans': None, 'banWindowSeconds': 3600}
    for kind, obj, field, syncing in [('core', core, 'blocks', 'ibd'), ('platform', platform, 'height', 'catchingUp')]:
        height = obj.get(field) if obj else None
        key = kind + 'Height'
        eligible = height is not None and obj.get(syncing) is False
        same = continuous and eligible and previous.get(key) == height and previous.get(kind + 'Eligible')
        since = previous.get(kind + 'ChangedAt', now) if same else now
        state.update({key: height, kind + 'ChangedAt': since, kind + 'Eligible': eligible})
        out[kind + 'Stall'] = now - since >= int(os.environ.get(kind.upper() + '_STALL_SECONDS', '1800')) if eligible and continuous else None
    bans = core.get('_banned') if core else None
    state['banned'] = bans
    events = [e for e in previous.get('banEvents', []) if 0 <= now - e['at'] < 3600] if continuous else []
    if continuous and bans is not None and previous.get('banned') is not None:
        new = set(bans) - set(previous['banned'])
        events.extend({'at': now, 'id': key} for key in new)
        out['newBans'] = len({e['id'] for e in events})
    state['banEvents'] = events
    return out, state


def collect(previous, now):
    errors = []
    def sample(label, fn):
        try:
            return fn()
        except Exception as exc:
            # Never emit RPC credentials, command output or token-bearing URLs.
            errors.append(label + ': ' + type(exc).__name__)
            return None
    rows = sample('local containers', containers) or []
    core = sample('Core', lambda: core_status(rows))
    platform = sample('Platform', lambda: platform_status(rows))
    quorum = sample('quorum list', quorum_status)
    observed, state = signals(core, platform, previous, now)
    report = dict(network='mainnet', generatedAt=datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(),
                  core={k: v for k, v in core.items() if not k.startswith('_')} if core else None,
                  platform=platform, mainnet=observed, quorumServer=quorum, errors=errors)
    return report, state


def main():
    token = os.environ.get('MAINNET_REPORT_TOKEN')
    if not token:
        raise RuntimeError('report credential is missing')
    previous = {}
    try:
        previous = json.loads(STATE.read_text())
    except (OSError, ValueError):
        pass
    report, state = collect(previous, int(time.time()))
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(state))
    tmp.replace(STATE)
    url = os.environ.get('STATUS_URL', 'https://status.testnet.networks.dash.org').rstrip('/')
    req = urllib.request.Request(url + '/api/mainnet/report', data=json.dumps(report).encode(),
                                 headers={'content-type': 'application/json', 'authorization': 'Bearer ' + token}, method='POST')
    with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
        if response.status != 202:
            raise RuntimeError('report rejected')
    print(json.dumps({'accepted': True, 'core': (report['core'] or {}).get('blocks'),
                      'platform': (report['platform'] or {}).get('height'),
                      'platformSyncing': (report['platform'] or {}).get('catchingUp'), 'errors': report['errors']}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('observer failed: ' + type(exc).__name__, flush=True)
        raise SystemExit(1)
