import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReset, validateReset } from './reset.js';

test('dashnet reset is devnet-only and accepts Platform target versions but preserves Core and epoch', () => {
  const settings = { networks: [{ name: 'devnet-sakura', chainType: 'devnet', kind: 'dashnet' }, { name: 'mainnet', chainType: 'mainnet', kind: 'dashnet' }] };
  assert.equal(validateReset(settings, { network: 'devnet-sakura' }).epoch, null);
  assert.throws(() => validateReset(settings, { network: 'mainnet' }), /devnets/);
  assert.equal(validateReset(settings, { network: 'devnet-sakura', images: { drive: 'dashpay/drive:new' } }).images.drive, 'dashpay/drive:new');
  assert.throws(() => validateReset(settings, { network: 'devnet-sakura', images: { core: 'dashpay/dashd:23' } }), /invalid Platform/);
  assert.throws(() => validateReset(settings, { network: 'devnet-sakura', options: { epochSeconds: 1 } }), /preserves epoch/);
});

test('native reset binds every deployed validator, canaries all, excludes wallet, and refuses replacement hosts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-reset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { data:root, private: join(root, 'private'), state: join(root, 'state') };
  const name = 'devnet-sakura';
  const work = join(dirs.private, 'devnets', name);
  mkdirSync(work, { recursive: true }); mkdirSync(dirs.state);
  const hosts = ['validators-001', 'validators-002', 'wallet-001'].map((name, i) => ({ name, role: name.startsWith('wallet') ? 'wallet' : 'validator', instanceId: `i-${i}`, publicIp: `192.0.2.${i + 1}`, state: 'running', probe: { ok: true } }));
  const state = () => writeFileSync(join(dirs.state, `${name}.json`), JSON.stringify({ hosts }));
  state();
  writeFileSync(join(work, 'deployment.json'), JSON.stringify({ targets: hosts.map((h) => ({ ...h, sshAddress: h.publicIp })) }));
  const calls = [];
  let fail = null;
  const pool = { exec: async (host, cmd, script) => {
    const [, stage, encoded] = /python3 - (\S+) (\S+)/.exec(cmd);
    const q = JSON.parse(Buffer.from(encoded, 'base64'));
    assert.equal(q.node, host.name);
    assert.match(script, /class Reset:/);
    assert.equal(q.epochSeconds, null);
    assert.deepEqual(q.images, {});
    calls.push([stage, host.name]);
    return JSON.stringify({ ok: fail !== `${stage}:${host.name}`, result: {
      ...({ release: { sidecars:{} }, baseline: { images: { drive: 'installed@sha256:123' }, epochTime: 3600, height: 100, anchor: 10, dashmate: '5.0.0-beta.1', configFormatVersion: '5.0.0', tor: { enabled: true } }, anchor: { height: 99, hash: 'ab' }, canary: { checks: { coreSectionUnchanged: true }, rendered: [] } }[stage] || {}),
    } });
  } };
  const ctx = { step: () => () => {}, save: () => {}, write: () => {} };
  let begun = 0, committed = 0;
  const journalImpl = { prepare:async (r) => { r.nativeArchitectures = Object.fromEntries(hosts.map((h)=>[h.name,'arm64'])); r.nativeImages = Object.fromEntries(hosts.map((h)=>[h.name,{}])); return { targets:hosts }; }, original:()=>({deployment:{}}), seal:()=>{}, begin:async()=>{begun++;}, complete:async()=>{committed++;} };
  const reset = createReset({ ctx, dirs, pool, journalImpl, getSettings: () => ({ networks: [{ name, chainType: 'devnet', coreNetwork: name, kind: 'dashnet' }] }) });
  const record = () => ({ id: 'native-reset-test', network: name, request: { network: name, action: 'platform-reset' } });
  const r = record();
  await reset.prepareReset(r);
  assert.equal(r.review.native, true);
  assert.equal(r.review.epoch.next, 3600);
  assert.deepEqual(calls.filter(([s]) => s === 'canary').map(([, h]) => h), ['validators-001', 'validators-002']);
  assert.ok(!calls.some(([s]) => ['wipe','apply','start'].includes(s)));
  hosts[1].instanceId = 'i-replacement'; state();
  await assert.rejects(reset.executeReset(r), /targets changed/);
  await assert.rejects(reset.prepareReset(record()), /do not match/);
  hosts[1].instanceId = 'i-1'; state();
  fail = 'wipe:validators-002';
  await assert.rejects(reset.executeReset(r), /wipe failed/);
  assert.ok(!calls.some(([s]) => ['apply','start'].includes(s)));
  fail = null;
  await reset.executeReset(r);
  assert.equal(calls.filter(([s,h]) => s === 'wipe' && h === 'validators-001').length, 1);
  assert.ok(r.result.healthy);
  assert.equal(begun, 2); assert.equal(committed, 1);
  assert.ok(!calls.some(([s,h]) => h === 'wallet-001' && ['wipe','apply','start'].includes(s)));
});

