#!/usr/bin/env python3
"""Platform wipe/redeploy on a dashmate devnet host (HPMN or standalone Tenderdash seed).

Usage: sudo python3 - <stage> <base64 JSON request>
Stages: baseline, stage, anchor, anchor-check, canary, wipe, apply, start, verify.
Prints one JSON object. Core, wallets, registrations, node identities and
certificates are preserved; only Platform state is reset. Secrets never leave
the host: backups stay under /var/lib/dash-status-reset/<exec>/ (root, 0700).
"""
import base64, hashlib, json, os, pwd, re, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

STAGE = sys.argv[1]
Q = json.loads(base64.b64decode(sys.argv[2]))
CFG = Q['config']                      # dashmate config name, e.g. devnet-moutai
ROLE = Q['role']                       # 'hpmn' or 'seed'
STATE = Path('/var/lib/dash-status-reset') / Q['exec']
DM_HOME = Path('/home/dashmate/.dashmate')
SEED = Path('/dash/tenderdash')
SEED_COMPOSE = SEED / 'docker-compose.yml'
SEED_DATA = SEED / 'tenderdash' / 'data'
PLATFORM = ['drive_abci', 'drive_tenderdash', 'rs_dapi', 'gateway', 'gateway_rate_limiter', 'gateway_rate_limiter_metrics', 'gateway_rate_limiter_redis']
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Fail(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise Fail(msg)


def run(args, timeout=300, env=None, cwd=None, check=True, user=None):
    if user:
        args = ['sudo', '-H', '-u', user, *(['env'] + [f'{k}={v}' for k, v in (env or {}).items()] if env else []), *args]
        env = None
    p = subprocess.run(args, capture_output=True, timeout=timeout, env={**os.environ, **(env or {})}, cwd=cwd)
    if check and p.returncode:
        raise Fail(f"{' '.join(args[:6])}: exit {p.returncode}: {(p.stderr or p.stdout).decode(errors='replace').strip()[-300:]}")
    return p.stdout.decode(errors='replace')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tree_hashes(root):
    root = Path(root)
    out = {}
    if root.exists():
        for p in sorted(root.rglob('*')):
            if p.is_file() and not p.is_symlink():
                out[str(p.relative_to(root))] = sha(p)
    return out


def canonical(v):
    return hashlib.sha256(json.dumps(v, sort_keys=True).encode()).hexdigest()


def inspect(name):
    raw = run(['docker', 'inspect', name], check=False)
    try:
        v = json.loads(raw)
        return v[0] if v else None
    except ValueError:
        return None


def containers():
    ids = run(['docker', 'ps', '-aq', '--no-trunc']).split()
    return json.loads(run(['docker', 'inspect', *ids])) if ids else []


def core_container():
    if ROLE == 'hpmn':
        c = inspect(f'dashmate_{CFG}-core-1')
        if c:
            return c
    for c in containers():
        if c['Config']['Image'].split('@')[0].split(':')[0].endswith('dashpay/dashd') and c['State']['Running']:
            return c
    raise Fail('core container not found')


def core_cli(c, *args):
    cmd = ['docker', 'exec', c['Id'], 'dash-cli']
    for a in (c['Config'].get('Entrypoint') or []) + (c['Config'].get('Cmd') or []):
        if a.startswith(('-conf=', '-datadir=')):
            cmd.append(a)
    confs = [m['Destination'] for m in c['Mounts'] if m['Destination'].endswith('dash.conf')]
    if confs and not any(a.startswith('-conf=') for a in cmd):
        cmd.append('-conf=' + confs[0])
    out = run(cmd + [str(a) for a in args], timeout=60)
    try:
        return json.loads(out)
    except ValueError:
        return out.strip()


def dm_config(home=DM_HOME):
    return json.loads((home / 'config.json').read_text())


def core_identity(c):
    return dict(id=c['Id'], startedAt=c['State']['StartedAt'], image=c['Config']['Image'])


def core_files(home=DM_HOME):
    return tree_hashes(home / CFG / 'core') if ROLE == 'hpmn' else {}


def platform_containers():
    out = {}
    for c in containers():
        name = c['Name'].lstrip('/')
        m = re.fullmatch(rf'dashmate_{re.escape(CFG)}-(.+)-1', name)
        if m and m.group(1) in PLATFORM:
            out[m.group(1)] = dict(id=c['Id'], image=c['Config']['Image'], running=c['State']['Running'], restarts=c.get('RestartCount', 0), state=c['State']['Status'])
    return out


def save_json(name, v):
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    (STATE / name).write_text(json.dumps(v))
    os.chmod(STATE / name, 0o600)


def load_json(name):
    p = STATE / name
    need(p.exists(), f'{name} missing; run baseline first')
    return json.loads(p.read_text())


def seed_dir_meta():
    need(SEED_DATA.exists() and SEED_DATA.is_dir() and not SEED_DATA.is_symlink(), f'{SEED_DATA} missing or not a directory')
    need(SEED_DATA.resolve() == SEED_DATA, 'unexpected symlink in the seed data path')
    st = SEED_DATA.stat()
    return dict(uid=st.st_uid, gid=st.st_gid, mode=oct(st.st_mode & 0o7777))


def seed_services():
    return run(['docker', 'compose', '-f', str(SEED_COMPOSE), 'config', '--services']).split()


# ---- stages -----------------------------------------------------------------
def baseline():
    c = core_container()
    info = core_cli(c, 'getblockchaininfo')
    need(info.get('chain') == Q['coreChain'], f"Core reports chain {info.get('chain')}, expected {Q['coreChain']}")
    sync = core_cli(c, 'mnsync', 'status')
    need(not info.get('initialblockdownload') and sync.get('IsSynced'), 'Core is not synchronized')
    out = dict(core=core_identity(c), height=info['blocks'], coreChain=info['chain'])
    backup = STATE / 'backup'
    if backup.exists() and (STATE / 'baseline.json').exists():
        # Baseline is taken once per execution; reruns only report it.
        return {**load_json('baseline.json'), 'reused': True}
    backup.mkdir(mode=0o700, parents=True, exist_ok=True)
    if ROLE == 'hpmn':
        mn = core_cli(c, 'masternode', 'status')
        need(mn.get('state') == 'READY', f"masternode state {mn.get('state')}")
        cfg = dm_config()
        need(CFG in cfg['configs'], f'dashmate config {CFG} not found')
        conf = cfg['configs'][CFG]
        shutil.copy2(DM_HOME / 'config.json', backup / 'config.json')
        shutil.copytree(DM_HOME / CFG, backup / CFG, symlinks=True)
        out.update(masternode=mn.get('state'), proTxHash=mn.get('proTxHash'), configFormatVersion=cfg.get('configFormatVersion'),
                   configHash=sha(DM_HOME / 'config.json'), coreSection=canonical(conf.get('core')), coreFiles=core_files(),
                   tor=dict(enabled=(conf.get('core', {}).get('tor') or conf.get('tor') or {}).get('enabled'), hash=canonical(conf.get('core', {}).get('tor') or conf.get('tor'))[:16]),
                   dashmate=run(['dashmate', '--version'], user='dashmate', cwd='/home/dashmate').strip(),
                   platform=platform_containers(), images=dict(drive=conf['platform']['drive']['abci']['docker']['image'],
                   dapi=conf['platform']['dapi']['rsDapi']['docker']['image'], tenderdash=conf['platform']['drive']['tenderdash']['docker']['image']),
                   epochTime=conf['platform']['drive']['abci'].get('epochTime'),
                   anchor=conf['platform']['drive']['tenderdash']['genesis'].get('initial_core_chain_locked_height'))
    else:
        need(SEED_COMPOSE.exists(), f'{SEED_COMPOSE} missing')
        services = seed_services()
        need(services == ['tenderdash'], f'seed compose project must contain only tenderdash, has {services}')
        shutil.copy2(SEED_COMPOSE, backup / 'docker-compose.yml')
        shutil.copytree(SEED / 'tenderdash' / 'config', backup / 'tenderdash-config', symlinks=True)
        td = inspect('tenderdash') or next((x for x in containers() if 'tenderdash' in x['Config']['Image']), None)
        genesis = json.loads((SEED / 'tenderdash' / 'config' / 'genesis.json').read_text())
        out.update(dataDir=seed_dir_meta(), compose=sha(SEED_COMPOSE), tenderdashImage=td['Config']['Image'] if td else None,
                   genesisChainId=genesis.get('chain_id'), anchor=genesis.get('initial_core_chain_locked_height'),
                   nodeKey=sha(SEED / 'tenderdash' / 'config' / 'node_key.json'))
    save_json('baseline.json', out)
    return out


def stage_images():
    arch = {'aarch64': 'arm64', 'x86_64': 'amd64'}[os.uname().machine]
    pulled = {}
    for k, ref in Q['images'].items():
        if ROLE == 'seed' and k != 'tenderdash':
            continue
        run(['docker', 'pull', '--platform', f'linux/{arch}', ref], timeout=900)
        img = json.loads(run(['docker', 'image', 'inspect', ref]))[0]
        need(img['Architecture'] == arch, f'{ref} is {img["Architecture"]}, host is {arch}')
        pulled[k] = img['Id']
    return dict(arch=arch, images=pulled)


def anchor():
    cl = core_cli(core_container(), 'getbestchainlock')
    return dict(height=cl['height'], hash=cl['blockhash'])


def anchor_check():
    h = core_cli(core_container(), 'getblockheader', Q['anchorHash'])
    need(isinstance(h, dict) and h.get('height') == Q['anchorHeight'], 'anchor block unknown on this host')
    return dict(known=True, height=h['height'], confirmations=h.get('confirmations'))


def render_in_temp(apply_back=False):
    """dashmate set/render on a copy of the home; optionally write back only
    config.json, platform/* rendered templates and dynamic-compose.yml."""
    base = Path(tempfile.mkdtemp(prefix='dash-status-reset-', dir='/tmp'))
    try:
        return _render(base, apply_back)
    finally:
        shutil.rmtree(base, ignore_errors=True)


def _render(base, apply_back):
    home = base / '.dashmate'
    shutil.copytree(DM_HOME, home, symlinks=True)
    dm = pwd.getpwnam('dashmate')
    for p in [base, *base.rglob('*')]:
        os.lchown(p, dm.pw_uid, dm.pw_gid)
    os.chmod(base, 0o700)
    env = {'DASHMATE_HOME_DIR': str(home)}
    # Change only the intended fields of the preserved configuration; dashmate
    # validates the whole document against its schema when it loads it.
    doc = dm_config(home)
    before = json.loads(json.dumps(doc['configs'][CFG]))
    p = doc['configs'][CFG]['platform']
    p['drive']['abci']['docker']['image'] = Q['images']['drive']
    p['dapi']['rsDapi']['docker']['image'] = Q['images']['dapi']
    p['drive']['tenderdash']['docker']['image'] = Q['images']['tenderdash']
    p['drive']['tenderdash']['genesis']['initial_core_chain_locked_height'] = int(Q['anchorHeight'])
    p['drive']['abci']['epochTime'] = int(Q['epochSeconds'])
    (home / 'config.json').write_text(json.dumps(doc, indent=2))
    os.lchown(home / 'config.json', dm.pw_uid, dm.pw_gid)
    run(['dashmate', 'config', 'render', f'--config={CFG}'], user='dashmate', env=env, cwd='/home/dashmate', timeout=300)
    envs = run(['dashmate', 'config', 'envs', f'--config={CFG}'], user='dashmate', env=env, cwd='/home/dashmate', timeout=120)
    epoch_env = re.search(r'^PLATFORM_DRIVE_ABCI_EPOCH_TIME=(\S+)$', envs, re.M)
    after_cfg = dm_config(home)
    after = after_cfg['configs'][CFG]
    checks = dict(
        epochTime=after['platform']['drive']['abci'].get('epochTime'),
        epochEnv=epoch_env.group(1) if epoch_env else None,
        coreSectionUnchanged=canonical(before.get('core')) == canonical(after.get('core')),
        formatVersion=after_cfg.get('configFormatVersion'),
        images=dict(drive=after['platform']['drive']['abci']['docker']['image'], dapi=after['platform']['dapi']['rsDapi']['docker']['image'],
                    tenderdash=after['platform']['drive']['tenderdash']['docker']['image']),
        anchor=after['platform']['drive']['tenderdash']['genesis'].get('initial_core_chain_locked_height'),
    )
    need(checks['coreSectionUnchanged'], 'Core configuration changed during render')
    need(str(checks['epochTime']) == str(Q['epochSeconds']) and str(checks['epochEnv']) == str(Q['epochSeconds']), f"epoch config/env mismatch: {checks['epochTime']} / {checks['epochEnv']}")
    need(int(checks['anchor']) == int(Q['anchorHeight']), 'anchor not applied')
    # Node identity and chain identity are preserved: the rendered node key must
    # equal the live one and genesis may differ only in the anchor.
    td = Path(CFG) / 'platform' / 'drive' / 'tenderdash'
    live_key, new_key = [json.loads((root / td / 'node_key.json').read_text()) for root in (DM_HOME, home)]
    need(live_key == new_key, 'rendered Tenderdash node key differs from the live node key')
    live_g, new_g = [json.loads((root / td / 'genesis.json').read_text()) for root in (DM_HOME, home)]
    changed = sorted(k for k in set(live_g) | set(new_g) if k != 'initial_core_chain_locked_height' and live_g.get(k) != new_g.get(k))
    need(not changed, f'rendered genesis changes more than the anchor: {changed}')
    checks.update(nodeKeyUnchanged=True, genesisChainId=new_g.get('chain_id'), genesisOnlyAnchorChanged=True)
    rendered = []
    for tpl in sorted(Path('/usr/lib/dashmate/templates/platform').rglob('*.dot')):
        rel = Path('platform') / tpl.relative_to('/usr/lib/dashmate/templates/platform').with_suffix('')
        if (home / CFG / rel).exists():
            rendered.append(str(rel))
    if apply_back:
        core_before = core_files()
        shutil.copy2(home / 'config.json', DM_HOME / 'config.json')
        for rel in rendered + ['dynamic-compose.yml']:
            dst = DM_HOME / CFG / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(home / CFG / rel, dst)
            os.chown(dst, dm.pw_uid, dm.pw_gid)
        os.chown(DM_HOME / 'config.json', dm.pw_uid, dm.pw_gid)
        need(core_files() == core_before, 'core files changed while writing platform files')
    return dict(checks=checks, rendered=rendered + ['dynamic-compose.yml'])


def canary():
    need(ROLE == 'hpmn', 'canary runs on an HPMN')
    b = load_json('baseline.json')
    r = render_in_temp(apply_back=False)
    need(core_files() == b['coreFiles'], 'core files differ from baseline')
    return r


def preserved(b):
    c = core_container()
    ident = core_identity(c)
    need(ident['id'] == b['core']['id'] and ident['startedAt'] == b['core']['startedAt'], 'Core container was restarted or replaced')
    if ROLE == 'hpmn':
        need(core_files() == b['coreFiles'], 'Core/Tor files changed')
        need(canonical(dm_config()['configs'][CFG].get('core')) == b['coreSection'], 'Core configuration changed')
    return ident


def wipe():
    b = load_json('baseline.json')
    if ROLE == 'hpmn':
        run(['dashmate', 'reset', '--platform', '--force', f'--config={CFG}'], user='dashmate', cwd='/home/dashmate', timeout=900)
        left = platform_containers()
        need(not left, f'platform containers still present: {sorted(left)}')
        preserved(b)
        return dict(platformRemoved=True)
    need(seed_services() == ['tenderdash'], 'seed compose project changed')
    run(['docker', 'compose', '-f', str(SEED_COMPOSE), 'down'], timeout=300)
    meta = seed_dir_meta()
    need(meta == b['dataDir'], 'seed data directory ownership/mode changed since baseline')
    shutil.rmtree(SEED_DATA)
    SEED_DATA.mkdir()
    os.chown(SEED_DATA, b['dataDir']['uid'], b['dataDir']['gid'])
    os.chmod(SEED_DATA, int(b['dataDir']['mode'], 8))
    need(seed_dir_meta() == b['dataDir'], 'seed data directory not restored exactly')
    preserved(b)
    return dict(dataReset=True, dataDir=b['dataDir'])


def apply():
    b = load_json('baseline.json')
    if ROLE == 'hpmn':
        r = render_in_temp(apply_back=True)
        preserved(b)
        return r
    genesis_path = SEED / 'tenderdash' / 'config' / 'genesis.json'
    g = json.loads(genesis_path.read_text())
    g['initial_core_chain_locked_height'] = int(Q['anchorHeight'])
    tmp = genesis_path.with_name('.genesis.json.tmp')
    st = genesis_path.stat()
    tmp.write_text(json.dumps(g, indent=2))
    os.chown(tmp, st.st_uid, st.st_gid)
    os.chmod(tmp, st.st_mode & 0o7777)
    os.replace(tmp, genesis_path)
    compose = SEED_COMPOSE.read_text()
    new = re.sub(r'(^\s*image:\s*)(\S*tenderdash\S*)', lambda m: m.group(1) + Q['images']['tenderdash'], compose, count=1, flags=re.M)
    if new != compose:
        SEED_COMPOSE.write_text(new)
    need(sha(SEED / 'tenderdash' / 'config' / 'node_key.json') == b['nodeKey'], 'seed node identity changed')
    preserved(b)
    return dict(anchor=g['initial_core_chain_locked_height'], image=Q['images']['tenderdash'], composeChanged=new != compose)


def start():
    b = load_json('baseline.json')
    if ROLE == 'hpmn':
        run(['dashmate', 'start', '--platform', f'--config={CFG}'], user='dashmate', cwd='/home/dashmate', timeout=900)
    else:
        run(['docker', 'compose', '-f', str(SEED_COMPOSE), 'up', '-d', '--no-deps', 'tenderdash'], timeout=300)
    preserved(b)
    return dict(started=True)


def td_status(c, ports=(36657, 26657)):
    pid = str(c['State']['Pid'])
    for port in ports:
        try:
            v = json.loads(run(['nsenter', '-t', pid, '-n', 'curl', '-s', '--fail', '-m', '5', f'http://127.0.0.1:{port}/status'], timeout=10))
            return v.get('result', v)
        except Exception:
            continue
    return None


def verify():
    b = load_json('baseline.json')
    ident = preserved(b)
    c = core_container()
    info = core_cli(c, 'getblockchaininfo')
    sync = core_cli(c, 'mnsync', 'status')
    out = dict(core=dict(unchanged=True, id=ident['id'][:12], synced=bool(sync.get('IsSynced')), height=info['blocks']))
    if ROLE == 'seed':
        td = inspect('tenderdash') or next((x for x in containers() if 'tenderdash' in x['Config']['Image']), None)
        need(td and td['State']['Running'], 'seed tenderdash not running')
        out.update(tenderdash=dict(running=True, image=td['Config']['Image'], restarts=td.get('RestartCount', 0)))
        return out
    mn = core_cli(c, 'masternode', 'status')
    plat = platform_containers()
    running = {k: v for k, v in plat.items() if v['running']}
    want = {'drive_abci': Q['images']['drive'], 'rs_dapi': Q['images']['dapi'], 'drive_tenderdash': Q['images']['tenderdash']}
    wrong = {k: v['image'] for k, v in plat.items() if k in want and v['image'] != want[k]}
    tdc = inspect(f'dashmate_{CFG}-drive_tenderdash-1')
    st = td_status(tdc) if tdc else None
    si = (st or {}).get('sync_info') or {}
    drive = inspect(f'dashmate_{CFG}-drive_abci-1')
    env = dict(e.split('=', 1) for e in (drive or {}).get('Config', {}).get('Env', []) if '=' in e)
    parsed = None
    if drive:
        # Full output contains credentials: extract only the epoch field.
        raw = run(['docker', 'exec', drive['Id'], 'drive-abci', 'config'], check=False, timeout=60)
        m = re.search(r'epoch_time_length_s["\s:=]+(\d+)', raw)
        parsed = int(m.group(1)) if m else None
        del raw
    ip = Q['address']
    tls = run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '10', f'https://{ip}:1443/'], check=False, timeout=20).strip()
    cfg = dm_config()['configs'][CFG]
    out.update(
        masternode=mn.get('state'), platformRunning=len(running), platformTotal=len(plat), wrongImages=wrong,
        restarts={k: v['restarts'] for k, v in plat.items() if v['restarts']},
        consensus=dict(height=int(si.get('latest_block_height') or 0), catchingUp=si.get('catching_up')),
        epochs=dict(config=cfg['platform']['drive']['abci'].get('epochTime'), env=env.get('EPOCH_TIME_LENGTH_S'), parsed=parsed),
        dapiTls=tls,
    )
    problems = []
    if mn.get('state') != 'READY': problems.append(f"masternode {mn.get('state')}")
    expected = len(b.get('platform') or {}) or 7
    if len(running) < expected: problems.append(f'{len(running)}/{expected} platform containers running')
    if wrong: problems.append(f'unexpected images {wrong}')
    if out['consensus']['height'] <= 0 or out['consensus']['catchingUp'] is not False: problems.append(f"consensus height {out['consensus']['height']} catching_up={out['consensus']['catchingUp']}")
    e = out['epochs']
    if not (str(e['config']) == str(e['env']) == str(e['parsed']) == str(Q['epochSeconds'])): problems.append(f'epochs config/env/parsed = {e["config"]}/{e["env"]}/{e["parsed"]}')
    if tls != '405': problems.append(f'DAPI TLS root request returned {tls or "no response"}')
    out['problems'] = problems
    out['ok'] = not problems
    return out


STAGES = {'baseline': baseline, 'stage': stage_images, 'anchor': anchor, 'anchor-check': anchor_check, 'canary': canary,
          'wipe': wipe, 'apply': apply, 'start': start, 'verify': verify}
os.umask(0o077)
try:
    result = STAGES[STAGE]()
    print(json.dumps(dict(ok=result.get('ok', True) if isinstance(result, dict) else True, stage=STAGE, result=result)))
except Fail as e:
    print(json.dumps(dict(ok=False, stage=STAGE, error=str(e))))
except Exception as e:  # unexpected: report the type, never raw secret-bearing output
    print(json.dumps(dict(ok=False, stage=STAGE, error=f'{type(e).__name__}: {str(e)[:300]}')))
