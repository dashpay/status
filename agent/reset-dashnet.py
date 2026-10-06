#!/usr/bin/env python3
"""Platform-only reset of a dashnet-owned dashmate deployment.

Reuses the installed release and epoch. Upgrades remain dashnet operations, so
its image journal is never bypassed. Only the two chain-data volumes are
removed; Core, Tor, logs, certificates and all non-Platform containers stay.
"""
import base64
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time

PLATFORM = ['drive_abci', 'drive_tenderdash', 'rs_dapi', 'gateway',
            'gateway_rate_limiter', 'gateway_rate_limiter_metrics', 'gateway_rate_limiter_redis']
DATA_MOUNTS = {'drive_abci': '/var/lib/dash/rs-drive-abci/db', 'drive_tenderdash': '/tenderdash'}


class Fail(Exception):
    pass


def need(ok, message):
    if not ok:
        raise Fail(message)


def run(args, timeout=300, env=None):
    p = subprocess.run(args, capture_output=True, timeout=timeout, env={**os.environ, **(env or {})})
    # Docker/Compose/RPC errors can contain credentials. Never echo them.
    need(p.returncode == 0, f'{args[0]} failed (exit {p.returncode})')
    return p.stdout.decode()


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name('.' + path.name + '.reset')
    tmp.write_text(json.dumps(value, indent=2))
    os.chmod(tmp, 0o600)
    if path.exists():
        st = path.stat()
        os.chown(tmp, st.st_uid, st.st_gid)
        os.chmod(tmp, st.st_mode & 0o777)
    os.replace(tmp, path)


