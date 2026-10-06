import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileExplorer } from './explorer.js';

test('Explorer worker binds wallet ownership, chain and confirmed anchor; errors cannot complete a reset', async () => {
  const calls=[];
  const pool={exec:async(host,cmd,script,timeout)=>{
    calls.push({host,q:JSON.parse(Buffer.from(cmd.split(' ').at(-1),'base64')),script,timeout});
    return JSON.stringify({ok:true,result:{installed:true,indexed:9,chain:9}});
  }};
  const target={name:'wallet-001',instanceId:'i-owned',sshAddress:'192.0.2.1',role:'wallet'};
  const args={pool,target,network:'devnet-x',chain:'dash-devnet-x',anchor:99};
  await reconcileExplorer({...args,checkOnly:true});
  const result=await reconcileExplorer(args);
  assert.equal(result.indexed,9);
  assert.equal(calls[0].q.checkOnly,true);
  assert.deepEqual(calls[1].q,{auxiliary:'devnet-x/wallet-001',chain:'dash-devnet-x',anchor:99,checkOnly:false});
  assert.equal(calls[1].host.instanceId,'i-owned');
  assert.match(calls[1].script,/class Explorer:/);
  pool.exec=async()=>JSON.stringify({ok:false,error:'index not caught up'});
  await assert.rejects(reconcileExplorer(args),/index not caught up/);
});
