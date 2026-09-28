#!/usr/bin/env python3
"""Trusted, credential-separated bridge: web intent -> frozen CLI plan -> Actions.

Invoked periodically, under a local flock. No AI turn or web-host cloud credentials.
Only explicit actor/network/node/component allow-lists reach the CLI or Actions.
"""
import datetime,fcntl,hashlib,json,os,re,subprocess,sys,time
from pathlib import Path
UUID=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
DIGEST=re.compile(r'^[a-f0-9]{64}$')
REPOS={'core':'dashpay/dashd','drive':'dashpay/drive','tenderdash':'dashpay/tenderdash','dapi':'dashpay/rs-dapi','gateway':'dashpay/envoy','helper':'dashpay/dashmate-helper'}
REPO='dashpay/dash-network-go';WORKFLOW='console-operation.yml'
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(path,value):
 tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(value));tmp.chmod(0o600);os.replace(tmp,path)
def validate(q,net,config):
 if not UUID.fullmatch(q['id']) or q['action'] not in ['upgrade','deploy','doctor','import','enroll']:raise ValueError('Invalid request')
 if q['actor']['id'] not in config['operators']:raise ValueError('Operator not permitted')
 f=json.loads(Path(net['manifest']).read_text());assert f['metadata']['name']==q['network']
 return f