test('release-required Core migration is reviewed, sequential, resumes and always restores mining', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-core-migration-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const dirs={data:root,private:join(root,'private'),state:join(root,'state')};
  const name='devnet-sakura', work=join(dirs.private,'devnets',name);
  mkdirSync(work,{recursive:true});mkdirSync(dirs.state);
  const hosts=['validators-001','validators-002','wallet-001'].map((name,i)=>({name,role:name.startsWith('wallet')?'wallet':'validator',instanceId:`i-${i}`,publicIp:`192.0.2.${i+1}`,sshAddress:`192.0.2.${i+1}`,state:'running',probe:{ok:true}}));
  writeFileSync(join(dirs.state,`${name}.json`),JSON.stringify({hosts}));
  writeFileSync(join(work,'deployment.json'),JSON.stringify({targets:hosts}));
  const calls=[];let fail='validators-002', begun=false, complete=false, mining=false;
  const pool={exec:async(h,cmd)=>{
    const [,stage,encoded]=/python3 - (\S+) (\S+)/.exec(cmd);
    const q=JSON.parse(Buffer.from(encoded,'base64'));
    calls.push([stage,h.name]);
    if(['wipe','core-migrate','apply'].includes(stage))assert.ok(begun);
    if(stage==='mining-pause'){assert.equal(q.role,'wallet');assert.equal(q.expectedMiner,'miner-id');mining=true;}
    if(stage==='mining-resume')mining=false;
    if(stage==='core-migrate')assert.ok(mining,'Core never restarts without quiet paused mining');
    const results={baseline:{images:{},epochTime:3600,anchor:1,height:100,tor:{}},anchor:{height:99,hash:'a'},release:{sidecars:{}},
      canary:{checks:{coreMigration:[{user:'drive_consensus',added:['getspecialtxes'],removed:[]}]},rendered:[]},
      'migration-ready':{minerId:'miner-id'},'mining-pause':{quiet:true,height:13},
      'core-migrate':{migrated:true,journal:{preservation:{coreId:'new-'+h.name,coreConfig:'migrated'}}},verify:{consensus:{height:5}}};
    return JSON.stringify({ok:!(stage==='core-migrate'&&h.name===fail),result:results[stage]||{}});
  }};
  const journalImpl={prepare:async(r)=>{r.nativeImages=Object.fromEntries(hosts.map(h=>[h.name,{}]));r.nativeArchitectures=Object.fromEntries(hosts.map(h=>[h.name,'arm64']));return {targets:hosts};},original:()=>({deployment:{}}),
    seal:(r)=>{r.nativeTransitions=Object.fromEntries(hosts.map(h=>[h.name,{preserve:{coreId:'old'}}]));},begin:async()=>{begun=true;},complete:async(r)=>{assert.equal(mining,false);assert.equal(r.nativeTransitions['validators-001'].preserve.coreConfig,'migrated');complete=true;}};
  const reset=createReset({dirs,pool,journalImpl,ctx:{step:()=>()=>{},save:()=>{},write:()=>{}},getSettings:()=>({networks:[{name,chainType:'devnet',kind:'dashnet',coreNetwork:name}]}),wait:async()=>{}});
  const r={id:'core-migration',network:name,request:{network:name,action:'platform-reset'}};
  await reset.prepareReset(r);
  assert.equal(r.review.coreMigrationMode,'parallel-v1');
  delete r.review.coreMigrationMode; // already-reviewed rolling plans keep their semantics
  assert.equal(r.review.coreMigrations['validators-001'][0].added[0],'getspecialtxes');
  assert.ok(!calls.some(([stage])=>['wipe','core-migrate','mining-pause'].includes(stage)),'prepare is non-destructive');
  await assert.rejects(reset.executeReset(r),/Core migration failed on validators-002/);
  assert.equal(mining,false,'failure always resumes mining');assert.equal(complete,false);
  assert.ok(!calls.some(([stage])=>['apply','start'].includes(stage)));
  fail=null;
  await reset.executeReset(r);
  assert.equal(complete,true);assert.equal(mining,false);
  assert.equal(calls.filter(([s,h])=>s==='core-migrate'&&h==='validators-001').length,1,'completed Core migration not repeated');
  assert.ok(calls.findIndex(([s])=>s==='apply')>calls.findLastIndex(([s])=>s==='core-migrate'));
});

