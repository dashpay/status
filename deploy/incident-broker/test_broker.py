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
from types import SimpleNamespace
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

    def test_holds_never_touch_the_operator_switch(self):
        root = pathlib.Path(self.temp.name); config = self.concurrency()
        b.hold_uncertain(root, 'known', 'network:sakura', config)
        self.assertTrue((root/'HELD-known').exists())
        self.assertFalse((root/'ENABLED').exists())
        (root/'ENABLED').touch()
        # Serial mode and unknown scopes used to rename ENABLED, which also
        # disabled the only automatic way out of the hold.
        b.hold_uncertain(root, 'unknown', 'network:other', config)
        b.hold_uncertain(root, 'serial', 'network:sakura', {'maxActive': 1, 'scopes': {}})
        self.assertTrue((root/'ENABLED').exists())
        self.assertTrue((root/'HELD-unknown').exists() and (root/'HELD-serial').exists())
        self.assertEqual(list(root.glob('PAUSED-*')), [])

    def test_serial_hold_still_blocks_admission_without_a_pause_file(self):
        b.ingest(self.db, envelope(event())); b.claim(self.db, cooldown=0)
        with self.db: self.db.execute("update events set status='uncertain'")
        self.concurrent_event('b', 'other')
        self.assertEqual(b.claim(self.db, cooldown=0), [])

    def test_startup_returns_automatic_pauses_but_not_operator_pauses(self):
        root = pathlib.Path(self.temp.name)
        (root/'PAUSED-route-unavailable').touch()
        self.assertEqual(b.adopt_legacy_pauses(root), 'PAUSED-route-unavailable')
        self.assertTrue((root/'ENABLED').exists())
        (root/'ENABLED').rename(root/'PAUSED-operator')
        self.assertIsNone(b.adopt_legacy_pauses(root))
        self.assertFalse((root/'ENABLED').exists())
        (root/'PAUSED-operator').unlink(); (root/('PAUSED-'+'1'*24)).touch()
        self.assertEqual(b.adopt_legacy_pauses(root), 'PAUSED-'+'1'*24)
        self.assertTrue((root/'ENABLED').exists() and (root/('HELD-'+'1'*24)).exists())

    def test_route_failure_backs_off_and_recovers_without_pausing(self):
        root = pathlib.Path(self.temp.name); now = time.time()
        first = b.route_failed(self.db, 'route down', 'pin', now)
        self.assertEqual(first['retryAt'], now + 60)
        second = b.route_failed(self.db, 'route down', 'pin', now + 60)
        self.assertEqual((second['failures'], second['openedAt'], second['retryAt']), (2, now, now + 180))
        for _ in range(10): last = b.route_failed(self.db, 'route down', 'pin', now)
        self.assertEqual(last['retryAt'], now + 1800)
        self.assertEqual([a['code'] for a in b.attention(self.db, root)], ['route_unavailable'])
        b.route_recovered(self.db)
        self.assertIsNone(b.route_breaker(self.db))
        self.assertEqual(b.attention(self.db, root), [])

    def test_unavailable_route_requeues_and_leaves_dispatch_enabled(self):
        root = pathlib.Path(self.temp.name); (root/'ENABLED').touch()
        b.ingest(self.db, envelope(event()))
        batch = b.claim(self.db, cooldown=0)
        args = SimpleNamespace(state_dir=str(root), container_state_dir=str(root), api_token_file=str(root/'token'))
        with patch.object(b, 'refreshed_events', side_effect=lambda events, _: events), \
                patch.object(b, 'pin_session_route', side_effect=ValueError('not pinned')):
            self.assertIsNone(b.prepare(args, root, 'policy', {'maxActive': 1, 'scopes': {}}, batch, batch[0][1],
                                        b.attempt_id([r for r, _ in batch]), threading.Event()))
        row = self.db.execute('select * from events').fetchone()
        self.assertEqual((row['status'], row['started'], row['invoked']), ('queued', None, None))
        self.assertTrue((root/'ENABLED').exists())
        self.assertEqual(list(root.glob('PAUSED-*')), [])
        self.assertEqual(b.route_breaker(self.db)['kind'], 'pin')
        # The same work is admitted again once the route answers.
        with self.db: self.db.execute("delete from meta where key='route_breaker'")
        self.assertEqual(len(b.claim(self.db, cooldown=0)), 1)

    def test_withdrawn_batch_consumes_no_dispatch_budget(self):
        root = pathlib.Path(self.temp.name)
        b.ingest(self.db, envelope(event()))
        batch = b.claim(self.db, cooldown=0)
        args = SimpleNamespace(state_dir=str(root), container_state_dir=str(root), api_token_file=str(root/'token'))
        with patch.object(b, 'refreshed_events', return_value=[]):
            self.assertIsNone(b.prepare(args, root, 'policy', {'maxActive': 1, 'scopes': {}}, batch, batch[0][1], 'r'*24, threading.Event()))
        row = self.db.execute('select * from events').fetchone()
        self.assertEqual((row['status'], row['started']), ('superseded', None))

    def test_new_events_wait_before_admission(self):
        b.ingest(self.db, envelope(event()))
        self.assertEqual(b.claim(self.db, cooldown=0, min_age=300), [])
        self.assertEqual(b.scheduler_snapshot(self.db, {'maxActive': 1, 'scopes': {}}, True)['queued'][0]['reason'], 'settling')
        with self.db: self.db.execute('update events set received=received-301')
        self.assertEqual(len(b.claim(self.db, cooldown=0, min_age=300)), 1)

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

    def test_expired_hold_is_released_only_when_the_session_is_inactive(self):
        root,run=self.uncertain_run(); now=time.time()
        stale={'status':'error','endedAt':(now-3600)*1000,'lastRunId':'earlier-run'}
        status=lambda: self.db.execute("select status from events where id=?",('a'*24+':1',)).fetchone()[0]
        def broken(_): raise OSError('gateway unavailable')
        # Inside the lease nothing is released, however idle the session looks.
        for t in [now,now+31,now+62,now+93]: b.reconcile_sessions(root,lambda _:stale,t)
        self.assertEqual(status(),'uncertain')
        self.assertIn('hold',[a['code'] for a in b.attention(self.db,root,now+1801)])
        late=now+b.HOLD_LEASE+1
        # Past the lease an active, recently active or unreadable session keeps it.
        for reader in [lambda _:{**stale,'status':'running'}, lambda _:{**stale,'lastActivityAt':late*1000}, broken]:
            for t in [late,late+31,late+62,late+93]: b.reconcile_sessions(root,reader,t)
            self.assertEqual(status(),'uncertain')
        b.reconcile_sessions(root,lambda _:stale,late+200)
        b.reconcile_sessions(root,lambda _:stale,late+231)
        self.assertEqual(status(),'uncertain','one inactive observation is not enough')
        b.reconcile_sessions(root,lambda _:stale,late+262)
        self.assertEqual(status(),'abandoned')
        self.assertTrue((root/(run+'.released.json')).exists())
        self.assertFalse((root/('HELD-'+run)).exists())
        self.assertTrue((root/'ENABLED').exists())
        # The slot is free again and the abandoned events are never replayed.
        self.concurrent_event('b','sakura')
        self.assertEqual([r['id'] for r,_ in b.claim(self.db,config=self.concurrency(),cooldown=0)],['b'*24+':1'])

    def test_fast_failure_uses_the_short_lease(self):
        root,run=self.uncertain_run(); now=time.time()
        with self.db: self.db.execute('update events set finished=started+5')
        stale={'status':'done','endedAt':(now-3600)*1000,'lastRunId':'earlier-run'}
        for t in [now+60,now+121]: b.reconcile_sessions(root,lambda _:stale,t)
        self.assertEqual(self.db.execute('select status from events').fetchone()[0],'uncertain')
        late=now+b.QUICK_HOLD_LEASE+1
        for t in [late,late+61]: b.reconcile_sessions(root,lambda _:stale,t)
        self.assertEqual(self.db.execute('select status from events').fetchone()[0],'abandoned')

    def test_bookkeeping_check_is_not_spent_on_an_unavailable_route_and_retries(self):
        root,run=self.uncertain_run(); now=time.time()
        b.reconcile_sessions(root,lambda _:self.done(),now)
        checks=b.reconcile_sessions(root,lambda _:self.done(),now+31)
        args=SimpleNamespace(state_dir=str(root),container_state_dir=str(root))
        with patch.object(b,'describe_session',return_value=self.done()), patch.object(b,'pin_session_route',side_effect=ValueError('route')), patch.object(b.subprocess,'run') as execute:
            b.request_completion_check(args,checks[0]); execute.assert_not_called()
        self.assertEqual(self.db.execute('select check_attempts from lifecycle').fetchone()[0],0)
        self.assertEqual(len(b.reconcile_sessions(root,lambda _:self.done(),now+62)),1)
        self.assertEqual(b.route_breaker(self.db)['kind'],'pin')
        due={**b.route_breaker(self.db),'retryAt':time.time()-1}
        with self.db: self.db.execute("update meta set value=? where key='route_breaker'",(json.dumps(due),))
        with patch.object(b,'describe_session',return_value=self.done()), patch.object(b,'pin_session_route',return_value={}), patch.object(b.subprocess,'run') as execute:
            execute.return_value.returncode=0
            b.request_completion_check(args,checks[0]); self.assertEqual(execute.call_count,1)
        self.assertIsNone(b.route_breaker(self.db),'a successful pin closes the breaker a failed pin opened')
        self.assertEqual(b.reconcile_sessions(root,lambda _:self.done(),now+93),[])
        self.assertEqual(len(b.reconcile_sessions(root,lambda _:self.done(),now+93+b.CHECK_BACKOFF[0])),1,'a later bounded retry')

    def test_restart_requeues_work_that_never_reached_the_model(self):
        root=pathlib.Path(self.temp.name)
        self.concurrent_event('a','sakura');b.claim(self.db,config=self.concurrency())
        b.recover_interrupted(root,None)
        row=self.db.execute('select * from events').fetchone()
        self.assertEqual((row['status'],row['started']),('queued',None))
        self.assertEqual(list(root.glob('HELD-*')),[])

    def test_restart_recovers_running_as_hold_not_requeue(self):
        root=pathlib.Path(self.temp.name);config=self.concurrency()
        self.concurrent_event('a','sakura');b.claim(self.db,config=config)
        with self.db: self.db.execute('update events set invoked=started')
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

    def test_ending_a_legacy_paused_run_does_not_lift_an_operator_pause(self):
        root = pathlib.Path(self.temp.name)
        db = b.connect(root / 'inbox.sqlite'); self.addCleanup(db.close)
        b.ingest(db, envelope(event())); b.claim(db, cooldown=0)
        run = '3'*24
        with db: db.execute("update events set status='uncertain',result=?", (run,))
        (root / (run+'.result.json')).write_text(json.dumps({'status':'ok'}))
        (root / ('PAUSED-'+run)).touch(); (root / 'PAUSED-operator').touch()
        (root / (run+'.completion.json')).write_text(json.dumps({'runId':run,'terminal':True,'pendingChildren':0,'outcome':'no_change','finishedAt':datetime.datetime.fromtimestamp(time.time()+1,datetime.timezone.utc).isoformat()}))
        self.reconcile(root)
        self.assertEqual(db.execute('select status from events').fetchone()[0], 'completed')
        self.assertFalse((root / 'ENABLED').exists(), 'the operator pause still holds dispatch off')
        (root / 'PAUSED-operator').unlink()
        self.assertEqual(b.adopt_legacy_pauses(root), 'PAUSED-'+run)

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

    def test_administrator_switch_defaults_off_and_cannot_override_the_local_file(self):
        root = pathlib.Path(self.temp.name); gate = root/'ENABLED'; gate.touch()
        control = lambda seq, dispatch: {**envelope(), 'control': {'seq': seq, 'dispatch': dispatch, 'clearSeq': 0}}
        b.ingest(self.db, envelope(event()))
        self.assertEqual(b.claim(self.db, cooldown=0, admission_path=gate, switch=True), [], 'off until an administrator switches it on')
        self.assertFalse(b.remediation_snapshot(self.db, root)['enabled'])
        b.ingest(self.db, control(1, 'on'))
        self.assertEqual(b.health(self.db, root)['control'], {'seq': 1, 'dispatch': 'on', 'clearSeq': 0, 'lastClear': None, 'localEnabled': True})
        b.ingest(self.db, control(0, 'off'))
        self.assertTrue(b.dispatch_on(self.db), 'a replayed older envelope changes nothing')
        gate.unlink()
        self.assertEqual(b.claim(self.db, cooldown=0, admission_path=gate, switch=True), [], 'the local file stays the master switch')
        self.assertFalse(b.remediation_snapshot(self.db, root)['enabled'])
        gate.touch()
        self.assertEqual(len(b.claim(self.db, cooldown=0, admission_path=gate, switch=True)), 1)
        b.ingest(self.db, control(2, 'off'))
        self.assertFalse(b.dispatch_on(self.db))
        self.assertEqual(self.db.execute('select status from events').fetchone()[0], 'running', 'switching off never interrupts work in progress')

    def test_clear_empties_only_queued_work_and_only_once(self):
        b.ingest(self.db, envelope(event()))
        self.concurrent_event('b', 'sakura'); self.concurrent_event('c', 'other')
        with self.db:
            self.db.execute("update events set status='uncertain' where id like 'b%'")
            self.db.execute("update events set status='running' where id like 'c%'")
        clearing = {**envelope(event(2)), 'control': {'seq': 1, 'dispatch': 'off', 'clearSeq': 1}}
        statuses = lambda: {r['id'][0] + r['id'][-2:]: r['status'] for r in self.db.execute('select id,status from events')}
        b.ingest(self.db, clearing)
        self.assertEqual(statuses(), {'a:1': 'cleared', 'a:2': 'queued', 'b:1': 'uncertain', 'c:1': 'running'})
        self.assertEqual(b.remote_control(self.db)['lastClear']['count'], 1)
        b.ingest(self.db, clearing)
        self.assertEqual(statuses()['a:2'], 'queued', 'redelivery does not clear again')
        self.assertEqual(b.claim(self.db, cooldown=0), [], 'the held scope still owns its slot')

    def test_control_vocabulary_is_closed(self):
        for bad in ['on', {'seq': 1, 'dispatch': 'on'}, {'seq': 1, 'dispatch': 'run', 'clearSeq': 0}, {'seq': True, 'dispatch': 'on', 'clearSeq': 0},
                    {'seq': 1, 'dispatch': 'on', 'clearSeq': 2}, {'seq': -1, 'dispatch': 'on', 'clearSeq': 0},
                    {'seq': 1, 'dispatch': 'on', 'clearSeq': 0, 'command': 'run this'}]:
            with self.assertRaises(ValueError): b.validate({**envelope(), 'control': bad})
        self.assertEqual(b.validate({**envelope(), 'control': {'seq': 1, 'dispatch': 'on', 'clearSeq': 1}}), [])

    def release_event(self, rev=1, component='core', tag='v24.0.0'):
        e = event(rev, transition='opened' if rev == 1 else 'reminder'); e['eventId'] = 'd'*24 + ':' + str(rev)
        e['issue'].update(id='d'*24, domain='release', scope=component, target='dashpay/dash@' + tag, code='release_published', sourceKey='github:release')
        return e

    def test_release_notices_are_queued_and_dispatched_without_the_fault_readback(self):
        root = pathlib.Path(self.temp.name)
        b.ingest(self.db, envelope(self.release_event()))
        row = self.db.execute('select * from events').fetchone()
        self.assertEqual((row['scope'], row['status']), ('release:core', 'queued'))
        self.assertIn('release', b.health(self.db, root)['domains'])
        batch = b.claim(self.db, cooldown=0)
        self.assertEqual(len(batch), 1)
        # Nothing to re-observe: the release is a fact, so no issue snapshot is fetched.
        events = [json.loads(r['body']) for r, _ in batch]
        with patch.object(b.urllib.request, 'build_opener', side_effect=AssertionError('no readback for a release notice')):
            self.assertEqual(b.refreshed_events(events, root/'missing-token'), events)
        # A notice the worker abandoned returns as a new revision and is admitted again.
        with self.db: self.db.execute("update events set status='abandoned'")
        b.ingest(self.db, envelope(self.release_event(2)))
        self.assertEqual([r['id'] for r, _ in b.claim(self.db, cooldown=0)], ['d'*24 + ':2'])
        unknown = self.release_event(); unknown['issue']['domain'] = 'deploy'
        with self.assertRaises(ValueError): b.validate(envelope(unknown))

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
