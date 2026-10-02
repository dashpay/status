#!/usr/bin/env python3
"""Tailnet-only authenticated durable inbox. Remote evidence cannot select actions.

One worker owns execution. Ambiguous CLI completion is quarantined, never blindly
retried. Agent completion is not incident resolution (only fresh probes resolve).
"""
import argparse
import datetime
import hashlib
import hmac
import http.server
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import threading
import time
import urllib.request

MAX_BODY = 512 * 1024
ID = re.compile(r'^[a-f0-9]{24}:[1-9][0-9]{0,8}$')
DOMAIN = {'network', 'ci', 'aws'}
TRANSITIONS = {'opened', 'reopened', 'changed', 'resolved', 'reminder'}
MODEL = 'openai/gpt-6-astra'
AUTH_PROFILE = 'openai:work'
THINKING = 'high'


def pin_session_route(session):
    """Explicit user pins disable the Gateway fallback ladder and account rotation.
    Fail before model execution if the Gateway cannot persist the exact route.
    The profile reference is not a credential; its OAuth material stays in OpenClaw.
    """
    patch = {'key': session, 'model': MODEL + '@' + AUTH_PROFILE, 'thinkingLevel': THINKING}
    proc = subprocess.run(['docker', 'exec', 'infraclaw', 'openclaw', 'gateway', 'call',
                           'sessions.patch', '--params', json.dumps(patch), '--json'],
                          capture_output=True, text=True, timeout=45, check=True)
    reply = json.loads(proc.stdout)
    entry = reply.get('entry') or {}
    expected = {'providerOverride': 'openai', 'modelOverride': 'gpt-6-astra',
                'modelOverrideSource': 'user', 'authProfileOverride': AUTH_PROFILE,
                'authProfileOverrideSource': 'user', 'thinkingLevel': THINKING}
    if reply.get('ok') is not True or any(entry.get(k) != value for k, value in expected.items()):
        raise ValueError('required direct Astra/High work-account route was not pinned')
    return expected


def connect(path):
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('pragma journal_mode=WAL')
    db.execute('pragma synchronous=FULL')
    db.executescript('''
    create table if not exists events (
      id text primary key, body text not null, received real not null,
      scope text not null, status text not null default 'queued',
      started real, finished real, result text, session_key text);
    create table if not exists meta (key text primary key, value text not null);
    ''')
    return db


def clock_value(value, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z', value):
        raise ValueError('invalid observation timestamp')
    try:
        result = datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, OverflowError):
        raise ValueError('invalid observation timestamp') from None
    if result > time.time() + 60:
        raise ValueError('future observation timestamp')
    return result


def validate(payload):
    if not isinstance(payload, dict) or set(payload) != {'schemaVersion', 'producer', 'sentAt', 'events'} or payload['schemaVersion'] != 1 or payload['producer'] != 'dash-status':
        raise ValueError('invalid envelope')
    if not isinstance(payload['events'], list) or len(payload['events']) > 50:
        raise ValueError('invalid event list')
    clock_value(payload['sentAt'])
    for event in payload['events']:
        if not isinstance(event, dict) or event.get('schemaVersion') != 1 or not ID.fullmatch(str(event.get('eventId', ''))) or event.get('transition') not in TRANSITIONS:
            raise ValueError('invalid event')
        clock_value(event.get('occurredAt'))
        issue = event.get('issue')
        if not isinstance(issue, dict) or issue.get('domain') not in DOMAIN or issue.get('severity') not in {'info', 'warning', 'critical'} or issue.get('status') not in {'open', 'resolved'}:
            raise ValueError('invalid issue')
        if issue.get('id') != event['eventId'].split(':')[0] or issue.get('revision') != int(event['eventId'].split(':')[1]):
            raise ValueError('identity mismatch')
        clock_value(issue.get('observedAt'), optional=True)
        if (event['transition'] == 'resolved') != (issue['status'] == 'resolved'):
            raise ValueError('inconsistent transition')
        for key in ['scope', 'target', 'code', 'sourceKey']:
            if not isinstance(issue.get(key), str) or not 0 < len(issue[key]) <= 512 or any(ord(c) < 32 for c in issue[key]):
                raise ValueError('invalid issue key')
        if len(json.dumps(event)) > 24000:
            raise ValueError('event too large')
    return payload['events']


