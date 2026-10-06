#!/usr/bin/env python3
"""Platform-only reset of a dashnet-owned dashmate deployment.

Renders the reviewed target release before wiping; the controller owns the
fenced dashnet journal transition. Epoch and protocol settings are preserved. Only the two chain-data volumes are
removed; Core, Tor, logs, certificates and all non-Platform containers stay.
"""
import base64
import copy
import fcntl
import hashlib
import hmac
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


def tor_hash_matches(spec, password):
    """Verifies a Tor HashedControlPassword (RFC 2440 iterated, salted S2K)."""
    if not re.fullmatch(r"16:[0-9A-Fa-f]{58}", spec):
        return False
    raw = bytes.fromhex(spec[3:])
    salt, indicator, digest = raw[:8], raw[8], raw[9:]
    count = (16 + (indicator & 15)) << ((indicator >> 4) + 6)
    data = salt + password.encode()
    whole, rest = divmod(count, len(data))
    return hmac.compare_digest(hashlib.sha1(data * whole + data[:rest]).digest(), digest)


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

    def compose(self, base, *args, override=True):
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
        if override:
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

    def normalized(self, path, data, config):
        """File content without the salts dashmate draws on every render.

        Each salted line is first verified against the configured secret, so a
        changed credential still changes the digest."""
        d = config["configs"][self.node]
        if path.name == "dash.conf" and path.parent.name == "core":
            users = d["core"]["rpc"]["users"]
            lines = []
            for line in data.decode().splitlines(keepends=True):
                if line.startswith("rpcauth="):
                    user, _, auth = line[len("rpcauth="):].strip().partition(":")
                    salt, _, digest = auth.partition("$")
                    password = users.get(user, {}).get("password", "")
                    expected = hmac.new(salt.encode(), password.encode(), hashlib.sha256).hexdigest()
                    need(password and hmac.compare_digest(expected, digest), "rpcauth-mismatch")
                    line = "rpcauth=" + user + ":verified\n"
                lines.append(line)
            return "".join(lines).encode()
        if path.name == "torrc":
            password = d["core"]["tor"]["control"]["password"]
            lines = []
            for line in data.decode().splitlines(keepends=True):
                if line.startswith("HashedControlPassword "):
                    need(tor_hash_matches(line.split()[1], password), "tor-password-mismatch")
                    line = "HashedControlPassword verified\n"
                lines.append(line)
            return "".join(lines).encode()
        return data

    def journal_baseline(self):
        core = self.owned()['core']
        doc = read(self.home / 'config.json')
        path = self.config / 'core/dash.conf'
        owned = self.owned()
        components = {'drive':'drive_abci', 'tenderdash':'drive_tenderdash', 'dapi':'rs_dapi', 'gateway':'gateway'}
        images = {'core': core['Config']['Image'], 'helper': read(self.home / '.dashnet-render.json')['helper']}
        images.update({k: owned[s]['Config']['Image'] for k, s in components.items() if s in owned})
        marker = read(self.root / 'upgrade.json') if (self.root / 'upgrade.json').exists() else None
        need(not marker or marker.get('phase') == 'applied', 'unfinished native upgrade on host')
        return {'images': images, 'previousId': marker.get('id', '') if marker else '', 'preservation': {
            'coreId': core['Id'], 'coreStarted': core['State']['StartedAt'],
            'coreConfig': hashlib.sha256(self.normalized(path, path.read_bytes(), doc)).hexdigest(),
            'coreGenesis': self.rpc('getblockhash', 1),
            'containers': {k:owned[s]['Id'] for k,s in components.items() if s in owned},
            'restarts': {k:owned[s]['RestartCount'] for k,s in components.items() if s in owned}}}

    def journal_commit(self):
        change = self.q['transition']
        actual = self.journal_baseline()
        # Wallet is only observed; its containers and files are not modified.
        need(actual['preservation']['coreId'] == change['preserve']['coreId'] and
             all(actual['preservation'][k] == change['preserve'][k] for k in ['coreStarted', 'coreConfig', 'coreGenesis']), 'Core changed before journal commit')
        need(actual['images'] == change['to'], 'installed images differ from journal target')
        need(actual['previousId'] in [change.get('previousId', ''), change['id']], 'native host marker changed')
        write(self.root / 'upgrade.json', {**change, 'phase': 'applied', 'reset': True})
        return {'committed': True}

    def baseline(self):
        owned = self.owned()
        need(all(s in owned for s in DATA_MOUNTS), 'Platform chain services missing')
        info, mn = self.rpc('getblockchaininfo'), self.rpc('masternode', 'status')
        need(info['chain'] == self.q['coreChain'] and not info['initialblockdownload'], 'wrong chain or Core syncing')
        need(self.rpc('mnsync', 'status').get('IsSynced') and mn.get('state') == 'READY', 'masternode not READY and synced')
        doc = read(self.home / 'config.json')
        c = doc['configs'][self.node]
        images = {k: owned[s]['Config']['Image'] for k, s in {'drive':'drive_abci','tenderdash':'drive_tenderdash','dapi':'rs_dapi','gateway':'gateway'}.items()}
        epoch = c['platform']['drive']['abci']['epochTime']
        need(self.q.get('epochSeconds') is None, 'native reset preserves epoch settings')
        images['helper'] = read(self.home / '.dashnet-render.json')['helper']
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
             'helper': images['helper'], 'journal': self.journal_baseline()}
        backup = self.state / 'backup'
        need(not backup.exists(), 'incomplete baseline backup; prepare again')
        shutil.copytree(self.home, backup / 'dashmate', symlinks=True)
        shutil.copytree(self.root / 'platform', backup / 'platform')
        write(self.state / 'baseline.json', b)
        return b

    def baseline_record(self):
        need((self.state / 'baseline.json').is_file(), 'baseline missing')
        return read(self.state / 'baseline.json')

    def desired(self):
        images = self.q.get('images') or self.baseline_record()['images']
        need(set(images) == {'drive', 'dapi', 'tenderdash', 'gateway', 'helper'}, 'incomplete target images')
        for ref in images.values():
            need(re.fullmatch(r'index\.docker\.io/[a-z0-9/_.-]+@sha256:[0-9a-f]{64}', ref), 'target image is not pinned')
        return images

    def stage(self):
        images = self.desired()
        for ref in images.values():
            run(['docker', 'pull', ref], timeout=900)
            image = json.loads(run(['docker', 'image', 'inspect', ref]))[0]
            need(image['Architecture'] == self.q['architecture'] and image['Os'] == 'linux', 'image architecture mismatch')
        return {'images': images, 'epochTime': self.baseline_record()['epochTime']}

    def anchor(self):
        cl = self.rpc('getbestchainlock')
        return {'height': cl['height'], 'hash': cl['blockhash']}

    def anchor_check(self):
        header = self.rpc('getblockheader', self.q['anchorHash'])
        need(header.get('height') == self.q['anchorHeight'], 'anchor block unknown')
        return {'known': True}

    def helper(self, stage, action):
        uid, gid = self.home.stat().st_uid, self.home.stat().st_gid
        script = 'set -eu; yarn dashmate config get network --config "$1" >/dev/null'
        if action == 'render':
            script = '''set -eu
            yarn dashmate config render --config "$1" >/dev/null
            yarn dashmate config envs --config "$1" --output-file "$DASHMATE_HOME_DIR/.envs" >/dev/null
            rm -rf "$DASHMATE_HOME_DIR/.compose"
            mkdir "$DASHMATE_HOME_DIR/.compose"
            cp /platform/packages/dashmate/docker-compose*.yml "$DASHMATE_HOME_DIR/.compose/"
            node -p "require('/platform/packages/dashmate/package.json').version" >"$DASHMATE_HOME_DIR/.version"
            '''
        run(['docker', 'run', '--rm', '--network', 'none', '--pull', 'never', '--user', f'{uid}:{gid}',
             '--entrypoint', '/bin/sh', '--workdir', '/platform', '--env', f'DASHMATE_HOME_DIR={self.home}',
             '--env', 'HOME=/tmp', '--env', 'YARN_ENABLE_TELEMETRY=0', '--volume', f'{stage}:{self.home}', self.desired()['helper'],
             '-c', script, 'reset', self.node], timeout=600)

    def release(self):
        b = self.baseline_record()
        self.preserved(b)
        need(digest(self.home / 'config.json') == b['configHash'], 'configuration changed since preparation')
        stage = self.state / 'render'
        if stage.exists():
            shutil.rmtree(stage)
        shutil.copytree(self.home, stage, symlinks=False)
        uid, gid = self.home.stat().st_uid, self.home.stat().st_gid
        for p in [stage, *stage.rglob('*')]:
            os.chown(p, uid, gid)
        if self.desired()['helper'] != b['helper']:
            self.helper(stage, 'migrate')
        doc = read(stage / 'config.json')
        current = read(self.home / 'config.json')['configs'][self.node]
        c = doc['configs'][self.node]
        for user, settings in current['core']['rpc']['users'].items():
            migrated = c['core']['rpc']['users'].get(user, {})
            need(settings.get('whitelist') == migrated.get('whitelist'), 'target release requires a Core RPC whitelist migration before Platform reset')
        need(c['core'] == current['core'], 'target helper migration changes Core configuration; prepare compatible Core settings first')
        for component, path in {'drive':'drive.abci', 'tenderdash':'drive.tenderdash', 'dapi':'dapi.rsDapi', 'gateway':'gateway'}.items():
            entry = c['platform']
            for key in path.split('.'):
                entry = entry[key]
            entry['docker']['image'] = self.desired()[component]
        c['platform']['drive']['abci']['epochTime'] = b['epochTime']
        c['platform']['drive']['tenderdash']['genesis']['initial_core_chain_locked_height'] = self.q['anchorHeight']
        write(stage / 'config.json', doc)
        self.helper(stage, 'render')
        need(read(stage / 'config.json') == doc, 'renderer changed configured target')
        write(stage / '.dashnet-render.json', {'helper': self.desired()['helper'], 'source': b['configHash']})
        raw = json.loads(self.compose(stage, 'config', '--format', 'json', override=False))['services']
        selection = set(raw) - {'dashmate_helper'}
        need(selection == set(b['platform']) | {'core', *(['core_tor'] if 'core_tor' in self.owned() else [])}, 'target release changes service selection')
        return {'sidecars': {s: raw[s]['image'] for s in selection if s in ['core_tor', 'gateway_rate_limiter', 'gateway_rate_limiter_redis']}}

    def render(self):
        self.release()
        b = self.baseline_record()
        stage = self.state / 'render'
        doc = read(stage / 'config.json')
        after = read(stage / 'config.json')
        need(after == doc, 'renderer changed configured target')
        rel = Path(self.node) / 'platform/drive/tenderdash'
        old, new = read(self.td / 'genesis.json'), read(stage / rel / 'genesis.json')
        old['initial_core_chain_locked_height'] = self.q['anchorHeight']
        need(old == new, 'genesis changed beyond the anchor')
        need(digest(self.td / 'node_key.json') == digest(stage / rel / 'node_key.json'), 'node identity changed')
        # Hashes use dashnet's exact Platform service/content fingerprint
        # algorithm (Core/Tor salted files and fingerprints stay untouched).
        overrides = read(stage / '.dashnet-compose.json')
        for service, ref in self.q.get('sidecars', {}).items():
            need(service in overrides['services'], 'unknown sidecar')
            if service != 'core_tor':
                run(['docker', 'pull', ref], timeout=900)
            overrides['services'][service]['image'] = ref
        write(stage / '.dashnet-compose.json', overrides)
        services = json.loads(self.compose(stage, 'config', '--format', 'json').replace(str(stage), str(self.home)))['services']
        live = json.loads(self.compose(self.home, 'config', '--format', 'json'))['services']
        for name in ['core', 'core_tor']:
            if name in live:
                need(services[name] == live[name], 'target release changes Core Compose service')
        # Verify all Core/Tor rendered files semantically, including salted credentials.
        for path in (self.config / 'core').rglob('*'):
            if path.is_file():
                rendered = stage / path.relative_to(self.home)
                need(rendered.is_file() and self.normalized(path, path.read_bytes(), doc) == self.normalized(rendered, rendered.read_bytes(), doc), 'target release changes Core files')
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
        write(self.state / 'prepared.json', {'anchor': self.q['anchorHeight'], 'images': self.desired(), 'platform': {s: {'image': services[s]['image']} for s in b['platform']}, 'files': {str(p.relative_to(stage)): digest(p) for p in stage.rglob('*') if p.is_file()}})
        return {'checks': {'coreSectionUnchanged': True, 'nodeKeyUnchanged': True, 'genesisOnlyAnchorChanged': True,
                           'anchor': self.q['anchorHeight'], 'epochTime': b['epochTime'], 'epochEnv': b['epochTime'], 'genesisChainId': new['chain_id']}, 'images': self.desired(), 'rendered': ['Target release Platform configuration and Compose templates', 'dashnet reset anchor and identity record']}

    def prewipe(self):
        b = self.baseline_record()
        self.preserved(b)
        need((self.state / 'prepared.json').is_file(), 'canary missing')
        prepared = read(self.state / 'prepared.json')
        need(prepared['images'] == self.desired(), 'reviewed target images changed')
        for rel, value in prepared['files'].items():
            need(digest(self.state / 'render' / rel) == value, 'prepared files changed')
        for ref in [*prepared['images'].values(), *[v['image'] for v in prepared['platform'].values()]]:
            run(['docker', 'image', 'inspect', ref])
        owned = self.owned()
        if not (self.state / 'wipe-started.json').exists():
            need(digest(self.home / 'config.json') == b['configHash'], 'configuration changed since preparation')
            need({s: c['Id'] for s, c in owned.items() if s in PLATFORM} == {s: c['id'] for s, c in b['platform'].items()}, 'Platform changed since preparation')
            need(self.data_volumes(owned) == b['volumes'], 'Platform volumes changed since preparation')
        return {'ready': True}

    def wipe(self):
        self.prewipe()
        b = self.baseline_record()
        if not (self.state / 'wipe-started.json').exists():
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
            allowed = rel in ['config.json', '.envs', '.dashnet-compose.json', '.dashnet-render.json', '.version'] or p.is_relative_to(Path('.compose')) or rel == f'{self.node}/dynamic-compose.yml'
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
        prepared = read(self.state / 'prepared.json')
        for s, expected in prepared['platform'].items():
            c = owned.get(s)
            need(c and c['State']['Running'] and not c['State'].get('Restarting'), 'Platform service not running')
            image = json.loads(run(['docker', 'image', 'inspect', expected['image']]))[0]
            need(c['Config']['Image'] == expected['image'] and c['Image'] == image['Id'], 'Platform image differs from reviewed target')
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
            method = {'anchor-check':'anchor_check','canary':'render','journal-baseline':'journal_baseline','journal-commit':'journal_commit'}.get(stage, stage)
            need(method in ['baseline','stage','anchor','anchor_check','render','release','journal_baseline','journal_commit','prewipe','wipe','apply','start','verify'], 'invalid stage')
            result = getattr(reset, method)()
        print(json.dumps({'ok': True, 'stage': stage, 'result': result}))
    except Exception as error:
        print(json.dumps({'ok': False, 'stage': stage, 'error': str(error) if isinstance(error, Fail) else type(error).__name__}))


if __name__ == '__main__':
    main()
