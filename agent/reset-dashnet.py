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
import signal
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
        owned_core = self.owned_optional().get('core')
        project = owned_core['Config']['Labels']['com.docker.compose.project'] if owned_core else self.baseline_record()['project']
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
        change = copy.deepcopy(self.q['transition'])
        if (self.state / 'baseline-effective.json').exists():
            change['preserve'] = self.baseline_record()['journal']['preservation']
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
        b = {'project': owned['core']['Config']['Labels']['com.docker.compose.project'], 'coreServices': {name: {'id': v['Id'], 'image': v['Config']['Image'], 'mounts': v['Mounts']} for name, v in owned.items() if name in ['core', 'core_tor']}, 'preserve': self.snapshot(), 'volumes': self.data_volumes(owned), 'height': info['blocks'],
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
        effective = self.state / 'baseline-effective.json'
        return read(effective if effective.exists() else self.state / 'baseline.json')

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

    @staticmethod
    def core_changes(before, after):
        """Release-owned RPC access migrations; never credentials, chain or data.

        No UI/operator-supplied RPC permissions are accepted. These values come
        only from the selected immutable official helper's own migrations.
        """
        restored = copy.deepcopy(after)
        old_users = before['rpc']['users']
        new_users = restored['rpc']['users']
        need(set(old_users) == set(new_users), 'target release changes Core RPC identities')
        changes = []
        for user, old in old_users.items():
            previous, desired = old.get('whitelist'), new_users[user].get('whitelist')
            if previous != desired:
                need(isinstance(previous, list) and isinstance(desired, list) and desired and
                     all(isinstance(x, str) and re.fullmatch('[a-z][a-z0-9_]*', x) for x in desired), 'invalid release RPC whitelist migration')
                changes.append({'user': user, 'added': sorted(set(desired) - set(previous)), 'removed': sorted(set(previous) - set(desired))})
                new_users[user]['whitelist'] = previous
        need(restored == before, 'target release changes preserved Core identity, image, credentials or non-RPC settings')
        return changes

    @staticmethod
    def core_compatibility_options(old, new):
        # Comments/spacing are not configuration changes. Everything outside
        # release-owned RPC compatibility directives must remain identical.
        semantic = lambda data: [line.strip() for line in data.splitlines() if line.strip() and not line.lstrip().startswith(b'#')]
        strip = lambda data: [line for line in semantic(data) if not line.startswith((b'rpcwhitelist=', b'deprecatedrpc='))]
        need(strip(old) == strip(new), 'Core migration changed preserved chain, data, credentials or network settings')
        options = lambda data: sorted(line.decode().partition('=')[2] for line in semantic(data) if line.startswith(b'deprecatedrpc='))
        before, after = options(old), options(new)
        if before == after:
            return []
        need(all(re.fullmatch('[a-zA-Z0-9_,.-]+', value) for value in after), 'invalid Core compatibility option')
        return [{'option': 'deprecatedrpc', 'added': sorted(set(after) - set(before)), 'removed': sorted(set(before) - set(after))}]

    def miner(self):
        need(self.q['role'] in ['wallet', 'miner'], 'mining control requires the deployment mining node')
        matches = [c for c in self.all_containers() if
                   (c['Config'].get('Labels') or {}).get('dashnet.network') == self.q['config'] and
                   (c['Config'].get('Labels') or {}).get('dashnet.node') == self.node and
                   (c['Config'].get('Labels') or {}).get('com.docker.compose.service') == 'miner']
        need(len(matches) == 1, 'owned miner is missing or ambiguous')
        need(not self.q.get('expectedMiner') or matches[0]['Id'] == self.q['expectedMiner'], 'miner changed since review')
        return matches[0]

    def migration_ready(self):
        miner = self.miner()
        need(miner['State']['Running'] and not miner['State'].get('Paused'), 'miner unavailable for automatic Core migration')
        need(self.rpc('getblockchaininfo')['chain'] == self.q['coreChain'], 'mining node chain mismatch')
        run(['systemctl', '--version'])
        return {'minerId': miner['Id'], 'automaticRecoveryLease': True}

    def mining_pause(self):
        """Freeze blocks only in a quiet DKG window, with a crash recovery lease."""
        miner = self.miner()
        receipt = self.state / 'mining.json'
        if miner['State'].get('Paused'):
            need(receipt.exists() and read(receipt)['id'] == miner['Id'], 'miner paused outside this reset')
            height = self.rpc('getblockcount')
            need(13 <= height % 24 <= 23, 'paused miner outside quiet DKG window')
            # A retry may arrive near the old lease expiry. Renew before
            # starting another bounded migration, and recheck the pause.
            run(['systemctl', 'restart', read(receipt)['unit'] + '.timer'])
            need(self.miner()['State'].get('Paused'), 'mining pause expired during recovery')
            return {'quiet': True, 'height': height}
        need(miner['State']['Running'], 'miner was not running')
        height = self.rpc('getblockcount')
        if not 13 <= height % 24 <= 23:
            return {'quiet': False, 'height': height}
        unit = 'dash-status-miner-' + self.q['exec'].replace('.', '-')
        write(receipt, {'id': miner['Id'], 'unit': unit})
        # A killed controller must not leave mining frozen indefinitely. Each
        # per-node migration is bounded below this independent 15-minute lease.
        run(['systemd-run', '--unit', unit, '--on-active=15m', '--timer-property=AccuracySec=1s',
             '/usr/bin/docker', 'unpause', miner['Id']])
        run(['docker', 'pause', miner['Id']])
        time.sleep(2)  # let an in-flight one-block generate RPC finish
        height = self.rpc('getblockcount')
        if not 13 <= height % 24 <= 23:
            self.mining_resume()
            return {'quiet': False, 'height': height}
        need(self.miner()['State'].get('Paused'), 'mining pause not verified')
        return {'quiet': True, 'height': height}

    def mining_resume(self):
        receipt = self.state / 'mining.json'
        if not receipt.exists():
            return {'resumed': True}
        saved, miner = read(receipt), self.miner()
        need(saved['id'] == miner['Id'], 'owned miner changed during Core migration')
        if miner['State'].get('Paused'):
            run(['docker', 'unpause', miner['Id']])
        need(self.miner()['State']['Running'] and not self.miner()['State'].get('Paused'), 'mining resume not verified')
        # --collect is not universal for transient timers: stop both units so
        # the next per-node pause can reuse this operation's lease name.
        for suffix in ['.timer', '.service']:
            unit = saved['unit'] + suffix
            if run(['systemctl', 'show', '--property=LoadState', '--value', unit]).strip() != 'not-found':
                run(['systemctl', 'stop', unit])
        return {'resumed': True}

    def migration_guard(self, b, prepared):
        actual = self.snapshot()
        allowed_names = {name for name, value in b['preserve']['containers'].items()
                         if value['id'] in [x['id'] for x in b['coreServices'].values()]}
        need({k:v for k,v in actual['containers'].items() if k not in allowed_names} ==
             {k:v for k,v in b['preserve']['containers'].items() if k not in allowed_names}, 'unrelated containers changed during Core migration')
        allowed_files = {str((self.home / p).relative_to(self.root)) for p in prepared['coreFiles']}
        need({k:v for k,v in actual['files'].items() if k not in allowed_files} ==
             {k:v for k,v in b['preserve']['files'].items() if k not in allowed_files}, 'identity or unrelated files changed during Core migration')
        # Core data/Tor volumes and bind locations cannot move. An interrupted
        # Compose replacement may temporarily have no Core container.
        owned = self.owned_optional()
        for name, expected in b['coreServices'].items():
            if name in owned:
                need(sorted(owned[name]['Mounts'], key=lambda m:m['Destination']) == sorted(expected['mounts'], key=lambda m:m['Destination']) and owned[name]['Config']['Image'] == expected['image'], 'Core data mounts or image changed during migration')

    def owned_optional(self):
        # Same ownership selection, without requiring Core during a replacement.
        out = {}
        for c in self.all_containers():
            labels = c['Config'].get('Labels') or {}
            if labels.get('dashnet.network') == self.q['config'] and labels.get('dashnet.node') == self.node:
                service = labels.get('com.docker.compose.service')
                if service in ['core', 'core_tor']:
                    need(service not in out, 'duplicate owned Core service')
                    out[service] = c
        return out

    def core_restart(self):
        b = self.baseline_record()
        prepared = read(self.state / 'prepared.json')
        if not prepared.get('coreMigration'):
            self.preserved(b)
            return {'migrated': False, 'journal': self.journal_baseline()}
        need((self.state / 'wipe-started.json').exists(), 'Platform must be withdrawn before Core migration')
        for rel, value in prepared['files'].items():
            need(digest(self.state / 'render' / rel) == value, 'prepared migration files changed')
        marker = self.state / 'core-migration.json'
        if (self.state / 'baseline-effective.json').exists():
            self.preserved(b)
            return {'migrated': True, 'journal': b['journal']}
        if not marker.exists():
            self.preserved(b)
            write(marker, {'phase': 'applying', 'coreConfigBefore': b['journal']['preservation']['coreConfig']})
        self.migration_guard(b, prepared)
        stage = self.state / 'render'
        doc = read(self.home / 'config.json')
        doc['configs'][self.node]['core'] = read(stage / 'config.json')['configs'][self.node]['core']
        overrides = read(self.home / '.dashnet-compose.json')
        for name, fingerprint in prepared['coreFingerprints'].items():
            overrides['services'][name]['labels']['dashnet.config'] = fingerprint
        # On retry, keep already-converged containers. Stopping/removing data or
        # selecting a different image is never part of this configuration step.
        owned = self.owned_optional()
        converged = all(name in owned and owned[name]['State']['Running'] and
                        owned[name]['Config']['Labels'].get('dashnet.config') == fp
                        for name, fp in prepared['coreFingerprints'].items())
        if not converged:
            for name in ['core_tor', 'core']:
                if name in owned and owned[name]['State']['Running']:
                    run(['docker', 'stop', '--time', '120', owned[name]['Id']], timeout=150)
            write(self.home / 'config.json', doc)
            for rel in prepared['coreFiles']:
                destination = self.home / rel
                tmp = destination.with_name('.' + destination.name + '.migration')
                shutil.copy2(stage / rel, tmp)
                st = destination.stat()
                os.chown(tmp, st.st_uid, st.st_gid)
                os.replace(tmp, destination)
            write(self.home / '.dashnet-compose.json', overrides)
            self.compose(self.home, 'up', '-d', '--no-deps', *prepared['coreFingerprints'])
        return {'restarted': True}

    def core_migrate(self):
        # Retain the reviewed rolling path for older, already-confirmed plans.
        self.core_restart()
        return self.core_verify()

    def core_ready(self):
        return self.core_verify(finalize=False)

    def core_verify(self, finalize=True):
        b = self.baseline_record()
        prepared = read(self.state / 'prepared.json')
        if not prepared.get('coreMigration'):
            self.preserved(b)
            return {'migrated': False, 'journal': self.journal_baseline()}
        if (self.state / 'baseline-effective.json').exists():
            self.preserved(b)
            return {'migrated': True, 'journal': b['journal']}
        marker = self.state / 'core-migration.json'
        need(marker.exists() and (self.state / 'wipe-started.json').exists(), 'Core restart must precede migration verification')
        stage = self.state / 'render'
        for rel, value in prepared['files'].items():
            need(digest(stage / rel) == value, 'prepared migration files changed')
        doc = read(self.home / 'config.json')
        self.migration_guard(b, prepared)
        deadline = time.monotonic() + 300
        settled = None
        while True:
            try:
                self.migration_guard(b, prepared)
                info = self.rpc('getblockchaininfo')
                ready = (info['chain'] == self.q['coreChain'] and not info['initialblockdownload'] and
                         self.rpc('getblockhash', 1) == b['journal']['preservation']['coreGenesis'] and
                         self.rpc('mnsync', 'status').get('IsSynced') and
                         self.rpc('masternode', 'status').get('state') == 'READY' and self.rpc('getconnectioncount') >= 8)
                current_owned = self.owned_optional()
                ready = ready and all(name in current_owned and current_owned[name]['State']['Running'] and
                                      current_owned[name]['Config']['Labels'].get('dashnet.config') == fp
                                      for name, fp in prepared['coreFingerprints'].items())
                if ready and read(marker)['phase'] == 'applying':
                    # A restarted Core may accept peers before mnsync completes;
                    # reconnect now so both ends establish quorum authentication.
                    for peer in self.rpc('getpeerinfo'):
                        try:
                            self.rpc('disconnectnode', '', peer['id'])
                        except Fail:
                            pass  # peer may already have disconnected
                    write(marker, {'phase': 'reconnected', 'coreConfigBefore': b['journal']['preservation']['coreConfig']})
                    ready = False
                if ready and finalize:
                    valid = set(self.rpc('protx', 'list', 'valid'))
                    missing = [member for quorum in self.rpc('quorum', 'dkgstatus').get('quorumConnections', [])
                               for member in quorum.get('quorumConnections', [])
                               if member.get('proTxHash') in valid and not member.get('connected')]
                    ready = not missing
                if ready:
                    settled = settled or time.monotonic()
                    if time.monotonic() - settled >= 30:
                        break
                else:
                    settled = None
            except (Fail, KeyError):
                settled = None
            need(time.monotonic() < deadline, 'Core migration not READY, synchronized and reconnected')
            time.sleep(3)
        self.migration_guard(b, prepared)
        if not finalize:
            return {'ready': True}
        expected = hashlib.sha256(self.normalized(stage / self.node / 'core/dash.conf', (stage / self.node / 'core/dash.conf').read_bytes(), doc)).hexdigest()
        observed = self.journal_baseline()
        need(observed['preservation']['coreConfig'] == expected, 'Core migration configuration not verified')
        effective = {**b, 'preserve': self.snapshot(), 'configHash': digest(self.home / 'config.json'), 'journal': observed}
        write(self.state / 'baseline-effective.json', effective)
        write(marker, {'phase': 'complete', 'coreConfigBefore': b['journal']['preservation']['coreConfig'], 'coreConfigAfter': expected})
        return {'migrated': True, 'journal': observed}

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
        migration = self.core_changes(current['core'], c['core'])
        for change in migration:
            for method in change['added']:
                help_text = self.rpc('help', method)
                need(isinstance(help_text, str) and help_text.split()[0] == method, 'target RPC permission requires an unavailable Core method')
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
        return {'coreMigration': migration, 'sidecars': {s: raw[s]['image'] for s in selection if s in ['core_tor', 'gateway_rate_limiter', 'gateway_rate_limiter_redis']}}

    def render(self):
        release = self.release()
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
        # algorithm; migrate Core/Tor fingerprints only for reviewed RPC changes.
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
        # Keep salted credentials byte-identical; only the target release's
        # reviewed RPC access/compatibility lines may change in Core's config.
        core_files = []
        for path in (self.config / 'core').rglob('*'):
            if path.is_file():
                relative = path.relative_to(self.home)
                rendered = stage / relative
                need(rendered.is_file(), 'target release removed a preserved Core file')
                old_bytes = self.normalized(path, path.read_bytes(), doc)
                new_bytes = self.normalized(rendered, rendered.read_bytes(), doc)
                semantic = lambda data: b'\n'.join(line.strip() for line in data.splitlines() if line.strip() and not line.lstrip().startswith(b'#'))
                if semantic(old_bytes) != semantic(new_bytes):
                    need(path.name == 'dash.conf', 'unexpected Core file migration')
                    # Release templates also select Core RPC compatibility flags
                    # (beta.2 restores deprecated masternode service/port fields).
                    # No chain, wallet, image, auth or network directive may move.
                    release['coreMigration'].extend(self.core_compatibility_options(old_bytes, new_bytes))
                    auth = [line for line in path.read_bytes().splitlines(keepends=True) if line.startswith(b'rpcauth=')]
                    lines = iter(auth)
                    rendered.write_bytes(b''.join(next(lines) if line.startswith(b'rpcauth=') else line for line in rendered.read_bytes().splitlines(keepends=True)))
                    core_files.append(str(relative))
                else:
                    rendered.write_bytes(path.read_bytes())
        selection = [s for s in ['core', 'core_tor', *b['platform']] if s in services]
        fingerprints = {}
        for name in selection:
            model = copy.deepcopy(services[name])
            (model.get('labels') or {}).pop('dashnet.config', None)
            files = {}
            ssl = self.config / 'platform/gateway/ssl'
            for mount in model.get('volumes', []):
                source = Path(mount.get('source') or '/')
                if mount.get('type') == 'bind' and source.is_relative_to(self.home) and not source.is_relative_to(ssl):
                    relative = source.relative_to(self.home)
                    path = stage / relative
                    content = lambda p: hashlib.sha256(self.normalized(p, p.read_bytes(), doc)).hexdigest()
                    files[str(relative)] = ({str(p.relative_to(path)): content(p) for p in sorted(path.rglob('*')) if p.is_file()}
                                            if path.is_dir() else content(path) if path.exists() else None)
            entry = [model, files]
            if name == 'core_tor':
                entry.append(fingerprints['core'])
            fingerprints[name] = hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()
            overrides['services'][name]['labels']['dashnet.config'] = fingerprints[name]
        if not release['coreMigration']:
            for name in ['core', 'core_tor']:
                if name in live:
                    need(fingerprints[name] == live[name]['labels']['dashnet.config'], 'preserved Core fingerprint differs')
        write(stage / '.dashnet-compose.json', overrides)
        self.preserved(b)
        write(self.state / 'prepared.json', {'anchor': self.q['anchorHeight'], 'coreMigration': release['coreMigration'], 'coreFiles': core_files, 'coreFingerprints': {s: fingerprints[s] for s in ['core', 'core_tor'] if s in fingerprints}, 'images': self.desired(), 'platform': {s: {'image': services[s]['image']} for s in b['platform']}, 'files': {str(p.relative_to(stage)): digest(p) for p in stage.rglob('*') if p.is_file()}})
        return {'checks': {'coreSectionUnchanged': not bool(release['coreMigration']), 'coreChainPreserved': True, 'coreMigration': release['coreMigration'], 'nodeKeyUnchanged': True, 'genesisOnlyAnchorChanged': True,
                           'anchor': self.q['anchorHeight'], 'epochTime': b['epochTime'], 'epochEnv': b['epochTime'], 'genesisChainId': new['chain_id']}, 'images': self.desired(), 'rendered': ['Target release Platform configuration and Compose templates', 'dashnet reset anchor and identity record']}

    def prewipe(self):
        b = self.baseline_record()
        if (self.state / 'core-migration.json').exists() and not (self.state / 'baseline-effective.json').exists():
            self.migration_guard(b, read(self.state / 'prepared.json'))
        else:
            self.preserved(b)
        need((self.state / 'prepared.json').is_file(), 'canary missing')
        prepared = read(self.state / 'prepared.json')
        need(prepared['images'] == self.desired(), 'reviewed target images changed')
        for rel, value in prepared['files'].items():
            need(digest(self.state / 'render' / rel) == value, 'prepared files changed')
        for ref in [*prepared['images'].values(), *[v['image'] for v in prepared['platform'].values()]]:
            run(['docker', 'image', 'inspect', ref])
        if not (self.state / 'wipe-started.json').exists():
            owned = self.owned()
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
        need(not prepared.get('coreMigration') or (self.state / 'baseline-effective.json').exists(), 'required Core migration has not completed')
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
                'core': {'chainPreserved': True, 'configurationMigrated': bool(prepared.get('coreMigration'))}, 'restarts': {s:c['RestartCount'] for s,c in owned.items() if s in PLATFORM and c['RestartCount']}}


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
            method = {'anchor-check':'anchor_check','canary':'render','journal-baseline':'journal_baseline','journal-commit':'journal_commit','core-migrate':'core_migrate','core-restart':'core_restart','core-verify':'core_verify','core-ready':'core_ready','mining-pause':'mining_pause','mining-resume':'mining_resume','migration-ready':'migration_ready'}.get(stage, stage)
            need(method in ['baseline','stage','anchor','anchor_check','render','release','journal_baseline','journal_commit','core_migrate','core_restart','core_verify','core_ready','mining_pause','mining_resume','migration_ready','prewipe','wipe','apply','start','verify'], 'invalid stage')
            def timed_out(_signum, _frame):
                raise TimeoutError('Core migration timed out; mining recovery lease remains armed')
            if method in ['core_migrate', 'core_restart', 'core_verify', 'core_ready']:
                signal.signal(signal.SIGALRM, timed_out)
                signal.alarm(600)
            try:
                result = getattr(reset, method)()
            finally:
                signal.alarm(0)
        print(json.dumps({'ok': True, 'stage': stage, 'result': result}))
    except Exception as error:
        print(json.dumps({'ok': False, 'stage': stage, 'error': str(error) if isinstance(error, Fail) else type(error).__name__}))


if __name__ == '__main__':
    main()