def ingest(db, payload):
    events = validate(payload)
    with db:
        # Check the whole batch before committing. Same id with different bytes
        # is corruption, not a successful duplicate acknowledgement.
        for event in events:
            body = json.dumps(event, sort_keys=True, separators=(',', ':'))
            old = db.execute('select body from events where id=?', (event['eventId'],)).fetchone()
            if old and old['body'] != body:
                raise ValueError('conflicting event id')
            issue = event['issue']
            state = 'recorded' if issue['severity'] == 'info' or event['transition'] == 'resolved' else 'queued'
            scope = issue['domain'] + ':' + issue['scope']
            db.execute('insert or ignore into events(id,body,received,scope,status) values(?,?,?,?,?)', (event['eventId'], body, time.time(), scope, state))
        # A local synthetic delivery test does not arm the production watchdog.
        if not events or any(e['issue']['code'] != 'pipeline_self_test' for e in events):
            db.execute('insert or replace into meta values(?,?)', ('last_heartbeat', str(time.time())))
    return [e['eventId'] for e in events]


def health(db):
    rows = db.execute('select status,count(*) n from events group by status').fetchall()
    heartbeat = db.execute("select value from meta where key='last_heartbeat'").fetchone()
    worker = db.execute("select value from meta where key='worker_heartbeat'").fetchone()
    mode = db.execute("select value from meta where key='worker_mode'").fetchone()
    oldest = db.execute("select min(received) at from events where status='queued'").fetchone()['at']
    return {'status': 'ok', 'workerAt': float(worker['value']) if worker else None, 'workerMode': mode['value'] if mode else 'unknown', 'oldestQueuedAt': oldest, 'counts': {r['status']: r['n'] for r in rows}, 'lastHeartbeat': float(heartbeat['value']) if heartbeat else None}


