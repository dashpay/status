#!/usr/bin/env python3
"""Read-only host probe. Streamed over SSH to `sudo python3 - ROLE` and prints one JSON object.

Only local sources are queried (Docker, Core RPC through dash-cli, Tenderdash RPC,
DAPI gRPC through the local gateway, Insight, the faucet). Nothing is written.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

START = time.time()
ROLE = sys.argv[1] if len(sys.argv) > 1 else ''
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
errors = []


def run(args, timeout=20, stdin=None):
    p = subprocess.run(args, capture_output=True, timeout=timeout, input=stdin)
    if p.returncode:
        raise RuntimeError((p.stderr or p.stdout).decode(errors='replace').strip().splitlines()[-1:][0][:200] if (p.stderr or p.stdout) else 'exit %d' % p.returncode)
    return p.stdout


def parse(raw):
    try:
        return json.loads(raw)
    except ValueError:
        return raw.decode(errors='replace').strip()


def http_json(url, timeout=8):
    with OPENER.open(url, timeout=timeout) as r:
        return json.loads(r.read(4 * 1024 * 1024))


def attempt(label, fn, *args):
    try:
        return fn(*args)
    except Exception as e:  # every source is optional; report which failed
        errors.append('%s: %s' % (label, str(e)[:200]))
        return None


def system():
    mem = {}
    for line in open('/proc/meminfo'):
        k, v = line.split(':', 1)
        mem[k] = int(v.split()[0]) * 1024
    disks, seen = [], set()
    for mount in ['/', '/var/lib/docker', '/dash', '/home', '/data']:
        if not os.path.isdir(mount):
            continue
        st = os.stat(mount)
        if st.st_dev in seen:
            continue
        seen.add(st.st_dev)
        v = os.statvfs(mount)
        disks.append(dict(mount=mount, size=v.f_blocks * v.f_frsize, used=(v.f_blocks - v.f_bfree) * v.f_frsize,
                          avail=v.f_bavail * v.f_frsize))
    release = {}
    try:
        for line in open('/etc/os-release'):
            if '=' in line:
                k, v = line.rstrip().split('=', 1)
                release[k] = v.strip('"')
    except OSError:
        pass
    return dict(load=[float(x) for x in open('/proc/loadavg').read().split()[:3]], cpus=os.cpu_count(),
                memTotal=mem.get('MemTotal'), memAvailable=mem.get('MemAvailable'),
                swapTotal=mem.get('SwapTotal'), swapFree=mem.get('SwapFree'),
                uptime=float(open('/proc/uptime').read().split()[0]), disks=disks,
                kernel=os.uname().release, os=release.get('PRETTY_NAME'), arch=os.uname().machine)


def repo(image):
    name = image.split('@')[0]
    if ':' in name.rsplit('/', 1)[-1]:
        name = name.rsplit(':', 1)[0]
    return re.sub(r'^((index\.)?docker\.io/)?(library/)?', '', name)


def docker():
    if not shutil.which('docker'):
        return None, {}
    ids = run(['docker', 'ps', '-aq', '--no-trunc']).split()
    info = json.loads(run(['docker', 'inspect', *[i.decode() for i in ids]])) if ids else []
    images = {}
    unique = sorted({c['Image'] for c in info})
    if unique:
        for img in json.loads(run(['docker', 'image', 'inspect', *unique])):
            images[img['Id']] = img
    out, raw = [], {}
    for c in info:
        name = c['Name'].lstrip('/')
        img = images.get(c['Image'], {})
        ref = c['Config']['Image']
        digest = next((d for d in img.get('RepoDigests', []) if repo(d) == repo(ref)), None)
        st = c['State']
        ports = []
        for port, binds in (c['HostConfig'].get('PortBindings') or {}).items():
            for b in binds or []:
                ports.append('%s:%s->%s' % (b.get('HostIp') or '0.0.0.0', b.get('HostPort'), port))
        out.append(dict(name=name, image=ref, repo=repo(ref), digest=digest.split('@')[1] if digest else None,
                        imageCreated=img.get('Created'), state=st['Status'], running=bool(st['Running']) and not st.get('Restarting'),
                        health=(st.get('Health') or {}).get('Status'), startedAt=st.get('StartedAt'),
                        finishedAt=st.get('FinishedAt'), exitCode=st.get('ExitCode'), restarts=c.get('RestartCount', 0),
                        ports=sorted(ports), network=c['HostConfig'].get('NetworkMode')))
        raw[name] = c
    out.sort(key=lambda c: c['name'])
    return out, raw


def find(raw, repos, running=True):
    for name, c in sorted(raw.items()):
        if repo(c['Config']['Image']) in repos and (not running or c['State']['Running']):
            return c
    return None


def host_port(c, port):
    for b in (c['HostConfig'].get('PortBindings') or {}).get('%d/tcp' % port) or []:
        if b.get('HostIp', '') in ('', '0.0.0.0', '127.0.0.1'):
            return '127.0.0.1', int(b['HostPort'])
    if c['HostConfig'].get('NetworkMode') == 'host':
        return '127.0.0.1', port
    for n in (c['NetworkSettings'].get('Networks') or {}).values():
        if n.get('IPAddress'):
            return n['IPAddress'], port
    raise RuntimeError('no reachable port %d' % port)


def core_cli(raw):
    c = find(raw, ['dashpay/dashd'])
    if c:
        args = ['docker', 'exec', c['Id'], 'dash-cli']
        confs = [m['Destination'] for m in c['Mounts'] if m['Destination'].endswith('dash.conf')]
        cmd = (c['Config'].get('Entrypoint') or []) + (c['Config'].get('Cmd') or [])
        for a in cmd:
            if a.startswith(('-conf=', '-datadir=')):
                args.append(a)
        if confs and not any(a.startswith('-conf=') for a in args):
            args.append('-conf=' + confs[0])
        return args, c['Name'].lstrip('/')
    if shutil.which('dash-cli') or os.path.exists('/usr/local/bin/dash-cli'):
        return ['sudo', '-u', 'ubuntu', '-H', shutil.which('dash-cli') or '/usr/local/bin/dash-cli'], 'native'
    return None, None


def core(raw):
    cli, where = core_cli(raw)
    if not cli:
        return None
    call = lambda *a: parse(run(cli + [str(x) for x in a], timeout=20))
    bc = call('getblockchaininfo')
    net = attempt('core getnetworkinfo', call, 'getnetworkinfo') or {}
    out = dict(source=where, chain=bc.get('chain'), blocks=bc.get('blocks'), headers=bc.get('headers'),
               bestBlockHash=bc.get('bestblockhash'), blockTime=bc.get('time'), medianTime=bc.get('mediantime'),
               ibd=bc.get('initialblockdownload'), progress=bc.get('verificationprogress'), sizeOnDisk=bc.get('size_on_disk'),
               pruned=bc.get('pruned'), difficulty=bc.get('difficulty'),
               version=net.get('version'), subversion=net.get('subversion'), protocol=net.get('protocolversion'),
               connections=net.get('connections'), connectionsIn=net.get('connections_in'), connectionsOut=net.get('connections_out'))
    sync = attempt('core mnsync', call, 'mnsync', 'status')
    if isinstance(sync, dict):
        out['synced'] = bool(sync.get('IsSynced'))
    cl = attempt('core chainlock', call, 'getbestchainlock')
    if isinstance(cl, dict):
        out['chainLockHeight'] = cl.get('height')
    mp = attempt('core mempool', call, 'getmempoolinfo')
    if isinstance(mp, dict):
        out['mempool'] = mp.get('size')
    if ROLE in ('validator', 'masternode'):
        mn = attempt('core masternode status', call, 'masternode', 'status')
        if isinstance(mn, dict):
            st = mn.get('dmnState') or {}
            out['masternode'] = dict(state=mn.get('state'), status=mn.get('status'), proTxHash=mn.get('proTxHash'),
                                     service=mn.get('service'), type=mn.get('type'), posePenalty=st.get('PoSePenalty'),
                                     poseBanHeight=st.get('PoSeBanHeight'), lastPaidHeight=st.get('lastPaidHeight'),
                                     registeredHeight=st.get('registeredHeight'))
    wallets = attempt('core listwallets', call, 'listwallets')
    if isinstance(wallets, list) and wallets:
        out['wallets'] = []
        for w in wallets[:20]:
            b = attempt('core wallet ' + w, call, '-rpcwallet=' + w, 'getbalances')
            if isinstance(b, dict):
                mine = b.get('mine') or {}
                out['wallets'].append(dict(name=w, trusted=mine.get('trusted'), pending=mine.get('untrusted_pending'),
                                           immature=mine.get('immature'), coinjoin=mine.get('coinjoin')))
    if ROLE == 'miner':
        mi = attempt('core mining', call, 'getmininginfo')
        if isinstance(mi, dict):
            out['mining'] = dict(hashps=mi.get('networkhashps'), difficulty=mi.get('difficulty'))
    return out


def tenderdash(raw):
    c = find(raw, ['dashpay/tenderdash'])
    if not c:
        return None
    # RPC is often bound only inside the container: query it from its network namespace.
    pid = str(c['State']['Pid'])
    bound = (c['HostConfig'].get('PortBindings') or {})
    ports = [p for p in (36657, 26657) if '%d/tcp' % p in bound] or [26657, 36657]

    def fetch(path, port):
        raw_ = run(['nsenter', '-t', pid, '-n', 'curl', '-s', '--fail', '-m', '6', 'http://127.0.0.1:%d/%s' % (port, path)], timeout=10)
        v = json.loads(raw_)
        if v.get('error'):
            raise RuntimeError(str(v['error'])[:120])
        return v.get('result', v)
    port = None
    for candidate in ports:
        try:
            st = fetch('status', candidate); port = candidate; break
        except Exception:
            continue
    if port is None:
        # Seed-mode nodes expose no RPC: count established P2P sessions and read
        # the chain ID from the metrics endpoint instead.
        est = run(['nsenter', '-t', pid, '-n', 'ss', '-Htn', 'state', 'established'], timeout=10).decode().splitlines()
        p2p = [l for l in est if ':36656 ' in l or ':26656 ' in l]
        out = dict(source='p2p', peers=len(p2p))
        for mport in (36660, 26660):
            try:
                text = run(['nsenter', '-t', pid, '-n', 'curl', '-s', '--fail', '-m', '6', 'http://127.0.0.1:%d/metrics' % mport], timeout=10).decode()
                m = re.search(r'chain_id="([^"]+)"', text)
                if m:
                    out['network'] = m.group(1)
                break
            except Exception:
                continue
        return out
        raise RuntimeError('rpc unreachable on %s' % ports)
    get = lambda p: fetch(p, port)
    ni, si, vi = st.get('node_info') or {}, st.get('sync_info') or {}, st.get('validator_info') or {}
    out = dict(network=ni.get('network'), version=ni.get('version'), nodeId=ni.get('id'),
               protocolApp=int((ni.get('protocol_version') or {}).get('app') or 0) or None,
               height=int(si.get('latest_block_height') or 0), blockTime=si.get('latest_block_time'),
               catchingUp=si.get('catching_up'), proTxHash=vi.get('pro_tx_hash'),
               votingPower=int(vi['voting_power']) if vi.get('voting_power') is not None else None)
    net = attempt('tenderdash net_info', get, 'net_info')
    if isinstance(net, dict):
        out['peers'] = int(net.get('n_peers') or 0)
    if ROLE == 'validator':
        vals = attempt('tenderdash validators', get, 'validators?per_page=100')
        if isinstance(vals, dict):
            out['validatorSetSize'] = int(vals.get('total') or len(vals.get('validators') or []))
            out['inValidatorSet'] = any((v.get('pro_tx_hash') or '').lower() == (out['proTxHash'] or '').lower()
                                        for v in vals.get('validators') or [])
    return out


def protobuf(raw):
    fields, i = {}, 0

    def varint():
        nonlocal i
        shift = value = 0
        while True:
            b = raw[i]; i += 1
            value |= (b & 0x7f) << shift
            if b < 0x80:
                return value
            shift += 7
    while i < len(raw):
        key = varint(); number, wire = key >> 3, key & 7
        if wire == 0:
            value = varint()
        elif wire == 2:
            n = varint(); value = raw[i:i + n]; i += n
        elif wire == 1:
            value = raw[i:i + 8]; i += 8
        elif wire == 5:
            value = raw[i:i + 4]; i += 4
        else:
            raise ValueError('protobuf wire type')
        fields[number] = value
    return fields


def dapi(raw, address):
    gw = find(raw, ['dashpay/envoy'])
    if not gw:
        return None
    ports = (gw['HostConfig'].get('PortBindings') or {})
    port = next((int(b['HostPort']) for k, v in ports.items() if k == '10000/tcp' for b in v or []), None)
    if not port:
        port = next((int(b['HostPort']) for k, v in ports.items() for b in v or [] if b.get('HostPort') == '443'), 443)
    cert = [m['Source'] for m in gw['Mounts'] if m['Destination'].endswith('/bundle.crt')]
    with tempfile.TemporaryDirectory(prefix='status-probe-') as d:
        headers = os.path.join(d, 'h')
        args = ['curl', '--silent', '--show-error', '--fail', '--noproxy', '*', '--max-time', '10', '--http2',
                '-D', headers, '-H', 'content-type: application/grpc', '-H', 'te: trailers', '--data-binary', '@-']
        args += (['--cacert', cert[0], '--connect-to', '%s:%d:127.0.0.1:%d' % (address, port, port),
                  'https://%s:%d/org.dash.platform.dapi.v0.Platform/getStatus' % (address, port)]
                 if cert and address else ['-k', 'https://127.0.0.1:%d/org.dash.platform.dapi.v0.Platform/getStatus' % port])
        t = time.time()
        body = run(args, timeout=15, stdin=b'\x00\x00\x00\x00\x02\x0a\x00')
        latency = round((time.time() - t) * 1000)
        if 'grpc-status: 0' not in open(headers).read().lower():
            raise RuntimeError('grpc-status not ok')
    if len(body) < 5 or body[0] != 0:
        raise RuntimeError('bad grpc frame')
    v0 = protobuf(protobuf(body[5:])[1])
    version = protobuf(v0.get(1, b''))
    software = protobuf(version.get(1, b''))
    protocol = protobuf(version.get(2, b''))
    chain = protobuf(v0.get(3, b''))
    network = protobuf(v0.get(4, b''))
    txt = lambda b: b.decode(errors='replace') if isinstance(b, bytes) else None
    tdp = protobuf(protocol.get(1, b'')) if protocol.get(1) else {}
    drp = protobuf(protocol.get(2, b'')) if protocol.get(2) else {}
    return dict(ok=True, latencyMs=latency, dapiVersion=txt(software.get(1)), driveVersion=txt(software.get(2)),
                tenderdashVersion=txt(software.get(3)), height=chain.get(4), catchingUp=bool(chain.get(1, 0)),
                chainId=txt(network.get(1)), peers=network.get(2),
                driveProtocol=drp.get(2) or drp.get(1), tenderdashP2P=tdp.get(1))


def insight(raw):
    c = find(raw, ['dashpay/insight'])
    if not c:
        return None
    host, port = host_port(c, 3001)
    base = 'http://%s:%d/insight-api/' % (host, port)
    info = http_json(base + 'status?q=getInfo').get('info', {})
    sync = attempt('insight sync', http_json, base + 'sync') or {}
    return dict(blocks=info.get('blocks'), version=info.get('version'), network=info.get('network'),
                syncStatus=sync.get('status'), syncPercentage=sync.get('syncPercentage'),
                syncHeight=sync.get('height') or sync.get('blockChainHeight'), error=sync.get('error'))


def http_check(raw, repos, port):
    c = find(raw, repos)
    if not c:
        return None
    host, p = host_port(c, port)
    t = time.time()
    try:
        with OPENER.open('http://%s:%d/' % (host, p), timeout=8) as r:
            code = r.status
            body = r.read(65536).decode(errors='replace')
    except urllib.error.HTTPError as e:
        code, body = e.code, ''
    title = re.search(r'<title>(.*?)</title>', body, re.S | re.I)
    return dict(status=code, latencyMs=round((time.time() - t) * 1000), title=title.group(1).strip()[:80] if title else None)


result = dict(role=ROLE, system=attempt('system', system))
containers, raw = attempt('docker', docker) or (None, {})
result['containers'] = containers
address = sys.argv[2] if len(sys.argv) > 2 else ''
result['core'] = attempt('core', core, raw)
result['tenderdash'] = attempt('tenderdash', tenderdash, raw)
if ROLE == 'validator':
    try:
        result['dapi'] = dapi(raw, address)
    except Exception as e:
        result['dapi'] = dict(ok=False, error=str(e)[:200])
result['insight'] = attempt('insight', insight, raw)
result['faucet'] = attempt('faucet', http_check, raw, ['dashpay/multifaucet'], 80)
result['errors'] = errors
result['probeMs'] = round((time.time() - START) * 1000)
print(json.dumps(result, separators=(',', ':')))