test('reset-only parallel Core migration restarts all 13 before verification, retries failures and always resumes mining', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-core-migration-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const dirs={data:root,private:join(root,'private'),state:join(root,'state')};
  const name='devnet-sakura', work=join(dirs.private,'devnets',name);
  mkdirSync(work,{recursive:true});mkdirSync(dirs.state);
  const hosts=[...Array.from({length:13},(_,i)=>`validators-${String(i+1).padStart(3,'0')}`),'wallet-001'].map((name,i)=>({name,role:name.startsWith('wallet')?'wallet':'validator',instanceId:`i-${i}`,publicIp:`192.0.2.${i+1}`,sshAddress:`192.0.2.${i+1}`,state:'running',probe:{ok:true}}));
  writeFileSync(join(dirs.state,`${name}.json`),JSON.stringify({hosts}));
  writeFileSync(join(work,'deployment.json'),JSON.stringify({targets:hosts}));
  const calls=[];let fail='validators-013', failStage='core-restart', begun=false, complete=false, mining=false;
  let restarting=0, peak=0; const restarted=new Set();
  const pool={exec:async(h,cmd)=>{
    const [,stage,encoded]=/python3 - (\S+) (\S+)/.exec(cmd);
    const q=JSON.parse(Buffer.from(encoded,'base64'));
    calls.push([stage,h.name]);
    if(['wipe','core-restart','core-verify','apply'].includes(stage))assert.ok(begun);
    if(stage==='mining-pause'){assert.equal(q.role,'wallet');assert.equal(q.expectedMiner,'miner-id');mining=true;}
    if(stage==='mining-resume')mining=false;
    if(['core-restart','core-ready'].includes(stage))assert.ok(mining,'Core migration always uses paused mining');
    if(stage==='core-restart'){
      restarting++; peak=Math.max(peak,restarting);
      await new Promise(resolve=>setImmediate(resolve));
      restarting--; if(h.name!==fail||failStage!==stage)restarted.add(h.name);
    }
    if(stage==='core-verify'){assert.equal(restarted.size,13,'verification waits for the entire fleet to restart');assert.equal(mining,false,'quorum convergence is checked after mining resumes');}
    const results={baseline:{images:{},epochTime:3600,anchor:1,height:100,tor:{}},anchor:{height:99,hash:'a'},release:{sidecars:{}},
      canary:{checks:{coreMigration:[{user:'drive_consensus',added:['getspecialtxes'],removed:[]}]},rendered:[]},
      'migration-ready':{minerId:'miner-id'},'mining-pause':{quiet:true,height:13},
      'core-verify':{migrated:true,journal:{preservation:{coreId:'new-'+h.name,coreConfig:'migrated'}}},verify:{consensus:{height:5}}};
    return JSON.stringify({ok:!(stage===failStage&&h.name===fail),result:results[stage]||{}});
  }};
  const journalImpl={prepare:async(r)=>{r.nativeImages=Object.fromEntries(hosts.map(h=>[h.name,{}]));r.nativeArchitectures=Object.fromEntries(hosts.map(h=>[h.name,'arm64']));return {targets:hosts};},original:()=>({deployment:{}}),
    seal:(r)=>{r.nativeTransitions=Object.fromEntries(hosts.map(h=>[h.name,{preserve:{coreId:'old'}}]));},begin:async()=>{begun=true;},complete:async(r)=>{assert.equal(mining,false);assert.equal(r.nativeTransitions['validators-001'].preserve.coreConfig,'migrated');complete=true;}};
  const reset=createReset({dirs,pool,journalImpl,ctx:{step:()=>()=>{},save:()=>{},write:()=>{}},getSettings:()=>({networks:[{name,chainType:'devnet',kind:'dashnet',coreNetwork:name}]}),wait:async()=>{}});
  const r={id:'core-migration',network:name,request:{network:name,action:'platform-reset'}};
  await reset.prepareReset(r);
  assert.equal(r.review.coreMigrationMode,'parallel-v1');
  assert.equal(r.review.coreMigrations['validators-001'][0].added[0],'getspecialtxes');
  assert.ok(!calls.some(([stage])=>['wipe','core-migrate','mining-pause'].includes(stage)),'prepare is non-destructive');
  await assert.rejects(reset.executeReset(r),/core-restart failed on validators-013/);
  assert.equal(mining,false,'failure always resumes mining');assert.equal(complete,false);
  assert.ok(!calls.some(([stage])=>['apply','start'].includes(stage)));
  assert.equal(peak,13,'all Sakura validators restart concurrently, not serially');
  assert.ok(!calls.some(([s])=>s==='core-verify'),'failed restart is a fleet barrier');
  failStage='core-verify';
  await assert.rejects(reset.executeReset(r),/core-verify failed on validators-013/);
  assert.equal(mining,false);
  assert.ok(!calls.some(([s])=>s==='apply'));
  fail=null;
  await reset.executeReset(r);
  assert.equal(complete,true);assert.equal(mining,false);
  assert.equal(calls.filter(([s,h])=>s==='core-restart'&&h==='validators-001').length,1,'completed Core migration not repeated');
  assert.equal(calls.filter(([s,h])=>s==='core-verify'&&h==='validators-001').length,1,'completed verification receipt is reused');
  assert.ok(!calls.some(([s,h])=>h==='wallet-001'&&['core-restart','core-verify'].includes(s)));
  assert.ok(calls.findIndex(([s])=>s==='apply')>calls.findLastIndex(([s])=>s==='core-verify'));
});
