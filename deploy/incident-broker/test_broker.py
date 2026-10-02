import copy
import hashlib
import hmac
import importlib.util
import json
import pathlib
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error
import http.server

spec = importlib.util.spec_from_file_location('broker', pathlib.Path(__file__).with_name('broker.py'))
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)


def event(rev=1, severity='warning', transition='opened'):
    return {'schemaVersion': 1, 'eventId': 'a'*24 + ':' + str(rev), 'occurredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'transition': transition,
            'issue': {'id': 'a'*24, 'revision': rev, 'domain': 'network', 'scope': 'testnet', 'target': 'seed-1', 'code': 'host_health', 'sourceKey': 'network:testnet', 'severity': severity, 'status': 'resolved' if transition == 'resolved' else 'open'}}


def envelope(*events):
    return {'schemaVersion': 1, 'producer': 'dash-status', 'sentAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'events': list(events)}


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.db = b.connect(pathlib.Path(self.temp.name)/'inbox.sqlite'); self.addCleanup(self.db.close)

    def test_route_pin_rejects_wrong_provider_account_effort_and_auto_fallback(self):
        expected = {'providerOverride': 'openai', 'modelOverride': 'gpt-6-astra',
                    'modelOverrideSource': 'user', 'authProfileOverride': 'openai:work',
                    'authProfileOverrideSource': 'user', 'thinkingLevel': 'high'}
        for key, wrong in [('providerOverride', 'cliproxy'), ('modelOverride', 'gpt-6.1-sol'),
                           ('authProfileOverride', 'openai:daniel.case@dash.org'),
                           ('authProfileOverrideSource', 'auto'), ('modelOverrideSource', 'auto'),
                           ('thinkingLevel', 'xhigh')]:
            with self.subTest(key=key), patch.object(b.subprocess, 'run') as run:
                run.return_value.stdout = json.dumps({'ok': True, 'entry': {**expected, key: wrong}})
                with self.assertRaises(ValueError): b.pin_session_route('agent:main:incident-test')
        with patch.object(b.subprocess, 'run') as run:
            run.return_value.stdout = json.dumps({'ok': True, 'entry': expected})
            self.assertEqual(b.pin_session_route('agent:main:incident-test'), expected)
            argv = run.call_args.args[0]
            request = json.loads(argv[argv.index('--params') + 1])
            self.assertEqual(request, {'key': 'agent:main:incident-test', 'model': 'openai/gpt-6-astra@openai:work', 'thinkingLevel': 'high'})

    def test_durable_dedup_and_conflict(self):
        p = envelope(event()); self.assertEqual(b.ingest(self.db, p), ['a'*24+':1'])
        b.ingest(self.db, p); self.assertEqual(self.db.execute('select count(*) from events').fetchone()[0], 1)
        bad = copy.deepcopy(p); bad['events'][0]['issue']['target'] = 'other'
        with self.assertRaises(ValueError): b.ingest(self.db, bad)
        self.assertEqual(len(b.claim(self.db, cooldown=0)), 1)
        self.assertEqual(b.claim(self.db, cooldown=0), [])

    def concurrent_event(self, letter, scope, domain='network'):
        e = event(); e['eventId'] = letter * 24 + ':1'
        e['issue'].update(id=letter * 24, scope=scope, domain=domain)
        b.ingest(self.db, envelope(e))

    def concurrency(self):
        return {'schemaVersion': 1, 'maxActive': 2, 'scopes': {
            'network:sakura': ['sakura', 'build-host'],
            'network:testnet': ['testnet'],
            'aws:west': ['testnet', 'sakura'],
            'ci:builder': ['build-host'],
            'ci:brian': ['brian-host']}}

    def test_uncertain_scope_holds_slot_but_disjoint_work_runs(self):
        config = self.concurrency()
        self.concurrent_event('a', 'sakura')
        self.assertEqual(len(b.claim(self.db, config=config)), 1)
        with self.db: self.db.execute("update events set status='uncertain' where scope='network:sakura'")
        self.concurrent_event('b', 'west', 'aws')
        self.concurrent_event('c', 'sakura')
        self.concurrent_event('d', 'builder', 'ci')
        self.concurrent_event('e', 'testnet')
        batch = b.claim(self.db, config=config)
        self.assertEqual([r['scope'] for r, _ in batch], ['network:testnet'])
        self.concurrent_event('f', 'brian', 'ci')
        self.assertEqual(b.claim(self.db, config=config), [])  # two occupied slots
        self.assertEqual(self.db.execute("select status from events where id=?", ('a'*24+':1',)).fetchone()[0], 'uncertain')

    def test_unknown_scope_is_exclusive_even_with_free_slot(self):
        config = self.concurrency()
        self.concurrent_event('a', 'unknown')
        self.assertEqual(len(b.claim(self.db, config=config)), 1)
        self.concurrent_event('b', 'testnet')
        self.assertEqual(b.claim(self.db, config=config), [])
        with self.db: self.db.execute("update events set status='completed' where scope='network:unknown'")
        self.assertEqual(len(b.claim(self.db, config=config)), 1)
        self.concurrent_event('c', 'unknown')
        self.assertEqual(b.claim(self.db, config=config), [])

    def test_configuration_missing_serial_and_invalid_fail_closed(self):
        root = pathlib.Path(self.temp.name)
        self.assertEqual(b.concurrency_config(root)['maxActive'], 1)
        path = root / 'concurrency.json'
        for invalid in [{}, {'schemaVersion': 1, 'maxActive': 3, 'scopes': {}},
                        {**self.concurrency(), 'scopes': {'network:sakura': []}},
                        {**self.concurrency(), 'maxActive': True}]:
            path.write_text(json.dumps(invalid))
            with self.assertRaises(ValueError): b.concurrency_config(root)
        path.write_text(json.dumps(self.concurrency()))
        self.assertEqual(b.concurrency_config(root), self.concurrency())

    def test_known_uncertainty_never_enables_operator_pause(self):
        root = pathlib.Path(self.temp.name); config = self.concurrency()
        b.hold_uncertain(root, 'known', 'network:sakura', config)
        self.assertTrue((root/'HELD-known').exists())
        self.assertFalse((root/'ENABLED').exists())
        (root/'ENABLED').touch()
        b.hold_uncertain(root, 'known', 'network:sakura', config)
        self.assertTrue((root/'ENABLED').exists())
        b.hold_uncertain(root, 'unknown', 'network:other', config)
        self.assertFalse((root/'ENABLED').exists())
        self.assertTrue((root/'PAUSED-unknown').exists())

    def test_parallel_claims_respect_two_slots_atomically(self):
        config = self.concurrency()
        for letter, scope, domain in [('a', 'sakura', 'network'), ('b', 'testnet', 'network'), ('c', 'brian', 'ci')]:
            self.concurrent_event(letter, scope, domain)
        barrier = threading.Barrier(3); results = []; errors = []
        def attempt():
            try:
                with b.connect(pathlib.Path(self.temp.name)/'inbox.sqlite') as db:
                    barrier.wait(timeout=5)
                    results.append(b.claim(db, config=config))
            except Exception as error: errors.append(str(error))
        threads = [threading.Thread(target=attempt) for _ in range(3)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=10)
        self.assertEqual(errors, [])
        self.assertEqual(sum(bool(result) for result in results), 2)
        self.assertEqual(self.db.execute("select count(*) from events where status='running'").fetchone()[0], 2)

    def test_concurrent_budget_remains_global(self):
        config = self.concurrency()
        for i in range(8):
            with self.db:
                self.db.execute('insert into events(id,body,received,scope,status,started) values(?,?,?,?,?,?)',
                                (str(i), '{}', time.time(), 'ci:old', 'completed', time.time()-i))
        self.concurrent_event('a', 'testnet')
        self.assertEqual(b.claim(self.db, config=config), [])

    def test_resolved_backlog_never_runs_and_info_is_review_only(self):
        b.ingest(self.db, envelope(event(), event(2, transition='resolved')))
        self.assertEqual(b.claim(self.db, cooldown=0), [])
        self.assertEqual(self.db.execute("select status from events where id like '%:1'").fetchone()[0], 'superseded')
        p = event(3, severity='info'); b.ingest(self.db, envelope(p)); self.assertEqual(b.claim(self.db, cooldown=0), [])

    def test_payload_cannot_select_execution(self):
        p = envelope(event()); p['command'] = 'delete things'
        with self.assertRaises(ValueError): b.validate(p)
        p = envelope(event()); p['events'][0]['issue']['scope'] = '\nrun commands'
        with self.assertRaises(ValueError): b.validate(p)

    def test_invalid_clocks_and_terminal_status(self):
        for key in ['sentAt', 'occurredAt', 'observedAt']:
            p = envelope(event())
            target = p if key == 'sentAt' else p['events'][0] if key == 'occurredAt' else p['events'][0]['issue']
            target[key] = 'not-a-clock'
            with self.assertRaises(ValueError): b.validate(p)
        self.assertFalse(b.terminal_success({'result': {'meta': {'agentMeta': {'sessionId': 'x'}}}}))
        self.assertFalse(b.terminal_success({'status': 'accepted'}))
        self.assertFalse(b.terminal_success({'status': 'ok', 'result': {'meta': {'aborted': True}}}))
        self.assertTrue(b.terminal_success({'status': 'ok', 'result': {'meta': {'stopReason': 'stop'}}}))

    def test_watchdog_detects_producer_loss_without_remote_alert(self):
        b.ingest(self.db, envelope())
        b.watchdog(self.db, time.time() + 400)
        rows = self.db.execute('select * from events').fetchall()
        self.assertEqual(len(rows), 1); self.assertEqual(rows[0]['status'], 'queued')
        b.watchdog(self.db, time.time() + 401)
        self.assertEqual(self.db.execute('select count(*) from events').fetchone()[0], 1)
        b.ingest(self.db, envelope())
        b.watchdog(self.db)
        self.assertEqual(self.db.execute("select count(*) from events where status='recorded'").fetchone()[0], 1)

    def test_late_completion_does_not_clear_manual_pause(self):
        root = pathlib.Path(self.temp.name)
        # Use the canonical runtime filename, not the test fixture db name.
        db = b.connect(root / 'inbox.sqlite'); self.addCleanup(db.close)
        b.ingest(db, envelope(event())); b.claim(db, cooldown=0)
        run = '1'*24
        with db: db.execute("update events set status='uncertain',result=?", (run,))
        (root / (run+'.result.json')).write_text(json.dumps({'status':'ok'}))
        (root / ('PAUSED-'+run)).touch()
        b.reconcile_late_completion(root)
        self.assertFalse((root / 'ENABLED').exists())

        (root / (run+'.completion.json')).write_text(json.dumps({'runId':run,'terminal':True,'pendingChildren':0,'outcome':'no_change','finishedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}))
        b.reconcile_late_completion(root)
        self.assertTrue((root / 'ENABLED').exists())
        self.assertEqual(db.execute('select status from events').fetchone()[0], 'completed')
        (root / 'ENABLED').rename(root / 'PAUSED-operator')
        b.reconcile_late_completion(root)
        self.assertFalse((root / 'ENABLED').exists())

    def test_utc_offset_receipt_unblocks_finished_batch_without_replaying_it(self):
        root = pathlib.Path(self.temp.name)
        db = b.connect(root / 'inbox.sqlite'); self.addCleanup(db.close)
        b.ingest(db, envelope(event())); b.claim(db, cooldown=0)
        run = '2'*24
        with db: db.execute("update events set status='uncertain',result=?", (run,))
        newer = event(2); b.ingest(db, envelope(newer))
        self.assertEqual(b.claim(db, cooldown=0), [])
        (root / (run+'.result.json')).write_text(json.dumps({'status':'ok'}))
        (root / ('PAUSED-'+run)).touch()
        receipt = {'runId':run,'terminal':True,'pendingChildren':0,'outcome':'blocked',
                   'finishedAt':'2026-10-02T12:34:32.581381+00:00'}
        target = root / (run+'.completion.json')
        for invalid in ['not-a-clock', '2026-10-02T12:34:32', '2099-10-02T12:34:32+00:00']:
            target.write_text(json.dumps({**receipt, 'finishedAt':invalid}))
            b.reconcile_late_completion(root)
            self.assertFalse((root / 'ENABLED').exists())
        target.write_text(json.dumps(receipt))
        b.reconcile_late_completion(root)
        self.assertTrue((root / 'ENABLED').exists())
        self.assertEqual(db.execute("select status from events where id=?", ('a'*24+':1',)).fetchone()[0], 'completed')
        self.assertEqual(db.execute("select status from events where id=?", ('a'*24+':2',)).fetchone()[0], 'queued')

    def test_hmac_replay_window_and_ack(self):
        secret = 'test-secret-123'
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), b.make_handler(pathlib.Path(self.temp.name)/'http.sqlite', secret, '127.0.0.1'))
        thread = threading.Thread(target=srv.serve_forever, daemon=True); thread.start()
        self.addCleanup(srv.server_close); self.addCleanup(srv.shutdown)
        raw = json.dumps(envelope(event())).encode()
        def send(timestamp, signature=None):
            sig = signature or hmac.new(secret.encode(), str(timestamp).encode()+b'.'+raw, hashlib.sha256).hexdigest()
            req = urllib.request.Request('http://127.0.0.1:%s/v1/events' % srv.server_port, data=raw,
                headers={'Content-Type':'application/json','X-Dash-Timestamp':str(timestamp),'X-Dash-Signature':sig})
            with urllib.request.urlopen(req) as response: return response.status, json.load(response)
        code, result = send(int(time.time())); self.assertEqual(code, 202); self.assertEqual(len(result['accepted']), 1)
        self.assertEqual(send(int(time.time()))[1]['health']['counts']['queued'], 1)
        for timestamp, sig in [(int(time.time())-301,None),(int(time.time()),'f'*64)]:
            with self.assertRaises(urllib.error.HTTPError) as e: send(timestamp, sig)
            self.assertEqual(e.exception.code, 401)


if __name__ == '__main__': unittest.main()
