#!/usr/bin/env python3
"""Read-only Mainnet service probes and durable, queue-independent Slack paging."""
import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import time
import urllib.request

ROOT = Path(os.environ.get('MAINNET_SERVICES_STATE', '/var/lib/dash-mainnet-services'))
SEEDS = [f'seed-{n}.mainnet.networks.dash.org' for n in range(1, 4)]
# The npm tree from deploy/mainnet-services-runtime, installed next to this script.
RUNTIME = Path(os.environ.get('MAINNET_SERVICES_RUNTIME', '/opt/dash-mainnet-services/runtime'))
NODE_IMAGE = 'node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
CHANNEL = 'C0AMAE6E82F'

def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, indent=2)); tmp.replace(path)

def read(path):
    try: return json.loads(path.read_text())
    except (OSError, ValueError): return {}

def command(args, timeout=20):
    return subprocess.check_output(args, timeout=timeout, stderr=subprocess.PIPE, text=True).strip()

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 Dash-Mainnet-Monitor', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=12) as r:
        data = r.read(4*1024*1024+1)
        if len(data) > 4*1024*1024: raise ValueError('oversized response')
        return json.loads(data)

def cli(*args):
    raw = command(['docker', 'exec', 'dashmate_dbb2a15d_mainnet-core-1', 'dash-cli', *map(str, args)])
    try: return json.loads(raw)
    except ValueError: return raw

def tls(host):
    with socket.create_connection((host, 443), timeout=10) as sock:
        with ssl.create_default_context().wrap_socket(sock, server_hostname=host) as conn:
            expiry = ssl.cert_time_to_seconds(conn.getpeercert()['notAfter'])
    return expiry

def node(script, *args):
    # One throwaway container per probe. A long-lived container to exec into is a
    # dependency that can be stopped, and then every probe fails without testing anything.
    # `timeout` bounds the container even if this process is killed first.
    return command(['docker', 'run', '--rm', '--init', '--read-only', '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges', '--user', '65534:65534',
                    '--memory', '256m', '--pids-limit', '128',
                    '-v', f'{RUNTIME}/node_modules:/runtime/node_modules:ro',
                    '-e', 'NODE_PATH=/runtime/node_modules', NODE_IMAGE,
                    'timeout', '-k', '2', '50', 'node', '-e', script, *args], timeout=60)

def bootstrap(host=None):
    script = """
const DAPIClient=require('@dashevo/dapi-client');
const seed=process.argv[1]; const c=seed?new DAPIClient({seeds:[seed]}):new DAPIClient();
c.on('error',()=>{});let done=false;
function finish(ok,n=0){if(done)return;done=true;console.log(JSON.stringify({ok,count:n}));c.disconnect();process.exit(ok?0:1)}
setTimeout(()=>finish(false),45000);
c.dapiAddressProvider.getLiveAddress().then(a=>finish(!!a,c.dapiAddressProvider.listDAPIAddressProvider.getAllAddresses().length)).catch(()=>finish(false));
"""
    raw = node(script, *([host] if host else []))
    result = json.loads(raw)
    if not result['ok'] or result['count'] < 1: raise ValueError('bootstrap failed')
    return result['count']

def quorum(reference):
    base = 'https://quorums.mainnet.networks.dash.org'
    q, nodes = get(base+'/quorums'), get(base+'/masternodes')
    if q.get('success') is not True or nodes.get('success') is not True or not q.get('data') or not nodes.get('data'):
        raise ValueError('invalid or empty response')
    actual = {v['quorum_hash'] for v in q['data']}
    if not reference: return {'ok': None, 'reason': 'reference-unavailable'}
    expected = reference.get('quorums')
    if not expected: return {'ok': None, 'reason': 'reference-unavailable'}
    return {'ok': actual == set(expected), 'reason': 'healthy' if actual == set(expected) else 'stale-data',
            'height': max(v['height'] for v in q['data']), 'count': len(actual)}

def insight(reference):
    base = 'https://insight.dash.org/insight-api'
    sync = get(base+'/sync'); latest = get(base+'/blocks?limit=1')['blocks'][0]
    block = get(base+'/block/'+latest['hash']); tx = get(base+'/tx/'+block['tx'][0])
    if block.get('hash') != latest['hash'] or tx.get('txid') != block['tx'][0]: raise ValueError('inconsistent indexed data')
    if not reference: return {'ok': None, 'reason': 'reference-unavailable'}
    # Compare a historical hash as well as height; a changing tip alone is not chain identity.
    same = cli('getblockhash', latest['height']) == latest['hash']
    ok = sync.get('status') == 'finished' and abs(reference['blocks']-latest['height']) <= 6 and same
    return {'ok': ok, 'reason': 'healthy' if ok else 'stale-data', 'height': latest['height']}

def seed(host):
    expires = tls(host); count = bootstrap(host)
    return {'ok': expires-time.time() > 36*3600, 'reason': 'healthy' if expires-time.time() > 36*3600 else 'certificate-expiring',
            'count': count, 'expiresAt': expires}

def sampled(label, fn):
    started = time.monotonic()
    try: result = fn()
    except Exception as e: result = {'ok': False, 'reason': 'probe-failed', 'errorClass': type(e).__name__}
    return dict(result, id=label, ms=round((time.monotonic()-started)*1000))

