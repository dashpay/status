#!/usr/bin/env python3
"""Reconcile a managed devnet Explorer index after a Platform chain replacement.

Never deletes a database or changes Core/Platform. Old indexes and pg_dump backups
remain available. Exact installed Explorer images/configuration are retained.
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
import subprocess
import sys
import time
import urllib.request

SERVICES = ('explorer-indexer', 'explorer-api', 'explorer-migrate')


def need(ok, message):
    if not ok:
        raise RuntimeError(message)


def atomic(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, indent=2) + '\n')
    tmp.chmod(0o600)
    os.replace(tmp, path)


def environment(spec):
    value = spec.get('environment', {})
    return dict(x.split('=', 1) for x in value if '=' in x) if isinstance(value, list) else dict(value)


def retained_explorer(previous, generated):
    """Service redeploys must not downgrade a hotfixed image or undo DB rotation."""
    for name in SERVICES:
        old = previous.get('services', {}).get(name)
        if old:
            # Keep custom/pinned hotfix definitions. Ordinary versioned upstream
            # installs may still follow an explicitly selected Explorer release.
            if not old.get('image', '').startswith('ghcr.io/pshenmic/platform-explorer-'):
                generated['services'][name] = copy.deepcopy(old)
            db = environment(old).get('POSTGRES_DB')
            if db:
                generated['services'][name]['environment'] = {**environment(generated['services'][name]), 'POSTGRES_DB': db}
    return generated


class Explorer:
    def __init__(self, auxiliary, chain, root=Path('/opt/devnet-services')):
        need(re.fullmatch(r'devnet-[a-z0-9-]+/[a-z0-9-]+', auxiliary), 'managed devnet ownership required')
        need(chain.startswith('dash-devnet-'), 'devnet Platform chain required')
        self.auxiliary, self.chain, self.root = auxiliary, chain, root
        self.path = root / 'compose.json'
        self.record = root / 'explorer-chain'

    def run(self, args, timeout=180, stdout=None):
        p = subprocess.run(args, stdout=stdout or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        need(p.returncode == 0, f'{args[0]} failed (exit {p.returncode}); private state retained')
        return p.stdout.decode() if p.stdout is not None else ''

    def inspect(self, name):
        c = json.loads(self.run(['docker', 'inspect', 'devnet-services-' + name + '-1']))[0]
        labels = c['Config'].get('Labels', {})
        need(labels.get('dashnet.auxiliary') == self.auxiliary and labels.get('com.docker.compose.project') == 'devnet-services' and labels.get('com.docker.compose.service') == name, 'Explorer ownership mismatch')
        return c

    def sql(self, db, query):
        need(re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]{0,62}', db), 'invalid managed database name')
        return self.run(['docker', 'exec', 'devnet-services-postgres-1', 'sh', '-c',
                         'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -p 5433 -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -Atc "$2"', 'explorer-chain', db, query]).strip()

    def rpc(self, path):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(self.url.rstrip('/') + '/' + path, timeout=20) as f:
            value = json.load(f)
        need(not value.get('error'), 'Tenderdash RPC not ready')
        return value.get('result', value)

    def inventory(self):
        if not self.path.exists():
            return None
        self.spec = json.loads(self.path.read_text())
        installed = [s for s in SERVICES if s in self.spec.get('services', {})]
        if not installed:
            return None
        need(len(installed) == len(SERVICES), 'incomplete managed Explorer installation')
        self.containers = {s: self.inspect(s) for s in (*SERVICES, 'postgres')}
        envs = {s: dict(x.split('=', 1) for x in c['Config']['Env'] if '=' in x) for s, c in self.containers.items()}
        databases = {envs[s]['POSTGRES_DB'] for s in SERVICES}
        urls = {envs[s]['TENDERDASH_URL'] for s in ('explorer-indexer', 'explorer-api')}
        if len(databases) != 1:
            pending = [json.loads(p.read_text()) for p in self.record.glob('*/pending.json')]
            need(any(databases <= {p['from'], p['to']} for p in pending), 'Explorer database pointers disagree without a recovery receipt')
        need(len(urls) == 1, 'Explorer RPC pointers disagree')
        self.db, self.url = envs['explorer-indexer']['POSTGRES_DB'], next(iter(urls))
        need(self.containers['postgres']['State']['Running'], 'Explorer Postgres not running')
        return {'installed': True, 'database': self.db}

    def identity(self):
        block = self.rpc('block?height=1')
        need(block['block']['header']['chain_id'] == self.chain, 'Explorer RPC is on a different chain')
        value = block['block_id']['hash'].lower()
        need(re.fullmatch(r'[0-9a-f]{64}', value), 'invalid first block hash')
        return value

    def first(self, db):
        if not self.sql(db, "SELECT to_regclass('public.blocks')"):
            return ''
        return self.sql(db, 'SELECT lower(trim(hash)) FROM blocks WHERE height=1')

    def compose(self, *args):
        return self.run(['docker', 'compose', '-p', 'devnet-services', '-f', str(self.path), *args], timeout=300)

    def backup(self, directory, db):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        dump = directory / 'previous.dump'
        if dump.exists():
            return
        size = int(self.sql(db, 'SELECT pg_database_size(current_database())'))
        need(shutil.disk_usage(self.root).free > size * 2 + 512 * 1024**2, 'insufficient space to preserve Explorer database')
        tmp = directory / 'previous.dump.partial'
        with tmp.open('wb') as f:
            os.chmod(tmp, 0o600)
            self.run(['docker', 'exec', 'devnet-services-postgres-1', 'sh', '-c',
                      'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -h 127.0.0.1 -p 5433 -U "$POSTGRES_USER" -Fc "$1"', 'explorer-chain', db], timeout=600, stdout=f)
        need(tmp.stat().st_size > 0, 'empty Explorer backup')
        # Validate the archive without exposing or restoring its contents.
        with tmp.open('rb') as f:
            p = subprocess.run(['docker', 'exec', '-i', 'devnet-services-postgres-1', 'pg_restore', '--list'], stdin=f, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        need(p.returncode == 0, 'Explorer backup archive invalid')
        os.replace(tmp, dump)
        atomic(directory / 'backup.json', {'database': db, 'bytes': dump.stat().st_size, 'sha256': hashlib.sha256(dump.read_bytes()).hexdigest()})

    def verify(self, first_hash, timeout=300):
        deadline = time.monotonic() + timeout
        while True:
            try:
                need(self.identity() == first_hash, 'Platform chain changed during Explorer recovery')
                tip = int(self.rpc('status')['sync_info']['latest_block_height'])
                indexed = int(self.sql(self.db, 'SELECT coalesce(max(height),0) FROM blocks'))
                need(self.first(self.db) == first_hash, 'Explorer first block does not match Platform')
                need(0 <= tip - indexed <= 2, 'Explorer has not caught up')
                for s in ('explorer-indexer', 'explorer-api'):
                    c = self.inspect(s)
                    need(c['State']['Running'] and not c['State'].get('Restarting') and c['RestartCount'] == 0, 'Explorer service not stable')
                with urllib.request.urlopen('http://127.0.0.1:3005/status', timeout=20) as f:
                    status = json.load(f)
                api_height = int(status['api']['block']['height'])
                need(status['network'] == self.chain and 0 <= tip - api_height <= 2, 'Explorer API not following current chain')
                return {'firstBlock': first_hash, 'database': self.db, 'indexed': indexed, 'chain': tip, 'apiHeight': api_height}
            except Exception:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Explorer verification failed; databases, backup and recovery receipt preserved') from None
                time.sleep(3)

    def reconcile(self, expected_anchor=None, expected_first=None):
        if not self.inventory():
            return {'installed': False}
        first_hash = self.identity()
        if expected_first:
            need(first_hash == expected_first.lower(), 'Platform first block changed since review')
        if expected_anchor is not None:
            need(self.rpc('genesis')['genesis']['initial_core_chain_locked_height'] == expected_anchor, 'Platform reset anchor differs from confirmed operation')
        target = 'pe_chain_' + first_hash[:24]
        directory = self.record / first_hash
        pending = directory / 'pending.json'
        same = self.first(self.db) == first_hash
        empty = not self.first(self.db) and not int(self.sql(self.db, "SELECT count(*) FROM blocks"))
        if (not same and not empty) or pending.exists():
            if not pending.exists():
                need(self.db != target, 'target database belongs to another chain')
                # Quiesce only this derived-data writer before a consistent backup.
                self.compose('stop', 'explorer-indexer')
                self.backup(directory, self.db)
                atomic(directory / 'compose.before.json', self.spec)
                atomic(pending, {'from': self.db, 'to': target, 'firstBlock': first_hash})
            receipt = json.loads(pending.read_text())
            need(receipt['to'] == target and self.db in [receipt['from'], target], 'recovery database changed unexpectedly')
            need(self.identity() == first_hash, 'Platform changed before index replacement')
            self.compose('stop', 'explorer-indexer', 'explorer-api')
            if not self.sql('postgres', f"SELECT 1 FROM pg_database WHERE datname='{target}'"):
                self.sql('postgres', f'CREATE DATABASE "{target}" OWNER explorer TEMPLATE template0')
            if self.first(target):
                need(self.first(target) == first_hash, 'recovery database belongs to another chain')
            for s in SERVICES:
                self.spec['services'][s]['image'] = self.containers[s]['Image']
                self.spec['services'][s]['environment'] = {**environment(self.spec['services'][s]), 'POSTGRES_DB': target}
            atomic(self.path, self.spec)
            self.compose('up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', 'explorer-migrate')
            code = self.run(['docker', 'wait', 'devnet-services-explorer-migrate-1'], timeout=300).strip()
            need(code == '0', 'Explorer migration failed; old database and recovery state preserved')
            self.compose('up', '-d', '--no-deps', '--pull', 'never', 'explorer-indexer', 'explorer-api')
            self.db = target
        result = self.verify(first_hash)
        atomic(self.record / 'current.json', result)
        if pending.exists():
            atomic(directory / 'complete.json', result)
            pending.rename(directory / 'completed-pending.json')
        return {**result, 'installed': True, 'previousDatabasesPreserved': True}


def main():
    q = json.loads(base64.b64decode(sys.argv[1]))
    try:
        with open('/run/lock/devnet-services.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            e = Explorer(q['auxiliary'], q['chain'])
            result = e.inventory() if q.get('checkOnly') else e.reconcile(q.get('anchor'), q.get('firstBlock'))
        print(json.dumps({'ok': True, 'result': result or {'installed': False}}))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__}))
        sys.exit(1)


if __name__ == '__main__':
    main()
