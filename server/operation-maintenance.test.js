import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { operationMaintenance, OPERATION_LEASE_MS, OPERATION_SETTLE_MS } from './operation-maintenance.js';
import { cycle } from './incident-service.js';
import { loadIncidentState } from './incidents.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
const now=Date.now(), at=new Date(now).toISOString(), id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'operation-maintenance-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'ops'));mkdirSync(join(root,'incidents'));
  const settings={...structuredClone(DEFAULT_SETTINGS),networks:['sakura','other','mainnet'].map(name=>({...structuredClone(DEFAULT_SETTINGS.networks[name==='mainnet'?1:0]),name,displayName:name,tag:name,coreNetwork:name,chainType:name==='mainnet'?'mainnet':'devnet',kind:'dashnet'}))};
  writeFileSync(join(root,'settings.json'),JSON.stringify(settings));
  const op={id,network:'sakura',status:'running',confirmedAt:at,updatedAt:at,request:{action:'platform-reset'}};
  const save=()=>writeFileSync(join(root,'ops',id+'.json'),JSON.stringify(op));
  return {root,settings,op,save};
}
test('operation maintenance follows confirmed mutations only, ends on terminal state and expires abandoned records',t=>{
  const {root,settings,op,save}=fixture(t);
  for(const status of ['queued','preparing','review','failed','cancelled','interrupted']){
    op.status=status;save();assert.deepEqual(operationMaintenance(root,settings,now),{},status);
  }
  op.status='succeeded';op.finishedAt=at;save();
  assert.deepEqual(operationMaintenance(root,settings,now).sakura.operations.map(o=>o.status),['settling'],'a finished operation settles before its aftermath is queued');
  assert.deepEqual(operationMaintenance(root,settings,now+OPERATION_SETTLE_MS),{},'the settle window is bounded');
  delete op.finishedAt;
  for(const status of ['confirmed','running']){
    op.status=status;save();assert.deepEqual(Object.keys(operationMaintenance(root,settings,now)),['sakura']);
  }
  assert.deepEqual(operationMaintenance(root,settings,now+OPERATION_LEASE_MS),{},'stale activity does not silence alerts forever');
  op.updatedAt=new Date(now+24*3600_000).toISOString();save();
  assert.deepEqual(operationMaintenance(root,settings,now+24*3600_000),{},'absolute cap cannot be renewed forever');
  op.updatedAt=at;op.request.action='doctor';save();assert.deepEqual(operationMaintenance(root,settings,now),{});
  op.request.action='platform-reset';op.network='mainnet';save();assert.deepEqual(operationMaintenance(root,settings,now),{},'never suppress Mainnet');
});
test('an operation holds the faults of its network and no other scope; a failed one returns them as they are',async t=>{
  const {root,op,save}=fixture(t);
  const params={dataDir:root,ci:{summary:()=>({})}};
  await cycle({...params,now});
  const before=loadIncidentState(root), fault=before.issues.find(i=>i.scope==='sakura');
  assert.deepEqual([fault.status,fault.suppressed,fault.revision],['open',false,1]);
  save();
  await cycle({...params,now:now+60_000});
  const during=loadIncidentState(root), held=during.issues.find(i=>i.id===fault.id);
  assert.deepEqual([held.status,held.suppressed,held.revision],['open',true,1],'held, and not revised while it is');
  assert.deepEqual(Object.keys(during.maintenance),['sakura']);
  assert.ok(during.issues.filter(i=>i.scope==='other'||i.domain==='aws').every(i=>i.suppressed===false));
  assert.ok(during.issues.some(i=>i.scope==='other')&&during.issues.some(i=>i.domain==='aws'));
  op.status='failed';op.updatedAt=new Date(now+120_000).toISOString();save();
  await cycle({...params,now:now+120_000});
  const after=loadIncidentState(root), back=after.issues.find(i=>i.id===fault.id);
  assert.deepEqual(after.maintenance,{});
  assert.deepEqual([back.status,back.suppressed,back.revision],['open',false,2],'released from the hold: actionable again, one revision on; maintenance never falsely resolves faults');
});