def collect():
    reference = None
    try:
        reference = cli('getblockchaininfo')
        if reference['chain'] != 'main' or reference['initialblockdownload']: reference = None
        else:
            q = cli('quorum', 'list')
            reference['quorums'] = q.get('llmq_100_67')
    except Exception: reference = None
    jobs = {'quorums': lambda: quorum(reference), 'insight': lambda: insight(reference),
            'bootstrap': lambda: {'ok': True, 'reason': 'healthy', 'count': bootstrap()}}
    for n, host in enumerate(SEEDS,1): jobs[f'seed-{n}'] = lambda host=host: seed(host)
    for name, host in [('quorums-tls','quorums.mainnet.networks.dash.org'),('insight-tls','insight.dash.org')]:
        def cert(host=host):
            expiry=tls(host); good=expiry-time.time()>36*3600
            return {'ok':good,'reason':'healthy' if good else 'certificate-expiring','expiresAt':expiry}
        jobs[name]=cert
    # Independent data-feed health and consensus checks, using the existing observer's public projection.
    def observer():
        report = get('https://status.testnet.networks.dash.org/api/networks/mainnet')
        age = time.time()-datetime.datetime.fromisoformat(report['generatedAt'].replace('Z','+00:00')).timestamp()
        return report, age
    try: board, age = observer()
    except Exception: board, age = {}, 1e9
    m = board.get('summary',{}).get('mainnet') or {}
    def chain(kind):
        if age > 240: return {'ok': None, 'reason': 'reference-unavailable'}
        if kind == 'chainlocks':
            good = isinstance(m.get('chainLockAgeSeconds'), (int,float)) and m['chainLockAgeSeconds'] <= 1800
        else: good = m.get(kind+'Stall') is False and (kind != 'platform' or m.get('platformSyncing') is False)
        return {'ok': good, 'reason': 'healthy' if good else 'consensus-signal'}
    jobs['observer'] = lambda: {'ok': age <= 240 and reference is not None, 'reason': 'healthy' if age <= 240 and reference is not None else 'reference-unavailable'}
    for name in ['core','platform','chainlocks']: jobs[name] = lambda name=name: chain(name)
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        results = list(pool.map(lambda item: sampled(*item), jobs.items()))
    result = {'at': time.time(), 'services': results}
    atomic(ROOT/'samples.json',result)
    print(json.dumps(result))

# A repeated read of one sample cannot count as another failure/success.
def advance(old, sample, at):
    state = dict(old)
    if at <= state.get('at',0): return state
    continuous = 0 < at-state.get('at',0) <= 240
    good = sample.get('ok') is True
    state.update(at=at, reason=sample.get('reason','probe-failed'), ok=sample.get('ok'),
                 failures=(state.get('failures',0) if continuous else 0)+1 if not good else 0,
                 successes=(state.get('successes',0) if continuous else 0)+1 if good else 0)
    return state

def slack(message, thread=None):
    args = ['docker','exec','-u','1000','infraclaw','openclaw','message','send','--channel','slack',
            '--target','channel:'+CHANNEL,'--message',message,'--json']
    if thread: args += ['--reply-to',thread]
    raw = command(args,timeout=45)
    data = json.loads(raw[raw.index('{'):])
    payload = data.get('payload',data)
    if data.get('dryRun') or payload.get('ok') is False:
        raise ValueError('Slack delivery not confirmed')
    receipt = payload.get('result', payload)
    mid = receipt.get('messageId') or receipt.get('ts')
    if not mid: raise ValueError('Slack delivery receipt missing')
    return mid

def notify(send=slack, now=None):
    now = time.time() if now is None else now
    sample = read(ROOT/'samples.json'); ledger = read(ROOT/'alerts.json')
    at = sample.get('at',0)
    services = list(sample.get('services',[])) if 0 <= now-at <= 240 else []
    services.append({'id':'monitor','ok':0 <= now-at <= 240,'reason':'healthy' if 0 <= now-at <=240 else 'monitor-stale'})
    for s in services:
        key=s['id']; prev=ledger.get(key,{})
        state=advance(prev,s,now if key=='monitor' else at)
        ledger[key]=state
        # Owner policy: once notified, this issue stays silent, including probe flaps
        # and recovery. Keep tracking locally; never rearm from successful probes.
        if state.get('thread'):
            if state.get('successes',0)>=2: state['recovered']=True
            elif state.get('failures',0)>=3: state['recovered']=False
            atomic(ROOT/'alerts.json',ledger)
            continue
        # Journal pending state before transport. Only an actual receipt marks delivery.
        atomic(ROOT/'alerts.json',ledger)
        action = 'DOWN' if state.get('failures',0)>=3 else None
        if not action or state.get('deliveryUncertain'): continue
        if now-state.get('lastAttempt',0)<60: continue
        state['lastAttempt']=now
        incident=state.get('incident') or hashlib.sha256(f'mainnet:{key}:{at}'.encode()).hexdigest()[:12]
        state['incident']=incident
        # A crash/timeout after send must not trigger a blind duplicate. Reconcile first.
        state['deliveryUncertain']=True; atomic(ROOT/'alerts.json',ledger)
        utc=datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat()
        mentions='<@U02CNG35EGG> <@UCW1VE04T> '
        message=f'{mentions}Mainnet {key}: {action}. Incident {incident}. Observed {utc}. '
        message+=f"{state['failures']} consecutive failed checks; reason={state['reason']}. "
        message+='https://status.testnet.networks.dash.org/ — automated read-only monitor; no repair performed.'
        try:
            mid=send(message,state.get('thread'))
            state['lastDelivery']=mid;state.pop('deliveryError',None);state.pop('deliveryUncertain',None)
            state['thread']=mid;state['recovered']=False
        except Exception as e: state['deliveryError']=type(e).__name__
        atomic(ROOT/'alerts.json',ledger)
    print(json.dumps({'at':now,'activeAlerts':[k for k,v in ledger.items() if v.get('thread') and not v.get('recovered')],
                      'pendingDelivery':[k for k,v in ledger.items() if v.get('deliveryError')]}))

if __name__=='__main__':
    if sys.argv[1:] == ['notify']: notify()
    else: collect()
