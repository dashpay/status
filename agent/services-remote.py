#!/usr/bin/env python3
"""Devnet public services on the dashnet wallet host. Runs as root; idempotent.

  quorum-list-server  Core RPC (local)          -> 127.0.0.1:8080  -> https://quorums.<name>...
  platform explorer   Postgres, indexer, API, frontend (per-devnet build)
                      Tenderdash RPC via a VPC relay on one validator, Core RPC local
                                                -> 127.0.0.1:3000/3005 -> https://explorer.<name>...
  dash-faucet         dedicated legacy wallet "faucet", funded from the dashnet wallet
                                                -> 127.0.0.1:8000  -> https://faucet.<name>...
  caddy               Let's Encrypt TLS for the three names, X-Forwarded-For overwritten

Input: argv[1] is base64 JSON or @file (no secrets). The Core RPC password is read on
this host from /var/lib/dashnet/secrets.json and written only to 0600 files here.
Prints one JSON line with results.
"""
import base64, fcntl, json, os, re, secrets, subprocess, sys, time, urllib.request
from pathlib import Path

arg = sys.argv[1]
cfg = json.loads(Path(arg[1:]).read_text() if arg.startswith('@') else base64.b64decode(arg))
ROOT = Path('/opt/devnet-services')
ROOT.mkdir(mode=0o700, exist_ok=True)
log = lambda m: print(m, file=sys.stderr, flush=True)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
RPC_PORT = int(cfg['coreRpcPort'])
ZMQ_PORT = int(cfg.get('coreZmqPort', 29998))
PASSWORD = json.loads(Path('/var/lib/dashnet/secrets.json').read_text())['rpcPassword']
AUX = {'dashnet.auxiliary': cfg.get('auxiliary', '')}


def rpc(method, params=None, wallet=None):
    url = f'http://127.0.0.1:{RPC_PORT}/' + (f'wallet/{wallet}' if wallet else '')
    req = urllib.request.Request(url, data=json.dumps(dict(jsonrpc='1.0', id='svc', method=method, params=params or [])).encode(),
                                 headers={'Authorization': 'Basic ' + base64.b64encode(f'dashnet:{PASSWORD}'.encode()).decode(), 'Content-Type': 'application/json'})
    try:
        body = opener.open(req, timeout=120).read()
    except urllib.error.HTTPError as e:
        body = e.read()
    v = json.loads(body)
    if v.get('error'):
        raise RuntimeError(f"{method}: {v['error'].get('message')}")
    return v['result']


def write(name, text, mode=0o600):
    p = ROOT / name
    tmp = p.with_name('.' + p.name + '.tmp')
    tmp.write_text(text)
    os.chmod(tmp, mode)
    os.replace(tmp, p)


def sh(*args, cwd=None, timeout=3600):
    log('$ ' + ' '.join(args))
    subprocess.run(args, cwd=cwd, check=True, timeout=timeout)


def secret(name):
    p = ROOT / f'{name}.secret'
    if not p.exists():
        write(p.name, secrets.token_hex(24))
    return p.read_text().strip()


# ---- faucet wallet --------------------------------------------------------
def faucet_wallet():
    loaded = rpc('listwallets')
    if 'faucet' not in loaded:
        try:
            rpc('loadwallet', ['faucet', True])
        except RuntimeError as e:
            if 'not found' not in str(e).lower() and 'does not exist' not in str(e).lower():
                raise
            # Legacy (non-descriptor) wallet: the faucet uses dumpprivkey.
            rpc('createwallet', ['faucet', False, False, '', False, False, True])
    bal = rpc('getbalance', wallet='faucet')
    funding = float(cfg['faucetFunding'])
    if bal < funding / 2:
        free = rpc('getbalance', wallet='dashnet')
        amount = min(funding - bal, max(0.0, free - 500))
        if amount >= 50:
            parts = 20
            outs = {rpc('getnewaddress', wallet='faucet'): round(amount / parts, 8) for _ in range(parts)}
            txid = rpc('sendmany', ['', outs], wallet='dashnet')
            log(f'funded faucet wallet with {amount:.2f} in {parts} outputs: {txid}')
        else:
            log(f'dashnet wallet has {free:.2f} spendable; faucet funding deferred')
    # Include the funding that is still confirming.
    b = rpc('getbalances', wallet='faucet')['mine']
    return round(b['trusted'] + b['untrusted_pending'], 8)