def make_handler(db_path, secret, allowed_peer):
    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, *_):
            pass  # no evidence/headers/credentials in access logs

        def reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            peer = self.client_address[0]
            # Tailscale Serve is the sole loopback proxy; it overwrites XFF.
            if peer == '127.0.0.1':
                peer = self.headers.get('X-Forwarded-For', '').split(',')[0].strip() or peer
            if self.path != '/v1/events' or peer != allowed_peer:
                return self.reply(403, {'error': 'forbidden'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                timestamp = int(self.headers.get('X-Dash-Timestamp', '0'))
            except ValueError:
                return self.reply(400, {'error': 'invalid headers'})
            if length <= 0 or length > MAX_BODY or self.headers.get('Transfer-Encoding'):
                return self.reply(413, {'error': 'invalid size'})
            if abs(time.time() - timestamp) > 300:
                return self.reply(401, {'error': 'expired signature'})
            raw = self.rfile.read(length)
            want = hmac.new(secret.encode(), str(timestamp).encode() + b'.' + raw, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(want, self.headers.get('X-Dash-Signature', '')):
                return self.reply(401, {'error': 'invalid signature'})
            try:
                with connect(db_path) as db:
                    accepted = ingest(db, json.loads(raw))
                    result = health(db)
            except (ValueError, UnicodeError, TypeError):
                return self.reply(400, {'error': 'invalid or conflicting event'})
            return self.reply(202, {'accepted': accepted, 'health': result})
    return Handler


def watchdog(db, now=None):
    """Local clock detects loss of the remote producer, even if status is down."""
    now = time.time() if now is None else now
    row = db.execute("select value from meta where key='last_heartbeat'").fetchone()
    if not row:
        return
    stale = now - float(row['value']) > 300
    old = db.execute("select value from meta where key='producer_stale'").fetchone()
    was_stale = old and old['value'] == '1'
    if stale == bool(was_stale):
        return
    ident = hashlib.sha256(b'dash-status-producer-heartbeat').hexdigest()[:24]
    count = db.execute('select count(*) n from events where id like ?', (ident + ':%',)).fetchone()['n'] + 1
    event = {'schemaVersion': 1, 'eventId': ident + ':' + str(count), 'occurredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now)),
             'transition': 'opened' if stale else 'resolved', 'issue': {'id': ident, 'revision': count, 'domain': 'network', 'scope': 'status',
             'target': 'status-producer', 'code': 'producer_heartbeat_lost', 'sourceKey': 'receiver:heartbeat', 'severity': 'critical',
             'status': 'open' if stale else 'resolved', 'summary': 'Dash status producer heartbeat missing for over five minutes'}}
    with db:
        db.execute('insert into events(id,body,received,scope,status) values(?,?,?,?,?)', (event['eventId'], json.dumps(event,sort_keys=True,separators=(',',':')), now, 'network:status', 'queued' if stale else 'recorded'))
        db.execute('insert or replace into meta values(?,?)', ('producer_stale', '1' if stale else '0'))


def claim(db, cooldown=900):
    with db:
        db.execute('begin immediate')
        # Concurrent processes and restart ambiguity cannot acquire another turn.
        if db.execute("select 1 from events where status in ('running','uncertain') limit 1").fetchone():
            return []
        # Admission budget: eight serialized batches/hour, 48/day; pending work
        # remains durable. Prevents flapping telemetry from creating a cost storm.
        for window, cap in [(3600, 8), (86400, 48)]:
            count = db.execute('select count(distinct started) n from events where started>?', (time.time()-window,)).fetchone()['n']
            if count >= cap:
                return []
        scopes = db.execute("select scope,min(received) oldest from events where status='queued' group by scope order by oldest").fetchall()
        for scope in scopes:
            recent = db.execute("select max(started) at from events where scope=? and status in ('completed','uncertain')", (scope['scope'],)).fetchone()['at']
            if recent and recent > time.time() - cooldown:
                continue
            # Do not dispatch obsolete revisions/recovered issues from a backlog.
            rows = db.execute("select * from events where scope=? and status='queued' order by received limit 50", (scope['scope'],)).fetchall()
            active = []
            for r in rows:
                issue_id, revision = r['id'].split(':')
                later = db.execute('select body from events where id like ?', (issue_id + ':%',)).fetchall()
                if any(int(json.loads(x['body'])['issue']['revision']) > int(revision) for x in later):
                    db.execute("update events set status='superseded',finished=? where id=?", (time.time(), r['id']))
                else:
                    active.append(r)
            if not active:
                continue
            # Stable per-scope session serializes network repairs across signals.
            session = 'agent:main:incident-' + hashlib.sha256(scope['scope'].encode()).hexdigest()[:20]
            started = time.time()
            for r in active:
                db.execute("update events set status='running',started=?,session_key=? where id=?", (started, session, r['id']))
            return [(dict(r), session) for r in active]
    return []


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


def refreshed_events(events, token_file):
    special = {'pipeline_self_test', 'producer_heartbeat_lost'}
    if all(e['issue']['code'] in special for e in events):
        return events
    token = pathlib.Path(token_file).read_text().strip()
    req = urllib.request.Request('https://status.testnet.networks.dash.org/api/issues', headers={'Authorization': 'Bearer ' + token})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError('issue snapshot oversized')
    snapshot = json.loads(raw)
    at = clock_value(snapshot.get('generatedAt'))
    if snapshot.get('stale') or time.time() - at > 180 or not isinstance(snapshot.get('sources'), dict):
        raise ValueError('fresh private issue snapshot unavailable')
    current = {i['id']: i for i in snapshot['issues']}
    result = []
    for event in events:
        if event['issue']['code'] in special:
            result.append(event)
            continue
        issue = current.get(event['issue']['id'])
        if not issue or issue.get('status') != 'open' or issue.get('revision') != event['issue']['revision']:
            continue
        # Current producer confirmation is only triage admission. The fixed agent
        # policy still requires independent live reproduction before any repair.
        result.append({**event, 'issue': issue, 'refreshedAt': snapshot['generatedAt']})
    return result


def terminal_success(reply):
    # Explicit terminal success, not metadata presence or process exit alone.
    if not isinstance(reply, dict) or reply.get('status') != 'ok':
        return False
    result = reply.get('result') or {}
    meta = result.get('meta') or {}
    return not meta.get('aborted') and meta.get('stopReason') not in {'error', 'aborted', 'yield', 'tool_budget_exceeded'}


def receipt_complete(root, run):
    try:
        receipt = json.loads((root / (run + '.completion.json')).read_text())
        finished = receipt.get('finishedAt')
        # The task requests a UTC ISO timestamp. Python's timezone-aware
        # isoformat emits +00:00, which is equivalent to Z. Keep strict external
        # observation validation unchanged and accept both UTC receipt forms.
        if isinstance(finished, str) and finished.endswith('+00:00'):
            finished = finished[:-6] + 'Z'
        clock_value(finished)
        return receipt.get('runId') == run and receipt.get('terminal') is True and receipt.get('pendingChildren') == 0 and receipt.get('outcome') in {'resolved', 'blocked', 'no_change'}
    except (OSError, ValueError, TypeError):
        return False


def reconcile_late_completion(root):
    """A yielded turn may finish after its CLI returns. Resume only with both
    explicit successful CLI result and its terminal no-children receipt; never
    clear an operator pause or infer success from elapsed time."""
    with connect(root / 'inbox.sqlite') as db:
        runs = db.execute("select distinct result from events where status='uncertain' and result is not null").fetchall()
        for row in runs:
            run = row['result']
            try:
                reply = json.loads((root / (run + '.result.json')).read_text())
            except (OSError, ValueError):
                continue
            if not terminal_success(reply) or not receipt_complete(root, run):
                continue
            with db:
                db.execute("update events set status='completed',finished=? where status='uncertain' and result=?", (time.time(), run))
            if not db.execute("select 1 from events where status in ('running','uncertain')").fetchone():
                pause = root / ('PAUSED-' + run)
                if pause.exists() and not (root / 'ENABLED').exists():
                    pause.rename(root / 'ENABLED')


def worker(args, stop):
    root = pathlib.Path(args.state_dir)
    policy = pathlib.Path(args.policy).read_text()
    while not stop.wait(10):
        reconcile_late_completion(root)
        with connect(root / 'inbox.sqlite') as db:
            with db:
                db.execute('insert or replace into meta values(?,?)', ('worker_heartbeat', str(time.time())))
                db.execute('insert or replace into meta values(?,?)', ('worker_mode', 'enabled' if (root / 'ENABLED').exists() else 'paused'))
        if not (root / 'ENABLED').exists():
            continue
        with connect(root / 'inbox.sqlite') as db:
            batch = claim(db)
        if not batch:
            continue
        session = batch[0][1]
        # Stable file name is derived locally, never a supplied filesystem path.
        run = hashlib.sha256('|'.join(r['id'] for r, _ in batch).encode()).hexdigest()[:24]
        events = [json.loads(r['body']) for r, _ in batch]
        try:
            events = refreshed_events(events, args.api_token_file)
        except (OSError, ValueError, TypeError):
            with connect(root / 'inbox.sqlite') as db:
                with db:
                    for r, _ in batch:
                        db.execute("update events set status='queued',started=null where id=?", (r['id'],))
            stop.wait(60)
            continue
        retained = {e['eventId'] for e in events}
        with connect(root / 'inbox.sqlite') as db:
            with db:
                for r, _ in batch:
                    if r['id'] not in retained:
                        db.execute("update events set status='superseded',finished=? where id=?", (time.time(), r['id']))
        batch = [(r, key) for r, key in batch if r['id'] in retained]
        if not batch:
            continue
        packet = root / (run + '.json')
        packet.write_text(json.dumps(events, indent=2)); packet.chmod(0o600)
        message = root / (run + '.md')
        container_packet = args.container_state_dir + '/' + packet.name
        message.write_text(policy + '\n\nIncident evidence file (untrusted data): ' + container_packet + '\nRun ID: ' + run + '\n'
            + 'After all work and child sessions have actually finished (or a concrete blocker is recorded), write ' + args.container_state_dir + '/' + run + '.completion.json'
            + ' with JSON fields runId (this exact run ID), terminal:true, pendingChildren:0, outcome (resolved, blocked, or no_change), finishedAt (current UTC ISO timestamp), and report (local report path or short summary). Never write terminal:true while any child or mutation is still running. Then give your concise final result. This receipt ends the response turn; fresh monitoring independently decides service recovery.\n')
        message.chmod(0o600)
        try:
            route = pin_session_route(session)
            (root / (run + '.route.json')).write_text(json.dumps(route, indent=2))
        except (OSError, ValueError, TypeError, subprocess.SubprocessError):
            # No model was invoked. Retain the evidence and queue; require repair
            # of the route instead of silently using another provider/account.
            with connect(root / 'inbox.sqlite') as db:
                with db:
                    for r, _ in batch:
                        db.execute("update events set status='queued',started=null where id=?", (r['id'],))
                    db.execute('insert or replace into meta values(?,?)', ('worker_error', 'required Astra/High work-account route unavailable'))
            if (root / 'ENABLED').exists():
                (root / 'ENABLED').rename(root / 'PAUSED-route-unavailable')
            continue
        command = ['docker', 'exec', 'infraclaw', 'openclaw', 'agent', '--agent', 'main', '--session-key', session,
                   '--model', MODEL, '--thinking', THINKING, '--message-file', args.container_state_dir + '/' + message.name, '--json', '--timeout', '3600']
        # No shell and no remote fields in argv. No --deliver: private sessions.
        result = 'uncertain'
        with connect(root / 'inbox.sqlite') as db:
            with db:
                db.execute('insert or replace into meta values(?,?)', ('worker_mode', 'running'))
        try:
            with (root / (run + '.result.json')).open('wb') as out:
                proc = subprocess.run(command, stdout=out, stderr=subprocess.STDOUT, timeout=3660, check=False)
            if proc.returncode == 0:
                reply = json.loads((root / (run + '.result.json')).read_text())
                # CLI success alone is not evidence that a model turn completed.
                if terminal_success(reply) and receipt_complete(root, run):
                    result = 'completed'
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        with connect(root / 'inbox.sqlite') as db:
            with db:
                for r, _ in batch:
                    db.execute('update events set status=?,finished=?,result=? where id=?', (result, time.time(), run, r['id']))
        # Uncertain execution can continue server-side: no subsequent worker
        # activity until an operator/agent reconciles the actual session.
        if result == 'uncertain':
            if (root / 'ENABLED').exists():
                (root / 'ENABLED').rename(root / ('PAUSED-' + run))
        print(json.dumps({'run': run, 'state': result, 'events': len(batch)}), flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--bind', required=True)
    p.add_argument('--peer', required=True)
    p.add_argument('--port', type=int, default=8789)
    p.add_argument('--state-dir', required=True)
    p.add_argument('--container-state-dir', required=True)
    p.add_argument('--secret-file', required=True)
    p.add_argument('--policy', required=True)
    p.add_argument('--api-token-file', required=True)
    args = p.parse_args()
    if args.bind != '127.0.0.1':
        p.error('receiver binds loopback behind tailnet-only HTTPS Serve')
    for ip in [args.peer]:
        parts = ip.split('.')
        if len(parts) != 4 or not all(x.isdigit() for x in parts) or int(parts[0]) != 100 or not 64 <= int(parts[1]) <= 127 or not all(0 <= int(x) <= 255 for x in parts):
            p.error('peer must be a literal Tailscale IPv4 address')
    os.umask(0o077)
    root = pathlib.Path(args.state_dir); root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with connect(root / 'inbox.sqlite') as db:
        if db.execute("select 1 from events where status='running'").fetchone() and (root / 'ENABLED').exists():
            (root / 'ENABLED').rename(root / 'PAUSED-restart-uncertainty')
    authority = json.loads((root / 'authorization.json').read_text())
    if authority.get('enabled') is not True or authority.get('source') != 'owner-direct' or not authority.get('sourceSession'):
        p.error('local owner authorization record required')
    secret = pathlib.Path(args.secret_file).read_text().strip()
    if len(secret) < 32:
        p.error('HMAC secret must have at least 32 characters')
    stop = threading.Event()
    def watch_loop():
        while not stop.wait(30):
            with connect(root / 'inbox.sqlite') as db:
                watchdog(db)
    threading.Thread(target=watch_loop, daemon=True).start()
    thread = threading.Thread(target=worker, args=(args, stop), daemon=True); thread.start()
    server = http.server.ThreadingHTTPServer((args.bind, args.port), make_handler(root / 'inbox.sqlite', secret, args.peer))
    server.daemon_threads = True
    try:
        server.serve_forever()
    finally:
        stop.set(); server.server_close()


if __name__ == '__main__':
    main()
