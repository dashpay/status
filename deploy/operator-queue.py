#!/usr/bin/env python3
"""Root-owned queue transport on the console host. No shell commands from clients."""
import fcntl,json,os,re,sys,tempfile
from pathlib import Path
ROOT=Path('/var/lib/dash-status/operations')
UUID=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
def atomic(path,value):
 fd,tmp=tempfile.mkstemp(dir=path.parent)
 try:
  with os.fdopen(fd,'w') as f:
   os.fchmod(f.fileno(),0o600);os.fchown(f.fileno(),1000,1000);json.dump(value,f);f.flush();os.fsync(f.fileno())
  os.replace(tmp,path)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def main():
 raw=sys.stdin.buffer.read(262145)
 if len(raw)>262144:raise ValueError('Oversized request')
 q=json.loads(raw);mode=q['mode']
 if mode=='list':
  out=[]
  for kind,d in [('review',ROOT/'drafts'),('operation',ROOT)]:
   for p in d.glob('*.json'):
    if not UUID.fullmatch(p.stem) or p.is_symlink() or p.stat().st_size>262144:continue
    v=json.loads(p.read_text())
    if v.get('status') in (['preparing'] if kind=='review' else ['queued','dispatching','submitted','unknown','in_progress','waiting','pending']):out.append({'kind':kind,'record':v})
  print(json.dumps(out));return
 if mode!='update' or q['kind'] not in ['review','operation'] or not UUID.fullmatch(q['id']):raise ValueError('Invalid update')
 path=(ROOT/'drafts' if q['kind']=='review' else ROOT)/(q['id']+'.json')
 with path.open() as f:
  fcntl.flock(f,fcntl.LOCK_EX);v=json.load(f)
  if v['id']!=q['id']:raise ValueError('Identity mismatch')
  allowed={'status','review','notice','preparedAt','runId','runUrl','conclusion','finishedAt','phase','current','completedTargets'}
  if set(q['changes'])-allowed:raise ValueError('Unexpected fields')
  v.update(q['changes']);atomic(path,v)
 print(json.dumps({'updated':q['id']}))
if __name__=='__main__':main()