class Broker:
 def __init__(self,config):
  self.c=config;self.root=Path(config['state']);self.root.mkdir(mode=0o700,parents=True,exist_ok=True)
  import botocore.session
  self.session=botocore.session.Session(profile=config['profile']);self.s3=self.session.create_client('s3',region_name=config['bucketRegion'])
 def ssh(self,q):
  args=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','-i',self.c['sshKey'],self.c['consoleHost'],'sudo /usr/local/sbin/dash-status-operator-queue']
  v=subprocess.run(args,input=json.dumps(q),capture_output=True,text=True,timeout=60)
  if v.returncode:raise RuntimeError('Console queue transport unavailable')
  return json.loads(v.stdout)
 def update(self,kind,q,**changes):return self.ssh(dict(mode='update',kind=kind,id=q['id'],changes=changes))
 def cli(self,args,out,timeout=400):
  v=subprocess.run([self.c['binary'],*args,'--profile',self.c['profile'],'--out',str(out)],capture_output=True,text=True,timeout=timeout)
  log=out.with_suffix('.log');log.write_text(v.stderr);log.chmod(0o600)
  return v.returncode
 def github(self,path,body=None):
  args=['gh','api',f'repos/{REPO}/'+path]
  if body is not None:args+=['--method','POST','--input','-']
  v=subprocess.run(args,input=json.dumps(body) if body is not None else None,text=True,capture_output=True,timeout=40)
  if v.returncode:raise RuntimeError('GitHub request failed; reconcile before retrying')
  return json.loads(v.stdout) if v.stdout.strip() else None
 def put(self,key,data):
  try:self.s3.put_object(Bucket=self.c['bucket'],Key=key,Body=data,ServerSideEncryption='AES256',IfNoneMatch='*')
  except Exception as e:
   if getattr(e,'response',{}).get('Error',{}).get('Code')!='PreconditionFailed':raise
   old=self.s3.get_object(Bucket=self.c['bucket'],Key=key)['Body'].read()
   if old!=data:raise ValueError('Immutable request already contains different data')
 def prepare(self,q,net):
  f=validate(q,net,self.c);selection=q['selection'];nodes=selection['nodes'];components=selection['components'];images=selection['images'];byname={t['name']:t for t in f['targets']}
  if not nodes or len(set(nodes))!=len(nodes) or any(n not in byname for n in nodes):raise ValueError('Node selection outside inventory')
  if q['action'] in ['upgrade','deploy']:
   if not components or len(set(components))!=len(components) or any(c not in REPOS for c in components):raise ValueError('Invalid components')
   if any(any(c not in byname[n]['containers'] for c in components) for n in nodes):raise ValueError('Component absent on selected target')
   if set(images)-set(components):raise ValueError('Unselected image override')
   if q['action']=='upgrade':
    for c in components:
     if not re.fullmatch(r'(docker\.io/)?'+REPOS[c]+r'(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})',images.get(c,'')):raise ValueError('Image must be from the component repository')
  elif components or images:raise ValueError('Unexpected components')
  d=self.root/q['id'];d.mkdir(mode=0o700,exist_ok=True)
  snapshot=d/'snapshot.json'
  access=['--ssh-key',net['sshKey'],'--known-hosts',net['knownHosts']]
  if not snapshot.exists():self.cli(['managed-import','--manifest',net['manifest'],*access,'--timeout','5m'],snapshot)
  s=json.loads(snapshot.read_text())
  if s['fleet']!=f:raise ValueError('Live import changed scope')
  if q['action'] in ['upgrade','deploy','enroll'] and any(s['nodes'][n].get('error') or s['nodes'][n].get('problems') for n in nodes):raise ValueError('A selected node is unavailable; see its health details')
  plan=d/'plan.json'
  if q['action'] in ['upgrade','deploy']:
   choices=d/'images.json';save(choices,images)
   if not plan.exists():
    code=self.cli(['managed-plan','--snapshot',str(snapshot),'--operation',q['action'],'--scope',','.join(components),'--nodes',','.join(nodes),'--images',str(choices),'--timeout','5m'],plan)
    if code:raise ValueError('Plan preparation failed; inspect the protected broker log')
   p=json.loads(plan.read_text());pid=p['id'];changes=[]
   for n,pins in p['images'].items():
    for c,pin in pins.items():changes.append(dict(node=n,component=c,**{'from':s['nodes'][n]['components'][c]['image'],'to':pin},dependency=c not in components))
  else:p=None;pid=s['id'];changes=[]
  artifact=p or s
  review=dict(network=q['network'],action=q['action'],planId=pid,targets=nodes,scope=','.join(components),changes=changes,preservesCore='core' not in components,
   recovery='Forward recovery using this exact plan; no reset or automatic downgrade.',enrollment=q['action'] in ['upgrade','deploy','enroll'])
  bundle=dict(network=q['network'],action=q['action'],planId=pid,targets=nodes,artifact=artifact)
  binary=Path(self.c['binary']).read_bytes();bundle['binarySHA256']=hashlib.sha256(binary).hexdigest()
  save(d/'bundle.json',bundle);(d/'dashnet').write_bytes(binary);(d/'dashnet').chmod(0o700)
  save(d/'review.json',review);save(d/'request.json',q)
  self.update('review',q,status='ready',review=review,preparedAt=now())
 def dispatch(self,q,net):
  validate(q,net,self.c)
  if not UUID.fullmatch(q['draftId']):raise ValueError('Bad review identity')
  d=self.root/q['draftId'];b=json.loads((d/'bundle.json').read_text());saved=json.loads((d/'request.json').read_text())
  if saved['actor']['id'] not in self.c['operators']:raise ValueError('Operator grant revoked')
  if b['network']!=q['network'] or b['action']!=q['action'] or b['planId']!=q['planId'] or saved['actor']['id']!=q['actor']['id']:raise ValueError('Reviewed plan mismatch')
  prefix='managed/'+q['network']+'/requests/'+q['id']+'/'
  self.put(prefix+'input.json',(d/'bundle.json').read_bytes());self.put(prefix+'dashnet',(d/'dashnet').read_bytes());self.put(prefix+'known_hosts',Path(net['knownHosts']).read_bytes())
  intent=self.root/(q['id']+'.dispatch.json')
  if intent.exists():return  # An ambiguous response is reconciled, never redispatched.
  save(intent,dict(request=q['id'],at=now()));self.update('operation',q,status='dispatching')
  try:
   self.github(f'actions/workflows/{WORKFLOW}/dispatches',dict(ref='main',inputs=dict(network=q['network'],operation=q['action'],request_id=q['id'],confirm=q['planId'])))
   self.update('operation',q,status='submitted')
  except Exception:self.update('operation',q,status='unknown',notice='Dispatch response unavailable; reconciling the exact request ID.')
 def reconcile(self,records):
  if not records:return
  runs=self.github(f'actions/workflows/{WORKFLOW}/runs?event=workflow_dispatch&per_page=100')['workflow_runs']
  for q in records:
   found=[v for v in runs if v['display_title'].endswith(q['id']) and v['head_branch']=='main']
   if len(found)!=1:continue
   v=found[0];changes=dict(status=v['status'],conclusion=v['conclusion'],runId=v['id'],runUrl=f'https://github.com/{REPO}/actions/runs/{v["id"]}',notice=None)
   if v['status']=='completed':
    changes['finishedAt']=now()
    if v['conclusion']!='success':changes['notice']='Operation stopped. Inspect the run before resuming the same plan; no automatic reset was performed.'
   self.update('operation',q,**changes)
 def run(self):
  jobs=self.ssh(dict(mode='list'));ops=[v['record'] for v in jobs if v['kind']=='operation' and v['record']['status']!='queued']
  self.reconcile(ops)
  for job in jobs:
   q=job['record'];net=self.c['networks'].get(q['network'])
   if not net:continue
   try:
    if job['kind']=='review':self.prepare(q,net)
    elif q['status']=='queued':self.dispatch(q,net)
   except Exception as e:
    log=self.root/(q['id']+'.error');log.write_text(str(e));log.chmod(0o600)
    self.update(job['kind'],q,status='failed',notice=str(e)[:220] if isinstance(e,ValueError) else 'Preparation failed; inspect the protected broker log.')
def main():
 c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['state']);root.mkdir(parents=True,exist_ok=True,mode=0o700)
 with (root/'broker.lock').open('w') as f:
  try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return
  Broker(c).run()
if __name__=='__main__':main()
