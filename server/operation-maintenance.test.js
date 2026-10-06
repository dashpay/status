import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { operationMaintenance, OPERATION_LEASE_MS } from './operation-maintenance.js';
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
  for(const status of ['queued','preparing','review','failed','cancelled','interrupted','succeeded']){
    op.status=status;save();assert.deepEqual(operationMaintenance(root,settings,now),{},status);
  }
  for(const status of ['confirmed','running']){
    op.status=status;save();assert.deepEqual(Object.keys(operationMaintenance(root,settings,now)),['sakura']);
  }
  assert.deepEqual(operationMaintenance(root,settings,now+OPERATION_LEASE_MS),{},'stale activity does not silence alerts forever');
  op.updatedAt=new Date(now+24*3600_000).toISOString();save();
  assert.deepEqual(operationMaintenance(root,settings,now+24*3600_000),{},'absolute cap cannot be renewed forever');
  op.updatedAt=at;op.request.action='doctor';save();assert.deepEqual(operationMaintenance(root,settings,now),{});
  op.request.action='platform-reset';op.network='mainnet';save();assert.deepEqual(operationMaintenance(root,settings,now),{},'never suppress Mainnet');
});
test('maintenance holds queued network delivery without starving other scopes; failure returns fresh faults to remediation',async t=>{
  const {root,op,save}=fixture(t);
  const params={dataDir:root,ci:{summary:()=>({})},destination:'https://receiver.example-tailnet.ts.net/v1/events',secret:'fixture'};
  await cycle({...params,now,fetcher:async()=>{throw Error('lost acknowledgement');}});
  const before=loadIncidentState(root), queued=before.outbox.find(e=>e.issue.scope==='sakura');
  assert.ok(queued);
  save();let sent;
  await cycle({...params,now:now+60_000,fetcher:async(_,options)=>{
    sent=JSON.parse(options.body).events;return Response.json({accepted:sent.map(e=>e.eventId)});
  }});
  assert.ok(!sent.some(e=>e.issue.domain==='network'&&e.issue.scope==='sakura'));
  assert.ok(sent.some(e=>e.issue.scope==='other'));
  assert.ok(sent.some(e=>e.issue.domain==='aws'));
  const during=loadIncidentState(root);
  assert.equal(during.issues.find(i=>i.id===queued.issue.id).suppressed,true);
  assert.deepEqual(during.outbox.find(e=>e.eventId===queued.eventId),queued,'durable event bytes are never rewritten');
  op.status='failed';op.updatedAt=new Date(now+120_000).toISOString();save();
  await cycle({...params,now:now+120_000,fetcher:async(_,options)=>{
    sent=JSON.parse(options.body).events;return Response.json({accepted:sent.map(e=>e.eventId)});
  }});
  const after=loadIncidentState(root);
  assert.deepEqual(after.maintenance,{});
  assert.ok(sent.some(e=>e.issue.scope==='sakura'&&e.issue.revision>queued.issue.revision),'fresh post-operation fault becomes actionable');
  assert.equal(after.issues.find(i=>i.id===queued.issue.id).status,'open','maintenance never falsely resolves faults');
});
