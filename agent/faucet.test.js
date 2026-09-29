// Faucet funding in agent/services-remote.py, run against a scripted wallet.
// The script configures a wallet host at import, so only the funding
// functions are extracted (ast) and executed with a fake Core RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./services-remote.py', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;

const HARNESS = `
import ast, json, sys
path, scenario = sys.argv[1], json.loads(sys.argv[2])
tree = ast.parse(open(path).read())
names = {'fund_faucet', 'faucet_wallet', 'MAX_INPUTS', 'FEE_PER_KB'}
keep = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in names)
        or (isinstance(n, ast.Assign) and any(getattr(t, 'id', None) in names for t in n.targets))]
calls, logs, state = [], [], dict(pending=scenario['pending'], tx=None, n=0)
def rpc(method, params=None, wallet=None):
    calls.append(method)
    if method == 'listwallets': return ['dashnet', 'faucet']
    if method == 'getbalances': return dict(mine=dict(trusted=scenario['trusted'], untrusted_pending=state['pending']))
    if method == 'getbalance': return sum(scenario['coins'])
    if method == 'listunspent': return [dict(txid='%064x' % i, vout=0, amount=a, spendable=True, safe=True) for i, a in enumerate(scenario['coins'])]
    if method in ('getnewaddress', 'getrawchangeaddress'):
        state['n'] += 1
        return ('yC' if method == 'getrawchangeaddress' else 'yF') + str(state['n'])
    if method == 'createrawtransaction':
        state['tx'] = dict(inputs=len(params[0]), outputs=params[1]); return 'raw'
    if method == 'signrawtransactionwithwallet': return dict(hex='signed', complete=True)
    if method == 'sendrawtransaction':
        if scenario.get('failSend'): raise RuntimeError('sendrawtransaction: min relay fee not met')
        state['pending'] += sum(v for k, v in state['tx']['outputs'].items() if k.startswith('yF')); return 'f' * 64
    raise AssertionError(method)
ns = dict(rpc=rpc, cfg=dict(faucetFunding=50000), log=logs.append)
exec(compile(ast.Module(body=keep, type_ignores=[]), path, 'exec'), ns)
balance = ns['faucet_wallet']()
tx = state['tx']
print(json.dumps(dict(balance=balance, calls=calls, logs=logs, tx=tx and dict(
    inputs=tx['inputs'], faucetOutputs=[v for k, v in tx['outputs'].items() if k.startswith('yF')],
    change=sum(v for k, v in tx['outputs'].items() if k.startswith('yC'))))))
`;
const run = (scenario) => {
  const p = spawnSync('python3', ['-c', HARNESS, SCRIPT, JSON.stringify({ trusted: 0, pending: 0, ...scenario })], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
};
const repeat = (n, v) => Array(n).fill(v);
// devnet-bonsia's miner wallet on 2026-09-29: a few large early rewards, thousands of small ones.
const bonsia = [...repeat(10, 462.5), ...repeat(212, 359.375), ...repeat(2585, 3.59375)];

test('funding still confirming counts: a second run never funds again', { skip: !python && 'python3 not installed' }, () => {
  const r = run({ pending: 50000, coins: bonsia });
  assert.equal(r.balance, 50000);
  assert.ok(!r.calls.includes('createrawtransaction'));
});

test('funding picks the largest coins, capped well inside the transaction size limit', { skip: !python && 'python3 not installed' }, () => {
  const r = run({ coins: bonsia });
  assert.ok(r.tx.inputs < 150, `used ${r.tx.inputs} inputs`);
  assert.equal(r.tx.faucetOutputs.length, 50);
  assert.ok(r.tx.faucetOutputs.every((v) => v === 1000));
  assert.ok(r.tx.change > 0 && r.tx.change < 360);
  assert.equal(r.balance, 50000);
});

test('only small coins: the input cap bounds the transaction and the amount', { skip: !python && 'python3 not installed' }, () => {
  const r = run({ coins: repeat(5000, 3.59375) });
  assert.equal(r.tx.inputs, 400);
  const paid = r.tx.faucetOutputs.reduce((a, b) => a + b, 0);
  assert.ok(paid > 1400 && paid < 400 * 3.59375, `paid ${paid}`);
  assert.ok(10 + 148 * r.tx.inputs + 34 * 22 < 100_000, 'standard size');
});

test('a failed funding is deferred to the top-up, not fatal', { skip: !python && 'python3 not installed' }, () => {
  const r = run({ coins: bonsia, failSend: true });
  assert.equal(r.balance, 0);
  assert.match(r.logs.join('\n'), /faucet funding deferred: sendrawtransaction/);
  const dust = run({ coins: repeat(10, 3) });
  assert.equal(dust.tx, null);
  assert.match(dust.logs.join('\n'), /deferred/);
});