# ---- builds ---------------------------------------------------------------
def checkout(url, ref, dest):
    d = ROOT / 'src' / dest
    if not (d / '.git').exists():
        sh('git', 'clone', '--quiet', url, str(d))
    sh('git', 'fetch', '--quiet', '--tags', 'origin', cwd=d)
    sh('git', 'checkout', '--quiet', '--force', ref, cwd=d)
    sh('git', 'clean', '-fdq', cwd=d)
    return d


def image_exists(tag):
    return subprocess.run(['docker', 'image', 'inspect', tag], capture_output=True).returncode == 0


def build_faucet():
    ref = cfg['faucetRef']
    tag = f"devnet-faucet:{ref[:12]}-{cfg['short']}"
    if image_exists(tag):
        return tag
    d = checkout('https://github.com/dashpay/dash-faucet', ref, 'dash-faucet')
    html = (d / 'static/index.html').read_text()
    label = cfg['displayName']
    html = html.replace('Dash Testnet Faucet', f'Dash {label} Faucet').replace('Get testnet DASH or create Platform identities', f'Get {cfg["coreNetwork"]} coins')
    html = html.replace('your testnet address', f'your {cfg["coreNetwork"]} address').replace('Enter your testnet Dash address', f'Enter your {cfg["coreNetwork"]} address')
    # Identity creation in this release is hardcoded to public testnet Platform.
    html = html.replace('</head>', '<style>#identityCard{display:none!important}</style></head>', 1)
    (d / 'static/index.html').write_text(html)
    sh('docker', 'build', '--quiet', '-t', tag, '.', cwd=d)
    return tag


def build_explorer_frontend():
    v = cfg['explorerVersion']
    tag = f"devnet-explorer-frontend:{v}-{cfg['short']}"
    if image_exists(tag):
        return tag
    d = checkout('https://github.com/pshenmic/platform-explorer', v if v == 'nightly' else f'{v}', 'platform-explorer')
    front = d / 'packages/frontend'
    (front / 'Dockerfile.devnet').write_text('\n'.join([
        'FROM node:22-bookworm-slim', 'WORKDIR /app', 'COPY . .',
        'ARG NEXT_PUBLIC_API_URL', 'ARG NEXT_PUBLIC_BASE_URL',
        'ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL NEXT_PUBLIC_TESTNET_BASE_URL=$NEXT_PUBLIC_BASE_URL NEXT_TELEMETRY_DISABLED=1',
        'RUN npm install --no-audit --no-fund && npm run build',
        'CMD ["npx", "next", "start", "-H", "127.0.0.1", "-p", "3000"]', '']))
    sh('docker', 'build', '--quiet', '-f', 'Dockerfile.devnet', '-t', tag,
       '--build-arg', f"NEXT_PUBLIC_API_URL=https://{cfg['hosts']['explorer']}/backend",
       '--build-arg', f"NEXT_PUBLIC_BASE_URL=https://{cfg['hosts']['explorer']}", '.', cwd=front, timeout=5400)
    return tag