class Reset:
    def __init__(self, q, root=Path('/var/lib/dashnet'), state_root=Path('/var/lib/dash-status-reset')):
        self.q, self.root = q, root
        need(re.fullmatch(r'[0-9a-f-]{36}(\.[0-9]{1,16})?', q['exec']), 'invalid execution id')
        need(re.fullmatch(r'[a-z0-9-]+', q['node']), 'invalid node name')
        self.node = q['node']
        self.home = root / 'dashmate'
        self.state = state_root / q['exec']
        self.config = self.home / self.node
        self.td = self.config / 'platform/drive/tenderdash'

    def all_containers(self):
        ids = run(['docker', 'ps', '-aq']).split()
        return json.loads(run(['docker', 'inspect', *ids])) if ids else []

    def owned(self):
        out = {}
        for c in self.all_containers():
            labels = c['Config'].get('Labels') or {}
            if labels.get('dashnet.network') == self.q['config'] and labels.get('dashnet.node') == self.node:
                service = labels.get('com.docker.compose.service')
                if service in PLATFORM + ['core', 'core_tor']:
                    need(service not in out, 'duplicate owned service')
                    out[service] = c
        need('core' in out, 'owned Core container missing')
        return out

    def rpc(self, *args):
        c = self.owned()['core']
        value = run(['docker', 'exec', c['Id'], 'dash-cli', '-conf=/etc/dash/dash.conf', *map(str, args)], timeout=60)
        try:
            return json.loads(value)
        except ValueError:
            return value.strip()

    def snapshot(self):
        # All containers outside Platform must remain exact, not just Core.
        keep = {}
        for c in self.all_containers():
            labels = c['Config'].get('Labels') or {}
            if (labels.get('dashnet.network') == self.q['config'] and labels.get('dashnet.node') == self.node
                    and labels.get('com.docker.compose.service') in PLATFORM):
                continue
            keep[c['Name']] = {'id': c['Id'], 'started': c['State']['StartedAt'], 'running': c['State']['Running']}
        paths = [self.config / 'core', self.home / '.client', self.root / 'secrets.json',
                 self.root / 'deployment.json', self.td / 'node_key.json']
        hashes = {}
        for path in paths:
            for p in path.rglob('*') if path.is_dir() else [path]:
                if p.is_file():
                    need(not p.is_symlink(), 'symlink in preserved configuration')
                    hashes[str(p.relative_to(self.root))] = digest(p)
        return {'containers': keep, 'files': hashes}

    def preserved(self, b):
        need(self.snapshot() == b['preserve'], 'Core, identities or non-Platform services changed since preparation')

    def compose(self, base, *args):
        env = {}
        for line in (base / '.envs').read_text().splitlines():
            if line:
                k, sep, v = line.partition('=')
                need(sep and re.fullmatch('[A-Z][A-Z0-9_]*', k), 'invalid Compose environment')
                env[k] = v
        project = (self.owned()['core']['Config']['Labels'])['com.docker.compose.project']
        cmd = ['docker', 'compose', '--project-name', project, '--project-directory', str(base / '.compose')]
        for name in env['COMPOSE_FILE'].split(env.get('COMPOSE_PATH_SEPARATOR') or ':'):
            if name.startswith('/'):
                path = Path(name)
                need(path.is_relative_to(self.home), 'Compose file outside dashmate home')
                path = base / path.relative_to(self.home)
            else:
                need(re.fullmatch(r'docker-compose[a-z0-9_.-]*\.yml', name), 'invalid Compose file')
                path = base / '.compose' / name
            need(path.is_file() and not path.is_symlink(), 'missing Compose file')
            cmd += ['-f', str(path)]
        cmd += ['-f', str(base / '.dashnet-compose.json')]
        for profile in env.get('COMPOSE_PROFILES', '').split(','):
            if profile:
                cmd += ['--profile', profile]
        env = {k: v for k, v in env.items() if not k.startswith('COMPOSE_')}
        env['DASHMATE_HOME_DIR'] = str(base)
        return run([*cmd, *args], timeout=900, env=env)

    def data_volumes(self, owned):
        volumes = {}
        for service, destination in DATA_MOUNTS.items():
            mounts = [m for m in owned[service]['Mounts'] if m['Destination'] == destination]
            need(len(mounts) == 1 and mounts[0]['Type'] == 'volume', 'unsupported Platform data layout')
            volumes[service] = mounts[0]['Name']
        need(len(set(volumes.values())) == 2, 'Platform data volumes overlap')
        for c in self.all_containers():
            for m in c['Mounts']:
                if m.get('Name') in volumes.values():
                    need(c['Id'] in [owned[s]['Id'] for s in DATA_MOUNTS], 'Platform data volume shared with another service')
        return volumes

    def baseline(self):
        owned = self.owned()
        need(all(s in owned for s in DATA_MOUNTS), 'Platform chain services missing')
        info, mn = self.rpc('getblockchaininfo'), self.rpc('masternode', 'status')
        need(info['chain'] == self.q['coreChain'] and not info['initialblockdownload'], 'wrong chain or Core syncing')
        need(self.rpc('mnsync', 'status').get('IsSynced') and mn.get('state') == 'READY', 'masternode not READY and synced')
        doc = read(self.home / 'config.json')
        c = doc['configs'][self.node]
        images = {k: owned[s]['Config']['Image'] for k, s in {'drive':'drive_abci','tenderdash':'drive_tenderdash','dapi':'rs_dapi'}.items()}
        epoch = c['platform']['drive']['abci']['epochTime']
        need(not self.q.get('images') and self.q.get('epochSeconds') is None, 'dashnet reset keeps installed images and epoch; use Deploy for version changes')
        self.state.mkdir(parents=True, mode=0o700, exist_ok=True)
        if (self.state / 'baseline.json').exists():
            b = read(self.state / 'baseline.json')
            self.preserved(b)
            return b
        b = {'preserve': self.snapshot(), 'volumes': self.data_volumes(owned), 'height': info['blocks'],
             'platform': {s: {'id': c['Id'], 'image': c['Config']['Image']} for s, c in owned.items() if s in PLATFORM},
             'images': images, 'epochTime': epoch, 'anchor': read(self.td / 'genesis.json')['initial_core_chain_locked_height'],
             'dashmate': (self.home / '.version').read_text().strip(), 'configFormatVersion': doc.get('configFormatVersion'),
             'tor': {'enabled': c['core']['tor']['enabled']}, 'configHash': digest(self.home / 'config.json'),
             'helper': read(self.home / '.dashnet-render.json')['helper']}
        backup = self.state / 'backup'
        need(not backup.exists(), 'incomplete baseline backup; prepare again')
        shutil.copytree(self.home, backup / 'dashmate', symlinks=True)
        shutil.copytree(self.root / 'platform', backup / 'platform')
        write(self.state / 'baseline.json', b)
        return b

    def baseline_record(self):
        need((self.state / 'baseline.json').is_file(), 'baseline missing')
        return read(self.state / 'baseline.json')

    def stage(self):
        b = self.baseline_record()
        for ref in [*b['images'].values(), b['helper']]:
            # Immutable installed image IDs/digests, never pull moving tags.
            run(['docker', 'image', 'inspect', ref])
        return {'images': b['images'], 'epochTime': b['epochTime']}

    def anchor(self):
        cl = self.rpc('getbestchainlock')
        return {'height': cl['height'], 'hash': cl['blockhash']}

    def anchor_check(self):
        header = self.rpc('getblockheader', self.q['anchorHash'])
        need(header.get('height') == self.q['anchorHeight'], 'anchor block unknown')
        return {'known': True}

    def render(self):
        b = self.baseline_record()
        self.preserved(b)
        need(digest(self.home / 'config.json') == b['configHash'], 'configuration changed since preparation')
        stage = self.state / 'render'
        if stage.exists():
            shutil.rmtree(stage)
        shutil.copytree(self.home, stage, symlinks=False)
        doc = read(stage / 'config.json')
        doc['configs'][self.node]['platform']['drive']['tenderdash']['genesis']['initial_core_chain_locked_height'] = self.q['anchorHeight']
        write(stage / 'config.json', doc)
        uid, gid = self.home.stat().st_uid, self.home.stat().st_gid
        for p in [stage, *stage.rglob('*')]:
            os.chown(p, uid, gid)
        # Same helper and rendering mechanism as dash-network-go; isolated from
        # live configuration, network and Docker socket.
        run(['docker', 'run', '--rm', '--network', 'none', '--pull', 'never', '--user', f'{uid}:{gid}',
             '--entrypoint', '/bin/sh', '--workdir', '/platform', '--env', f'DASHMATE_HOME_DIR={self.home}',
             '--env', 'HOME=/tmp', '--env', 'YARN_ENABLE_TELEMETRY=0', '--volume', f'{stage}:{self.home}', b['helper'],
             '-c', 'set -eu; yarn dashmate config render --config "$1" >/dev/null; yarn dashmate config envs --config "$1" --output-file "$DASHMATE_HOME_DIR/.envs" >/dev/null',
             'reset', self.node], timeout=600)
        after = read(stage / 'config.json')
        need(after == doc, 'renderer changed configuration beyond the anchor')
        rel = Path(self.node) / 'platform/drive/tenderdash'
        old, new = read(self.td / 'genesis.json'), read(stage / rel / 'genesis.json')
        old['initial_core_chain_locked_height'] = self.q['anchorHeight']
        need(old == new, 'genesis changed beyond the anchor')
        need(digest(self.td / 'node_key.json') == digest(stage / rel / 'node_key.json'), 'node identity changed')
        # Hashes use dashnet's exact Platform service/content fingerprint
        # algorithm (Core/Tor salted files and fingerprints stay untouched).
        services = json.loads(self.compose(stage, 'config', '--format', 'json').replace(str(stage), str(self.home)))['services']
        overrides = read(stage / '.dashnet-compose.json')
        for name in b['platform']:
            model = copy.deepcopy(services[name])
            (model.get('labels') or {}).pop('dashnet.config', None)
            files = {}
            ssl = self.config / 'platform/gateway/ssl'
            for mount in model.get('volumes', []):
                source = Path(mount.get('source') or '/')
                if mount.get('type') == 'bind' and source.is_relative_to(self.home) and not source.is_relative_to(ssl):
                    relative = source.relative_to(self.home)
                    path = stage / relative
                    files[str(relative)] = ({str(p.relative_to(path)): digest(p) for p in sorted(path.rglob('*')) if p.is_file()}
                                            if path.is_dir() else digest(path) if path.exists() else None)
            fingerprint = hashlib.sha256(json.dumps([model, files], sort_keys=True).encode()).hexdigest()
            overrides['services'][name]['labels']['dashnet.config'] = fingerprint
        write(stage / '.dashnet-compose.json', overrides)
        self.preserved(b)
        write(self.state / 'prepared.json', {'anchor': self.q['anchorHeight'], 'files': {str(p.relative_to(stage)): digest(p) for p in stage.rglob('*') if p.is_file()}})
        return {'checks': {'coreSectionUnchanged': True, 'nodeKeyUnchanged': True, 'genesisOnlyAnchorChanged': True,
                           'anchor': self.q['anchorHeight'], 'epochTime': b['epochTime'], 'epochEnv': b['epochTime'], 'genesisChainId': new['chain_id']}, 'rendered': ['Platform configuration', 'dashnet reset anchor and identity record']}

    def wipe(self):
        b = self.baseline_record()
        self.preserved(b)
        need((self.state / 'prepared.json').is_file(), 'canary missing')
        owned = self.owned()
        if not (self.state / 'wipe-started.json').exists():
            need(digest(self.home / 'config.json') == b['configHash'], 'configuration changed since preparation')
            need({s: c['Id'] for s, c in owned.items() if s in PLATFORM} == {s: c['id'] for s, c in b['platform'].items()}, 'Platform changed since preparation')
            need(self.data_volumes(owned) == b['volumes'], 'Platform volumes changed since preparation')
            write(self.state / 'wipe-started.json', {'at': time.time()})
        need(self.rpc('masternode', 'status').get('state') == 'READY', 'masternode not READY')
        self.compose(self.home, 'stop', *b['platform'])
        self.compose(self.home, 'rm', '--force', *b['platform'])
        # Volume deletion is explicit and scoped; never compose down -v/prune.
        existing = set(run(['docker', 'volume', 'ls', '-q']).split())
        for volume in b['volumes'].values():
            if volume in existing:
                run(['docker', 'volume', 'rm', volume])
        self.preserved(b)
        return {'platformRemoved': True}

    def apply(self):
        b = self.baseline_record()
        self.preserved(b)
        need((self.state / 'wipe-started.json').exists(), 'wipe not started')
        stage = self.state / 'render'
        prepared = read(self.state / 'prepared.json')
        need(prepared['anchor'] == self.q['anchorHeight'], 'prepared anchor changed')
        for rel, value in prepared['files'].items():
            need(digest(stage / rel) == value, 'prepared files changed')
        # Only rendered Platform config and global dashmate metadata; preserve
        # exact Core/Tor files and live ACME-managed SSL files.
        for rel in prepared['files']:
            p = Path(rel)
            allowed = rel in ['config.json', '.envs', '.dashnet-compose.json'] or rel == f'{self.node}/dynamic-compose.yml'
            allowed |= p.is_relative_to(Path(self.node) / 'platform') and not p.is_relative_to(Path(self.node) / 'platform/gateway/ssl')
            if allowed:
                dst = self.home / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                # In-place write retains bind-mounted inodes.
                dst.write_bytes((stage / rel).read_bytes())
        inputs = read(self.root / 'platform/inputs.json')
        inputs['genesisCoreHeight'] = self.q['anchorHeight']
        write(self.root / 'platform/inputs.json', inputs)
        write(self.root / 'platform/identity.json', {name: digest(self.td / name) for name in ['genesis.json', 'node_key.json']})
        self.preserved(b)
        return {'anchor': self.q['anchorHeight']}

    def start(self):
        b = self.baseline_record()
        self.preserved(b)
        # Bring Drive up before Tenderdash and its dependants. Core is never a dependency target.
        self.compose(self.home, 'up', '-d', '--no-deps', 'drive_abci')
        deadline = time.monotonic() + 150
        while True:
            drive = self.owned().get('drive_abci')
            networks = (drive or {}).get('NetworkSettings', {}).get('Networks', {})
            addresses = [n.get('IPAddress') for n in networks.values() if n.get('IPAddress')]
            ready = False
            for ip in addresses:
                try:
                    with socket.create_connection((ip, 26658), timeout=2):
                        ready = True
                except OSError:
                    pass
            if ready:
                break
            need(time.monotonic() < deadline, 'Drive ABCI did not become ready')
            time.sleep(1)
        self.compose(self.home, 'up', '-d', '--no-deps', *[s for s in b['platform'] if s != 'drive_abci'])
        self.preserved(b)
        return {'started': True}

    def verify(self):
        b = self.baseline_record()
        self.preserved(b)
        owned = self.owned()
        for s, expected in b['platform'].items():
            c = owned.get(s)
            need(c and c['State']['Running'] and not c['State'].get('Restarting'), 'Platform service not running')
            need(c['Config']['Image'] == expected['image'], 'Platform image changed')
        td = owned['drive_tenderdash']
        result = json.loads(run(['nsenter','-t',str(td['State']['Pid']),'-n','curl','-fsS','--max-time','5','http://127.0.0.1:26657/status']))
        sync = result.get('result', result)['sync_info']
        need(int(sync['latest_block_height']) > 0 and sync['catching_up'] is False, 'Platform consensus not ready')
        need(self.rpc('masternode','status').get('state') == 'READY', 'masternode not READY')
        need(read(self.td / 'genesis.json')['initial_core_chain_locked_height'] == self.q['anchorHeight'], 'wrong reset anchor')
        env = dict(x.split('=',1) for x in owned['drive_abci']['Config']['Env'] if '=' in x)
        cfg_epoch = read(self.home / 'config.json')['configs'][self.node]['platform']['drive']['abci']['epochTime']
        parsed = run(['docker', 'exec', owned['drive_abci']['Id'], 'drive-abci', 'config'], timeout=60)
        match = re.search(r'epoch_time_length_s["\s:=]+(\d+)', parsed)
        del parsed
        need(match and str(cfg_epoch) == str(env.get('EPOCH_TIME_LENGTH_S')) == match.group(1) == str(b['epochTime']), 'epoch config/env/parsed mismatch')
        need(self.rpc('mnsync', 'status').get('IsSynced') and not self.rpc('getblockchaininfo').get('initialblockdownload'), 'Core not synchronized')
        tls = run(['curl','-s','-o','/dev/null','-w','%{http_code}','--max-time','10',f'https://{self.q["address"]}:1443/']).strip()
        need(tls == '405', 'DAPI TLS not ready')
        return {'consensus': {'height': int(sync['latest_block_height'])}, 'epochs': {'config': b['epochTime'], 'env': env['EPOCH_TIME_LENGTH_S'], 'parsed': int(match.group(1))},
                'core': {'unchanged': True}, 'restarts': {s:c['RestartCount'] for s,c in owned.items() if s in PLATFORM and c['RestartCount']}}


def main():
    stage = sys.argv[1]
    try:
        os.umask(0o077)
        reset = Reset(json.loads(base64.b64decode(sys.argv[2])))
        with open('/run/dashnet-bootstrap.lock', 'a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Fail('another dashnet operation is running') from None
            method = {'anchor-check':'anchor_check','canary':'render'}.get(stage, stage)
            need(method in ['baseline','stage','anchor','anchor_check','render','wipe','apply','start','verify'], 'invalid stage')
            result = getattr(reset, method)()
        print(json.dumps({'ok': True, 'stage': stage, 'result': result}))
    except Exception as error:
        print(json.dumps({'ok': False, 'stage': stage, 'error': str(error) if isinstance(error, Fail) else type(error).__name__}))


if __name__ == '__main__':
    main()
