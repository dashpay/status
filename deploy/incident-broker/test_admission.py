"""Admission regressions: blocked repeats never invoke workers or spend budget."""
import copy
import datetime
import hashlib
import json
import pathlib
import tempfile
import time
import unittest
from test_broker import b, event, envelope


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.db = b.connect(self.root / 'inbox.sqlite'); self.addCleanup(self.db.close)
        self.run = '1' * 24
        self.first = event()
        self.first['issue'].update(domain='ci', scope='mac-runner-brian', code='job_failed',
            target='dashpay/platform/123/mac-runner-brian/start', sourceKey='ci:job:immutable',
            lastFaultAt='2026-10-05T01:00:00Z', evidence={'repo': 'dashpay/platform', 'runId': 123,
                'attempt': 1, 'runner': 'mac-runner-brian', 'jobName': 'Swift SDK tests', 'end': '2026-10-05T01:00:00Z'})
        self.started = time.time() - 7200
        self.receipt = {'runId': self.run, 'terminal': True, 'pendingChildren': 0,
            'outcome': 'blocked', 'finishedAt': datetime.datetime.fromtimestamp(self.started + 60, datetime.timezone.utc).isoformat(),
            'issues': {'a'*24: {'outcome': 'blocked', 'blocker': 'Known fixture locking, existing owner',
                               'summary': 'Exact fixture failure verified', 'changes': [], 'nextAction': 'Await owner fix'}}}
        b.ingest(self.db, envelope(self.first))
        self.db.execute("update events set status='completed',started=?,finished=?,result=?", (self.started, self.started+60,self.run))
        self.db.commit(); self.write_receipt()

    def write_receipt(self):
        (self.root / (self.run + '.completion.json')).write_text(json.dumps(self.receipt))

    def reminder(self, revision=2):
        e=copy.deepcopy(self.first);e['eventId']='a'*24+':'+str(revision)
        e['issue']['revision']=revision;e['transition']='reminder'
        e['issue'].update(lastSeen=envelope()['sentAt'], lastEventAt=envelope()['sentAt'], observedAt=envelope()['sentAt'])
        return e

    def test_unchanged_reminder_correlates_before_budget_without_admission(self):
        for i in range(47):
            e=event();ident=hashlib.sha256(str(i).encode()).hexdigest()[:24]
            e['eventId']=ident+':1';e['issue']['id']=ident
            b.ingest(self.db,envelope(e))
            self.db.execute("update events set status='completed',started=? where id=?",(self.started-i-1,e['eventId']))
        self.db.commit()
        before=b.budget_usage(self.db,'ci:mac-runner-brian')
        self.assertEqual(before['windows'][1]['used'],48)
        b.ingest(self.db,envelope(self.reminder()))
        self.assertEqual(b.claim(self.db,root=self.root,cooldown=0),[])
        r=self.db.execute('select * from events where id=?',('a'*24+':2',)).fetchone()
        self.assertEqual(r['status'],'deduplicated');self.assertIsNone(r['started']);self.assertIsNone(r['session_key'])
        self.assertEqual(b.budget_usage(self.db,'ci:mac-runner-brian'),before)
        self.assertEqual(self.db.execute('select count(*) from event_locks').fetchone()[0],0)
        self.assertEqual(self.db.execute('select source_event from event_correlations').fetchone()[0],self.first['eventId'])
        case=b.remediation_snapshot(self.db,self.root)['cases']
        case=next(c for c in case if c['issueId']=='a'*24)
        self.assertEqual(case['lastResponse']['outcome'],'blocked');self.assertEqual(case['pendingEvents'],0)
        self.assertEqual(case['waitReason'],'known_blocker');self.assertEqual(case['lastResponse']['blocker'],'Known fixture locking, existing owner')
        self.assertFalse(case['active'])
        # Durable replay/restart is idempotent; the incident has not been marked resolved.
        b.ingest(self.db,envelope(self.reminder()))
        db=b.connect(self.root/'inbox.sqlite')
        try:
            self.assertEqual(b.claim(db,root=self.root,cooldown=0),[])
            self.assertEqual(db.execute('select count(*) from event_correlations').fetchone()[0],1)
        finally:db.close()

    def test_new_attempt_evidence_severity_or_identity_is_not_deduplicated(self):
        variants=[]
        for key,value in [('attempt',2),('runId',124),('jobName','Rust tests'),('repo','dashpay/other'),('end','2026-10-05T01:01:00Z')]:
            e=self.reminder();e['issue']['evidence'][key]=value;variants.append(e)
        e=self.reminder();e['issue']['evidence']['failureSignature']='new error';variants.append(e)
        e=self.reminder();e['issue']['severity']='critical';variants.append(e)
        e=self.reminder();e['issue']['target']='different job';variants.append(e)
        e=self.reminder();e['issue']['lastFaultAt']='2026-10-05T01:01:00Z';variants.append(e)
        e=self.reminder();e['transition']='reopened';variants.append(e)
        for e in variants:
            with self.subTest(event=e):
                b.ingest(self.db,envelope(e))
                self.assertEqual(len(b.claim(self.db,root=self.root,cooldown=0)),1)
                with self.db:
                    self.db.execute('delete from event_locks');self.db.execute('delete from events where id=?',(e['eventId'],))

    def test_missing_per_issue_proof_resolved_or_uncertain_receipt_never_suppresses(self):
        good=copy.deepcopy(self.receipt)
        variants=[]
        x=copy.deepcopy(good);x.pop('issues');variants.append(x)
        x=copy.deepcopy(good);x['issues']['a'*24]['outcome']='resolved';variants.append(x)
        x=copy.deepcopy(good);x['issues']['a'*24]['blocker']='';variants.append(x)
        x=copy.deepcopy(good);x['pendingChildren']=1;variants.append(x)
        x=copy.deepcopy(good);x['terminal']=False;variants.append(x)
        x=copy.deepcopy(good);x['finishedAt']='2026-01-01T00:00:00Z';variants.append(x)
        for receipt in variants:
            self.receipt=receipt;self.write_receipt();e=self.reminder();b.ingest(self.db,envelope(e))
            self.assertEqual(len(b.claim(self.db,root=self.root,cooldown=0)),1)
            with self.db:self.db.execute('delete from event_locks');self.db.execute('delete from events where id=?',(e['eventId'],))
        self.receipt=good;self.write_receipt()
        self.db.execute("update events set status='uncertain'");self.db.commit()
        b.ingest(self.db,envelope(self.reminder()))
        with self.db:self.assertEqual(b.deduplicate_known_ci_blockers(self.db,self.root),[])
        self.assertEqual(self.db.execute('select count(*) from event_correlations').fetchone()[0],0)

    def test_explicit_recheck_and_intervening_resolution_bypass_gate(self):
        e=self.reminder();b.ingest(self.db,envelope(e))
        (self.root/'ci-dedup-recheck.json').write_text(json.dumps({'a'*24:'Owner requests re-evaluation after upstream fix'}))
        self.assertEqual(len(b.claim(self.db,root=self.root,cooldown=0)),1)
        with self.db:self.db.execute('delete from event_locks');self.db.execute('delete from events where id=?',(e['eventId'],))
        (self.root/'ci-dedup-recheck.json').unlink()
        e=self.reminder();e['transition']='resolved';e['issue']['status']='resolved'
        b.ingest(self.db,envelope(e,self.reminder(3)))
        self.assertEqual(len(b.claim(self.db,root=self.root,cooldown=0)),1)

    def test_network_bans_disk_pressure_and_release_tasks_are_not_caught(self):
        for domain,code in [('network','pose_banned'),('ci','disk_pressure'),('maintenance','platform_release_compatibility')]:
            e=self.reminder();e['issue'].update(domain=domain,code=code)
            self.assertIsNone(b.ci_failure_fingerprint(e))
        e=self.reminder();del e['issue']['evidence']['attempt']
        self.assertIsNone(b.ci_failure_fingerprint(e))

    def test_newer_resolved_receipt_blocks_fallback_to_old_blocker(self):
        e=self.reminder();b.ingest(self.db,envelope(e));run='2'*24
        with self.db:self.db.execute("update events set status='completed',started=?,finished=?,result=? where id=?",(self.started+120,self.started+180,run,e['eventId']))
        receipt={**self.receipt,'runId':run,'outcome':'resolved','issues':{'a'*24:{'outcome':'resolved'}}}
        (self.root/(run+'.completion.json')).write_text(json.dumps(receipt))
        b.ingest(self.db,envelope(self.reminder(3)))
        self.assertEqual(len(b.claim(self.db,root=self.root,cooldown=0)),1)

    def test_reset_preserves_history_locks_and_separate_release_budget(self):
        e=event();e['eventId']='b'*24+':1';e['issue'].update(id='b'*24)
        b.ingest(self.db,envelope(e))
        with self.db:self.db.execute("update events set scope='maintenance:dash-network-go',started=?,status='completed' where id=?",(time.time()-10,e['eventId']))
        before=[tuple(r) for r in self.db.execute('select * from events')]
        self.assertTrue(b.budget_exhausted(self.db,'maintenance:dash-network-go'))
        with self.db:self.db.execute('insert or replace into meta values(?,?)',('budget_reset:ordinary',json.dumps({'at':time.time(),'reason':'Explicit owner reset after verified dedup rollout'})))
        self.assertEqual([w['used'] for w in b.budget_usage(self.db,'ci:mac-runner-brian')['windows']],[0,0])
        self.assertTrue(b.budget_exhausted(self.db,'maintenance:dash-network-go'))
        self.assertEqual(before,[tuple(r) for r in self.db.execute('select * from events')])
        b.ingest(self.db,envelope(self.reminder()))
        # Changed failure admits and immediately counts under the fresh allowance.
        with self.db:self.db.execute('delete from events where id=?',('a'*24+':2',))
        e=self.reminder();e['issue']['evidence']['attempt']=2;b.ingest(self.db,envelope(e))
        self.assertEqual(len(b.claim(self.db,root=self.root,cooldown=0)),1)
        self.assertEqual([w['used'] for w in b.budget_usage(self.db,'ci:mac-runner-brian')['windows']],[1,1])

    def test_invalid_or_future_reset_never_bypasses_existing_usage(self):
        for value in ['oops','[]','null',json.dumps({'at':time.time()+100,'reason':'future'}),json.dumps({'at':float('nan'),'reason':'NaN'}),json.dumps({'at':time.time(),'reason':''})]:
            with self.db:self.db.execute('insert or replace into meta values(?,?)',('budget_reset:ordinary',value))
            self.assertEqual(b.budget_usage(self.db,'ci:mac-runner-brian')['windows'][1]['used'],1)


if __name__=='__main__':unittest.main()