def patch_explorer_api(image):
    """Bind-mounted patches for the released API image on a devnet."""
    sh('docker', 'pull', '--quiet', image, timeout=1200)

    def read(path):
        return subprocess.run(['docker', 'run', '--rm', '--label', f"dashnet.auxiliary={AUX['dashnet.auxiliary']}", '--entrypoint', 'cat', image, path],
                              capture_output=True, check=True, timeout=120).stdout.decode()

    mounts = []
    # Block quorums resolve as testnet/mainnet types only; devnet Platform
    # quorums are llmq_devnet_platform (107).
    src = read('/app/src/controllers/BlocksController.js')
    old = "NETWORK === 'testnet'\n        ? QuorumTypeEnum.llmq_25_67\n        : QuorumTypeEnum.llmq_100_67"
    if old in src:
        src = src.replace(old, 'QuorumTypeEnum.llmq_devnet_platform')
    else:
        log('explorer API: block quorum code changed upstream; leaving it unpatched')
    write('explorer-BlocksController.js', src, 0o644)
    mounts.append(f'{ROOT}/explorer-BlocksController.js:/app/src/controllers/BlocksController.js:ro')
    # The SDK verifies proofs with quorum keys fetched from the public testnet
    # explorer, which has no devnet quorums; ask this devnet's own API instead.
    sdk = '/app/node_modules/dash-platform-sdk/src/utils/getQuorumPublicKey.js'
    src = read(sdk)
    patched = re.sub(r"https://\$\{network === 'mainnet' \? '' : 'testnet\.'\}platform-explorer\.pshenmic\.dev", 'http://127.0.0.1:3005', src)
    if patched == src:
        log('explorer API: SDK quorum key lookup changed upstream; leaving it unpatched')
    write('explorer-getQuorumPublicKey.js', patched, 0o644)
    mounts.append(f'{ROOT}/explorer-getQuorumPublicKey.js:{sdk}:ro')
    return mounts


def insight_files():
    """dashcore-node config for the wallet host's Core (which dash-network-go runs
    with txindex/addressindex/spentindex/timestampindex and loopback ZMQ), plus a
    patch so the web service listens on loopback only, behind Caddy."""
    image = cfg['insightImage']
    sh('docker', 'pull', '--quiet', image, timeout=1200)
    write('insight.json', json.dumps(dict(
        network='testnet', port=3001,
        services=['dashd', '@dashevo/insight-api', '@dashevo/insight-ui', 'web'],
        servicesConfig={'dashd': {'connect': [dict(rpchost='127.0.0.1', rpcport=RPC_PORT, rpcuser='dashnet', rpcpassword=PASSWORD,
                                                   zmqpubrawtx=f'tcp://127.0.0.1:{ZMQ_PORT}', zmqpubhashblock=f'tcp://127.0.0.1:{ZMQ_PORT}')]},
                        '@dashevo/insight-api': {'disableRateLimiter': True}}), indent=1))
    web = subprocess.run(['docker', 'run', '--rm', '--label', f"dashnet.auxiliary={AUX['dashnet.auxiliary']}", '--entrypoint', 'cat', image, '/insight/lib/services/web.js'],
                         capture_output=True, check=True, timeout=120).stdout.decode()
    patched = web.replace('self.server.listen(self.port);', "self.server.listen(self.port, '127.0.0.1');")
    if patched == web:
        log('insight: web listener code changed upstream; it will listen on all interfaces (security group limits it to the fleet)')
    write('insight-web.js', patched, 0o644)
    return [f'{ROOT}/insight.json:/insight/dashcore-node.json:ro', f'{ROOT}/insight-web.js:/insight/lib/services/web.js:ro']


def insight_blocks(seconds=300):
    # Insight is useful once it follows the chain tip, not just when it answers.
    end, last = time.time() + seconds, None
    tip = rpc('getblockcount')
    while time.time() < end:
        try:
            with opener.open('http://127.0.0.1:3001/insight-api/status?q=getInfo', timeout=10) as r:
                last = json.loads(r.read()).get('info', {}).get('blocks')
            if isinstance(last, int) and last >= tip - 2:
                return last
        except Exception:
            pass
        time.sleep(5)
    return last


