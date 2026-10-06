import copy
import datetime
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
        self.ended = (time.time() + 5) * 1000
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.db = b.connect(pathlib.Path(self.temp.name)/'inbox.sqlite'); self.addCleanup(self.db.close)

    def done(self):
        return {'status': 'done', 'endedAt': self.ended, 'lastRunId': 'test-runtime-run', 'abortedLastRun': False}

    def reconcile(self, root):
        reader = lambda session: self.done()
        b.reconcile_sessions(root, reader, now=time.time())
        return b.reconcile_sessions(root, reader, now=time.time()+31)

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

    def test_refresh_rechecks_operation_maintenance_for_already_queued_events(self):
        first=event(); other=copy.deepcopy(first)
        other['eventId']='b'*24+':1'; other['issue']['id']='b'*24; other['issue']['scope']='other'
        snapshot={'generatedAt':envelope()['sentAt'],'sources':{},'issues':[first['issue'],other['issue']],
                  'maintenance':{'testnet':{'active':True}}}
        token=pathlib.Path(self.temp.name)/'token'; token.write_text('fixture')
        with patch.object(b.urllib.request,'build_opener') as opener:
            response=opener.return_value.open.return_value.__enter__.return_value
            response.read.return_value=json.dumps(snapshot).encode()
            self.assertEqual([x['eventId'] for x in b.refreshed_events([first,other],token)],[other['eventId']])
            snapshot['maintenance']={}; snapshot['issues'][0]['suppressed']=True
            response.read.return_value=json.dumps(snapshot).encode()
            self.assertEqual([x['eventId'] for x in b.refreshed_events([first,other],token)],[other['eventId']])
            snapshot['issues'][0]['suppressed']=False
            response.read.return_value=json.dumps(snapshot).encode()
            self.assertEqual(len(b.refreshed_events([first,other],token)),2)

    def test_durable_dedup_and_conflict(self):
        p = envelope(event()); self.assertEqual(b.ingest(self.db, p), ['a'*24+':1'])
        b.ingest(self.db, p); self.assertEqual(self.db.execute('select count(*) from events').fetchone()[0], 1)
        bad = copy.deepcopy(p); bad['events'][0]['issue']['target'] = 'other'
        with self.assertRaises(ValueError): b.ingest(self.db, bad)
        self.assertEqual(len(b.claim(self.db, cooldown=0)), 1)
        self.assertEqual(b.claim(self.db, cooldown=0), [])

    def test_readmission_does_not_reuse_previous_attempt_artifacts(self):
        b.ingest(self.db, envelope(event()))
        rows = [row for row, _ in b.claim(self.db, cooldown=0)]
        self.assertEqual(rows[0]['started'], self.db.execute('select started from events').fetchone()['started'])
        first = b.attempt_id(rows)
        self.assertEqual(first, b.attempt_id(copy.deepcopy(rows)))
        with self.db:
            self.db.execute("update events set status='queued', started=null")
        rows = [row for row, _ in b.claim(self.db, cooldown=0)]
        self.assertNotEqual(first, b.attempt_id(rows))

    def test_issue_specific_outcomes_do_not_inherit_other_issue_blocker(self):
        root = pathlib.Path(self.temp.name)
        first = event(); second = event(); second['eventId'] = 'b'*24 + ':1'; second['issue']['id'] = 'b'*24
        b.ingest(self.db, envelope(first, second))
        run = '1'*24
        with self.db:
            self.db.execute("update events set status='completed', result=?, finished=?", (run, time.time()))
        (root / (run + '.completion.json')).write_text(json.dumps({
            'runId': run, 'terminal': True, 'pendingChildren': 0, 'outcome': 'blocked',
            'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'blocker': 'Wallet disk still open',
            'issues': {'a'*24: {'outcome': 'resolved', 'blocker': None, 'summary': 'Node revived'}}
        }))
        cases = {c['issueId']: c['lastResponse'] for c in b.remediation_snapshot(self.db, root)['cases']}
        self.assertEqual(cases['a'*24]['outcome'], 'resolved')
        self.assertIsNone(cases['a'*24]['blocker'])
        self.assertEqual(cases['b'*24]['outcome'], 'blocked')
        (root / 'presentations.json').write_text(json.dumps({run: {'issues': {'b'*24: {'outcome': 'INVALID'}}}}))
        cases = {c['issueId']: c['lastResponse'] for c in b.remediation_snapshot(self.db, root)['cases']}
        self.assertEqual(cases['b'*24]['outcome'], 'blocked')

    def test_board_snapshot_keeps_owner_and_does_not_infer_recovery(self):
        root = pathlib.Path(self.temp.name)
        b.ingest(self.db, envelope(event()))
        run = '1' * 24
        with self.db:
            self.db.execute("update events set status='completed', result=?, finished=?", (run, time.time()))
        (root / (run + '.completion.json')).write_text(json.dumps({
            'runId': run, 'terminal': True, 'pendingChildren': 0, 'outcome': 'blocked',
            'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'report': '/private/report.md', 'summary': 'Partial mitigation', 'changes': ['Rotation repaired'],
        }))
        (root / 'presentations.json').write_text(json.dumps({run: {'blocker': 'Owner action needed'}}))
        b.ingest(self.db, envelope(event(2)))
        with self.db:
            self.db.execute("update events set status='uncertain', result=?, started=? where id=?",
                            ('2' * 24, time.time(), 'a' * 24 + ':2'))
        b.ingest(self.db, envelope(event(3)))
        before = [dict(r) for r in self.db.execute('select * from events')]
        result = b.remediation_snapshot(self.db, root)
        self.assertEqual(len(result['cases']), 1)
        case = result['cases'][0]
        self.assertTrue(case['active'])
        self.assertEqual(case['runId'], '2' * 24)
        self.assertEqual(case['pendingEvents'], 1)
        self.assertEqual(case['lastResponse']['outcome'], 'blocked')
        self.assertEqual(case['lastResponse']['blocker'], 'Owner action needed')
        self.assertEqual(case['lastResponse']['changes'], ['Rotation repaired'])
        self.assertNotIn('/private/', json.dumps(result))
        self.assertEqual(before, [dict(r) for r in self.db.execute('select * from events')])
        # Legacy/malformed presentation files must not interrupt ACK delivery.
        (root / 'presentations.json').write_text('[]')
        self.assertEqual(b.health(self.db, root)['remediation']['cases'][0]['lastResponse']['summary'], 'Partial mitigation')

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

    def test_exact_binding_bypasses_broad_scope_but_persists_locks(self):
        config = self.concurrency()
        config['bindings'] = [{'scope':'aws:west','code':'host_health','target':'seed-1',
                               'resources':['testnet'],'identity':'verified testnet instance, reverify live'}]
        self.concurrent_event('a', 'sakura')
        b.claim(self.db, config=config)
        self.concurrent_event('b', 'west', 'aws')
        batch = b.claim(self.db, config=config)
        self.assertEqual(batch[0][0]['scope'], 'aws:west')
        with self.db: self.db.execute("update events set status='completed' where scope='network:sakura'")
        config['bindings'][0]['resources'] = ['somewhere-else']
        self.concurrent_event('c', 'testnet')
        self.assertEqual(b.claim(self.db, config=config), [])  # saved testnet lock still held
        snapshot = b.scheduler_snapshot(self.db, config, True)
        self.assertEqual(snapshot['queued'][0]['reason'], 'resource_conflict')
        self.assertEqual(snapshot['queued'][0]['heldBy'], ['aws:west'])

    def test_binding_does_not_match_different_target(self):
        config = self.concurrency()
        config['bindings'] = [{'scope':'aws:west','code':'host_health','target':'other',
                               'resources':['testnet'],'identity':'verified other instance'}]
        self.concurrent_event('a', 'sakura'); b.claim(self.db, config=config)
        self.concurrent_event('b', 'west', 'aws')
        self.assertEqual(b.claim(self.db, config=config), [])

    def uncertain_run(self, run='9'*24):
        root = pathlib.Path(self.temp.name)
        self.concurrent_event('a', 'sakura'); b.claim(self.db, config=self.concurrency())
        with self.db: self.db.execute("update events set status='uncertain',result=?", (run,))
        (root/'ENABLED').touch()
        (root/(run+'.result.json')).write_text(json.dumps({'status':'timeout','summary':'aborted'}))
        (root/('HELD-'+run)).touch()
        return root, run

    def write_receipt(self, root, run):
        receipt = {'runId':run,'terminal':True,'pendingChildren':0,'outcome':'blocked',
                   'finishedAt':datetime.datetime.fromtimestamp(time.time()+1,datetime.timezone.utc).isoformat()}
        (root/(run+'.completion.json')).write_text(json.dumps(receipt))
        return receipt

    def test_timeout_reconciles_only_fresh_receipt_and_two_idle_observations(self):
        root,run=self.uncertain_run(); self.write_receipt(root,run)
        original=(root/(run+'.result.json')).read_bytes(); now=time.time()
        b.reconcile_sessions(root,lambda _:self.done(),now)
        self.assertEqual(self.db.execute('select status from events').fetchone()[0],'uncertain')
        b.reconcile_sessions(root,lambda _:{**self.done(),'status':'running'},now+31)
        b.reconcile_sessions(root,lambda _:self.done(),now+62)
        self.assertEqual(self.db.execute('select status from events').fetchone()[0],'uncertain')
        b.reconcile_sessions(root,lambda _:self.done(),now+93)
        self.assertEqual(self.db.execute('select status from events').fetchone()[0],'completed')
        self.assertEqual((root/(run+'.result.json')).read_bytes(),original)
        self.assertTrue((root/(run+'.reconciled.json')).exists())

    def test_missing_receipt_requests_bookkeeping_only_once(self):
        root,run=self.uncertain_run(); now=time.time()
        b.reconcile_sessions(root,lambda _:self.done(),now)
        checks=b.reconcile_sessions(root,lambda _:self.done(),now+31)
        self.assertEqual(len(checks),1)
        from types import SimpleNamespace
        args=SimpleNamespace(state_dir=str(root),container_state_dir=str(root))
        with patch.object(b,'describe_session',return_value=self.done()), patch.object(b,'pin_session_route',return_value={}), patch.object(b.subprocess,'run') as execute:
            b.request_completion_check(args,checks[0]); b.request_completion_check(args,checks[0])
            self.assertEqual(execute.call_count,1)
            self.assertIn('--timeout',execute.call_args.args[0])
        self.assertEqual(b.reconcile_sessions(root,lambda _:self.done(),now+62),[])
        self.assertEqual(self.db.execute('select status from events').fetchone()[0],'uncertain')

    def test_bookkeeping_does_not_interrupt_new_owner_turn(self):
        root,run=self.uncertain_run(); now=time.time()
        b.reconcile_sessions(root,lambda _:self.done(),now)
        checks=b.reconcile_sessions(root,lambda _:self.done(),now+31)
        from types import SimpleNamespace
        args=SimpleNamespace(state_dir=str(root),container_state_dir=str(root))
        for live in [{**self.done(),'status':'running'}, {**self.done(),'lastRunId':'new-owner-turn'}]:
            with patch.object(b,'describe_session',return_value=live), patch.object(b,'pin_session_route') as pin:
                b.request_completion_check(args,checks[0]);pin.assert_not_called()

    def test_stale_aborted_and_children_receipts_never_release(self):
        root,run=self.uncertain_run(); receipt=self.write_receipt(root,run)
        p=root/(run+'.completion.json')
        for extra in [{'finishedAt':'2026-01-01T00:00:00Z'},{'pendingChildren':1},{'pendingChildren':False}]:
            p.write_text(json.dumps({**receipt,**extra}));self.reconcile(root)
            self.assertEqual(self.db.execute('select status from events').fetchone()[0],'uncertain')
        p.write_text(json.dumps(receipt));now=time.time()
        for t in [now,now+31]:b.reconcile_sessions(root,lambda _:{**self.done(),'abortedLastRun':True},t)
        self.assertEqual(self.db.execute('select status from events').fetchone()[0],'uncertain')

    def test_restart_recovers_running_as_hold_not_requeue(self):
        root=pathlib.Path(self.temp.name);config=self.concurrency()
        self.concurrent_event('a','sakura');b.claim(self.db,config=config)
        (root/'ENABLED').touch();b.recover_interrupted(root,config)
        row=self.db.execute('select * from events').fetchone()
        self.assertEqual(row['status'],'uncertain');self.assertTrue(row['result'])
        self.assertTrue((root/'ENABLED').exists());self.assertTrue((root/('HELD-'+row['result'])).exists())
        self.concurrent_event('b','testnet')
        self.assertEqual(len(b.claim(self.db,config=config)),1)

    def test_pause_gate_checked_inside_admission_transaction(self):
        self.concurrent_event('a', 'testnet')
        path=pathlib.Path(self.temp.name)/'ENABLED'
        self.assertEqual(b.claim(self.db,admission_path=path),[])
        path.touch()
        self.assertEqual(len(b.claim(self.db,admission_path=path)),1)

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
        self.reconcile(root)
        self.assertFalse((root / 'ENABLED').exists())

        (root / (run+'.completion.json')).write_text(json.dumps({'runId':run,'terminal':True,'pendingChildren':0,'outcome':'no_change','finishedAt':datetime.datetime.fromtimestamp(time.time()+1,datetime.timezone.utc).isoformat()}))
        self.reconcile(root)
        self.assertTrue((root / 'ENABLED').exists())
        self.assertEqual(db.execute('select status from events').fetchone()[0], 'completed')
        (root / 'ENABLED').rename(root / 'PAUSED-operator')
        self.reconcile(root)
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
                   'finishedAt':datetime.datetime.fromtimestamp(time.time()+1,datetime.timezone.utc).isoformat()}
        target = root / (run+'.completion.json')
        for invalid in ['not-a-clock', '2026-10-02T12:34:32', '2099-10-02T12:34:32+00:00']:
            target.write_text(json.dumps({**receipt, 'finishedAt':invalid}))
            self.reconcile(root)
            self.assertFalse((root / 'ENABLED').exists())
        target.write_text(json.dumps(receipt))
        self.reconcile(root)
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
