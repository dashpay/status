import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('services',pathlib.Path(__file__).with_name('mainnet-services.py'))
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
class Tests(unittest.TestCase):
 def test_distinct_samples_reset_and_sampling_gap(self):
  state={};bad={'ok':False,'reason':'probe-failed'}
  for at in [1000,1060,1120]:state=s.advance(state,bad,at)
  self.assertEqual(state['failures'],3)
  self.assertEqual(s.advance(state,bad,1120)['failures'],3)
  self.assertEqual(s.advance(state,bad,1500)['failures'],1)
  self.assertEqual(s.advance(state,{'ok':True},1180)['failures'],0)
 def test_one_notification_even_after_recovery_and_recurrence(self):
  with tempfile.TemporaryDirectory() as d,patch.object(s,'ROOT',pathlib.Path(d)):
   sent=[]
   def send(message,thread):sent.append((message,thread));return '123.45'
   def run(at,ok,transport=send):
    s.atomic(s.ROOT/'samples.json',{'at':at,'services':[{'id':'insight','ok':ok,'reason':'healthy' if ok else 'probe-failed'}]})
    s.notify(transport,at)
   run(1000,False);run(1060,False);self.assertEqual(sent,[])
   def fail(*a):raise TimeoutError()
   run(1120,False,fail);self.assertNotIn('thread',s.read(s.ROOT/'alerts.json')['insight'])
   run(1180,False);self.assertEqual(len(sent),0)
   ledger=s.read(s.ROOT/'alerts.json');self.assertTrue(ledger['insight']['deliveryUncertain'])
   # An operator confirms non-delivery before allowing a retry.
   ledger['insight'].pop('deliveryUncertain');s.atomic(s.ROOT/'alerts.json',ledger)
   run(1180,False);self.assertEqual(len(sent),1)
   run(1240,False);self.assertEqual(len(sent),1)
   run(1300,True);self.assertEqual(len(sent),1)
   run(1360,True);self.assertEqual(len(sent),1)
   self.assertTrue(s.read(s.ROOT/'alerts.json')['insight']['recovered'])
   run(1420,True);self.assertEqual(len(sent),1)
   for at in [1480,1540,1600,1660]:run(at,False)
   self.assertEqual(len(sent),1)
   state=s.read(s.ROOT/'alerts.json')['insight']
   self.assertFalse(state['recovered']);self.assertEqual(state['thread'],'123.45')
   # Repeated complete recovery/failure cycles and fresh module load stay silent.
   new=importlib.util.module_from_spec(spec);spec.loader.exec_module(new)
   with patch.object(new,'ROOT',s.ROOT):
    for at,ok in [(1720,True),(1780,True),(1840,False),(1900,False),(1960,False)]:
     s.atomic(s.ROOT/'samples.json',{'at':at,'services':[{'id':'insight','ok':ok}]})
     new.notify(send,at)
   self.assertEqual(len(sent),1)
 def test_live_plugin_and_legacy_receipt_shapes(self):
  import json
  for payload in [{'ok':True,'result':{'messageId':'1793457036.924509','channelId':s.CHANNEL}}, {'messageId':'1793457036.924509'}]:
   with patch.object(s,'command',return_value=json.dumps({'payload':payload})):
    self.assertEqual(s.slack('test'),'1793457036.924509')
  for response in [{'dryRun':True,'payload':{'messageId':'fake'}},{'payload':{'ok':True,'result':{}}}]:
   with patch.object(s,'command',return_value=json.dumps(response)):
    with self.assertRaises(ValueError):s.slack('test')
 def test_bootstrap_runs_in_a_throwaway_container_not_the_gateway(self):
  import json
  calls=[]
  def fake(args,timeout=20):calls.append(args);return json.dumps({'ok':True,'count':5})
  with patch.object(s,'command',fake):
   self.assertEqual(s.bootstrap('seed-1.example'),5);self.assertEqual(s.bootstrap(),5)
  seeded,default=calls
  self.assertEqual(seeded[:3],['docker','run','--rm']);self.assertIn(s.NODE_IMAGE,seeded)
  self.assertNotIn('exec',seeded);self.assertNotIn('infraclaw',seeded)
  self.assertIn(f'{s.RUNTIME}/node_modules:/runtime/node_modules:ro',seeded)
  self.assertEqual(seeded[-1],'seed-1.example');self.assertEqual(default,seeded[:-1])
  for result in [{'ok':False,'count':0},{'ok':True,'count':0}]:
   with patch.object(s,'command',return_value=json.dumps(result)):
    with self.assertRaises(ValueError):s.bootstrap()
 def test_failed_quorum_list_keeps_the_chain_reference(self):
  chain={'chain':'main','initialblockdownload':False,'blocks':10}
  def no_quorums(*args):
   if args[0]=='quorum':raise TimeoutError()
   return dict(chain)
  with patch.object(s,'cli',no_quorums):
   reference=s.core_reference()
  self.assertEqual(reference,chain)
  with patch.object(s,'get',side_effect=[{'success':True,'data':[{'quorum_hash':'a','height':10}]},{'success':True,'data':[{}]}]):
   self.assertEqual(s.quorum(reference),{'ok':None,'reason':'reference-unavailable'})
  with patch.object(s,'cli',side_effect=[dict(chain),{'llmq_100_67':['a']}]):
   self.assertEqual(s.core_reference()['quorums'],['a'])
  for bad in [dict(chain,chain='test'),dict(chain,initialblockdownload=True)]:
   with patch.object(s,'cli',return_value=bad):self.assertIsNone(s.core_reference())
  with patch.object(s,'cli',side_effect=TimeoutError()):self.assertIsNone(s.core_reference())
 def test_quorum_valid_but_stale_and_reference_missing(self):
  with patch.object(s,'get',side_effect=[{'success':True,'data':[{'quorum_hash':'old','height':10}]},{'success':True,'data':[{}]}]):
   self.assertEqual(s.quorum({'quorums':['new']})['reason'],'stale-data')
  with patch.object(s,'get',side_effect=[{'success':True,'data':[{'quorum_hash':'old','height':10}]},{'success':True,'data':[{}]}]):
   self.assertIsNone(s.quorum(None)['ok'])
 def test_stale_monitor_does_not_fake_service_recovery(self):
  with tempfile.TemporaryDirectory() as d,patch.object(s,'ROOT',pathlib.Path(d)):
   s.atomic(s.ROOT/'alerts.json',{'insight':{'thread':'old','at':1,'failures':3}})
   sent=[]
   for at in [1000,1030,1060]:s.notify(lambda m,t:sent.append((m,t)) or 'new',at)
   self.assertEqual(len(sent),1);self.assertIn('monitor',sent[0][0]);self.assertEqual(s.read(s.ROOT/'alerts.json')['insight']['thread'],'old')
if __name__=='__main__':unittest.main()
