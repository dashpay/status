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

    def test_durable_dedup_and_conflict(self):
        p = envelope(event()); self.assertEqual(b.ingest(self.db, p), ['a'*24+':1'])
        b.ingest(self.db, p); self.assertEqual(self.db.execute('select count(*) from events').fetchone()[0], 1)
        bad = copy.deepcopy(p); bad['events'][0]['issue']['target'] = 'other'
        with self.assertRaises(ValueError): b.ingest(self.db, bad)
        self.assertEqual(len(b.claim(self.db, cooldown=0)), 1)
        self.assertEqual(b.claim(self.db, cooldown=0), [])

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