# ---- compose --------------------------------------------------------------
def compose(faucet_image, frontend_image):
    pg = secret('postgres')
    ev = cfg['explorerVersion']
    # quorum-list-server reads either a complete config.toml or, when none
    # parses, only environment variables; use the environment (0600 env file).
    (ROOT / 'qls.toml').unlink(missing_ok=True)
    write('qls.env', '\n'.join([
        'API_HOST=127.0.0.1', 'API_PORT=8080', 'DASH_NETWORK=devnet', 'QUORUM_PREVIOUS_BLOCKS_OFFSET=8',
        f'DASH_RPC_URL=http://127.0.0.1:{RPC_PORT}', 'DASH_RPC_USER=dashnet', f'DASH_RPC_PASSWORD={PASSWORD}', '']))
    write('faucet.env', '\n'.join([
        f'DASH_RPC_HOST=127.0.0.1:{RPC_PORT}/wallet/faucet#', f'DASH_RPC_PORT={RPC_PORT}', 'DASH_RPC_USER=dashnet', f'DASH_RPC_PASSWORD={PASSWORD}',
        f"CORE_FAUCET_AMOUNT={cfg['faucetAmount']}", f"RATE_LIMIT_PER_HOUR={cfg['faucetRateLimit']}", 'ISLOCK_TIMEOUT=60', 'CAP_SITE_KEY=', 'CAP_SECRET=', '']))
    common = [f'POSTGRES_HOST=127.0.0.1', 'POSTGRES_PORT=5433', 'POSTGRES_DB=explorer', 'POSTGRES_USER=explorer', f'POSTGRES_PASS={pg}',
              f"TENDERDASH_URL={cfg['tenderdashUrl']}"]
    write('explorer-indexer.env', '\n'.join(common + [
        'CORE_RPC_HOST=127.0.0.1', f'CORE_RPC_PORT={RPC_PORT}', 'CORE_RPC_USER=dashnet', f'CORE_RPC_PASSWORD={PASSWORD}',
        'PLATFORM_EXPLORER_DATA_CONTRACT_IDENTIFIER=8AoJWLcT4t1uFuWkeTfbeN2EuGuvX2nJsZMVpDsF4ASm', '']))
    write('explorer-api.env', '\n'.join(common + [
        'DASHCORE_HOST=127.0.0.1', f'DASHCORE_PORT={RPC_PORT}', 'DASHCORE_USER=dashnet', f'DASHCORE_PASS={PASSWORD}',
        'DAPI_URL=' + ','.join(cfg['dapiUrls']), 'NETWORK=testnet', f"EPOCH_CHANGE_TIME={cfg['epochSeconds'] * 1000}",
        'CONTESTED_RESOURCE_VOTE_DEADLINE=5400000', 'TCP_CONNECT_TIMEOUT=400', 'NODE_TLS_REJECT_UNAUTHORIZED=0', '']))
    write('postgres.env', f'POSTGRES_DB=explorer\nPOSTGRES_USER=explorer\nPOSTGRES_PASSWORD={pg}\n')
    h = cfg['hosts']
    write('Caddyfile', '\n'.join([
        '{', '  email infrastructure@dash.org', '}',
        f"{h['insight']} {{", '  redir / /insight/', '  reverse_proxy 127.0.0.1:3001', '}',
        f"{h['quorums']} {{", '  reverse_proxy 127.0.0.1:8080', '}',
        f"{h['explorer']} {{", '  handle_path /backend/* {', '    reverse_proxy 127.0.0.1:3005', '  }', '  reverse_proxy 127.0.0.1:3000', '}',
        f"{h['faucet']} {{", '  reverse_proxy 127.0.0.1:8000', '}', '']), 0o644)
    # dash-network-go preflight ignores only containers labelled for this exact host.
    svc = lambda image, **kw: dict(image=image, network_mode='host', restart='unless-stopped', logging=dict(driver='local'), labels=AUX, **kw)
    idx = f'ghcr.io/pshenmic/platform-explorer-indexer:{ev}'
    spec = dict(name='devnet-services', services=dict(
        quorums=svc(cfg['quorumServerImage'], env_file=[f'{ROOT}/qls.env']),
        insight=svc(cfg['insightImage'], volumes=insight_files()),
        faucet=svc(faucet_image, env_file=[f'{ROOT}/faucet.env'], healthcheck=dict(test=['CMD', 'curl', '-fsS', 'http://127.0.0.1:8000/health'], interval='30s', retries=3), command=['uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000']),
        postgres=svc('postgres:17', env_file=[f'{ROOT}/postgres.env'], command=['postgres', '-c', 'listen_addresses=127.0.0.1', '-c', 'port=5433'], volumes=['explorer-db:/var/lib/postgresql/data'],
                     healthcheck=dict(test=['CMD-SHELL', 'pg_isready -h 127.0.0.1 -p 5433 -U explorer -d explorer'], interval='5s', retries=30)),
        **{'explorer-migrate': dict(svc(idx, env_file=[f'{ROOT}/explorer-indexer.env'], command=['/app/indexer', 'migrate'], depends_on={'postgres': {'condition': 'service_healthy'}}), restart='no')},
        **{'explorer-indexer': svc(idx, env_file=[f'{ROOT}/explorer-indexer.env'], command=['/app/indexer'], depends_on={'explorer-migrate': {'condition': 'service_completed_successfully'}})},
        **{'explorer-api': svc(f'ghcr.io/pshenmic/platform-explorer-api:{ev}', env_file=[f'{ROOT}/explorer-api.env'], volumes=patch_explorer_api(f'ghcr.io/pshenmic/platform-explorer-api:{ev}'), depends_on={'explorer-migrate': {'condition': 'service_completed_successfully'}})},
        **{'explorer-frontend': svc(frontend_image)},
        caddy=svc('caddy:2', volumes=[f'{ROOT}/Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy-data:/data', 'caddy-config:/config']),
    ), volumes={'explorer-db': {}, 'caddy-data': {}, 'caddy-config': {}})
    write('compose.json', json.dumps(spec, indent=1))
    sh('docker', 'compose', '-f', str(ROOT / 'compose.json'), 'pull', '--quiet', 'quorums', 'insight', 'postgres', 'explorer-migrate', 'explorer-api', 'caddy', timeout=1200)
    sh('docker', 'compose', '-f', str(ROOT / 'compose.json'), 'up', '-d', '--remove-orphans', timeout=1200)


def topup_cron():
    # Periodic top-up from the dashnet wallet reuses this script (saved by the agent).
    write('topup.json', json.dumps(dict(cfg, topupOnly=True)), 0o600)
    cron = Path('/etc/cron.d/devnet-faucet-topup')
    cron.write_text(f'*/15 * * * * root /usr/bin/python3 {ROOT}/services.py @{ROOT}/topup.json >> /var/log/devnet-faucet-topup.log 2>&1\n')
    os.chmod(cron, 0o644)


def wait_quorums(seconds=240):
    # The quorum list must come from Core, not only the health route answering.
    end, last = time.time() + seconds, None
    while time.time() < end:
        try:
            with opener.open('http://127.0.0.1:8080/quorums', timeout=10) as r:
                v = json.loads(r.read())
            if v.get('success') and v.get('data'):
                return len(v['data'])
            last = v.get('message')
        except Exception as e:
            last = type(e).__name__
        time.sleep(10)
    return f'not populated: {last}'


def wait(url, seconds=180):
    # Services come up in order (the explorer API answers 500 until the indexer
    # has written block 1), so keep retrying 5xx until the deadline.
    end, last = time.time() + seconds, None
    while time.time() < end:
        try:
            with opener.open(url, timeout=5) as r:
                return r.status
        except urllib.error.HTTPError as e:
            last = e.code
            if e.code < 500:
                return e.code
        except Exception:
            pass
        time.sleep(3)
    return last


# One run at a time per host: the cron top-up skips while an install runs.
lock = open('/run/lock/devnet-services.lock', 'w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | (fcntl.LOCK_NB if cfg.get('topupOnly') else 0))
except BlockingIOError:
    sys.exit(0)

if cfg.get('topupOnly'):
    print(json.dumps(dict(faucetBalance=faucet_wallet())))
    sys.exit(0)

balance = faucet_wallet()
faucet_image = build_faucet()
frontend_image = build_explorer_frontend()
compose(faucet_image, frontend_image)
topup_cron()
result = dict(faucetBalance=balance, faucetImage=faucet_image, frontendImage=frontend_image,
              quorums=wait('http://127.0.0.1:8080/health'), quorumList=wait_quorums(),
              insight=wait('http://127.0.0.1:3001/insight-api/status'), insightBlocks=insight_blocks(), faucet=wait('http://127.0.0.1:8000/health'),
              explorerApi=wait('http://127.0.0.1:3005/status', 300), explorerValidators=wait('http://127.0.0.1:3005/validators?limit=1', 180), explorerFrontend=wait('http://127.0.0.1:3000/', 300),
              walletAddress=rpc('getnewaddress', wallet='faucet'))
print(json.dumps(result))
