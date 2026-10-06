import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResetJournal, candidateYaml, transitionRecord } from './reset-journal.js';
import { resetSidecars } from './reset-images.js';
const pin = (repo, char='a') => `index.docker.io/dashpay/${repo}@sha256:${char.repeat(64)}`;
const beforeImages = {core:pin('dashd'), drive:pin('drive'), dapi:pin('rs-dapi'), tenderdash:pin('tenderdash'), gateway:pin('envoy'), helper:pin('dashmate-helper')};
const preservation = { coreId:'a'.repeat(64),coreStarted:'2026-10-06T00:00:00Z',coreConfig:'b'.repeat(64),coreGenesis:'c'.repeat(64),containers:Object.fromEntries(['drive','dapi','gateway','tenderdash'].map((c)=>[c,'d'.repeat(64)])),restarts:{drive:0,dapi:0,gateway:0,tenderdash:0} };
const plan = {id:'d'.repeat(64),profile:'devnet-dashmate-compose',bootstrap:{compute:{id:'e'.repeat(64),network:{metadata:{name:'devnet-test'},aws:{region:'us-west-2',accountId:'123456789012',provision:{stateTable:'networks'}}}}},targets:[{name:'validator-1',role:'validator',architecture:'arm64',images:Object.entries(beforeImages).map(([component,pinned])=>({component,pinned}))},{name:'wallet-1',role:'wallet',architecture:'amd64',images:['core','helper'].map((component)=>({component,pinned:beforeImages[component]}))}]};
const observed = Object.fromEntries(plan.targets.map((t)=>[t.name,{ images:Object.fromEntries([...t.images].reverse().map((i)=>[i.component,i.pinned])),previousId:'',preservation }]));
const original = {revision:4,deployment:{planId:plan.id,phase:'network-ready',sidecars:[],genesisCoreHeight:100}};
function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'reset-journal-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dirs={data:root,private:join(root,'private')}, work=join(dirs.private,'devnets','devnet-test');mkdirSync(work,{recursive:true});
  writeFileSync(join(work,'deployment.json'),JSON.stringify(plan));
  writeFileSync(join(work,'network.yaml'),'images:\n'+Object.entries(beforeImages).map(([c,v])=>`  ${c}: ${v}`).join('\n')+'\n');
  let item={PlanID:{S:plan.bootstrap.compute.id},Revision:{N:'4'},Data:{S:JSON.stringify(original)}};
  let lost=false;
  const requests=[];
  const client={send:async (command)=>{
    const q=command.input; requests.push(q);
    if(command.constructor.name==='DescribeTableCommand') return {Table:{TableStatus:'ACTIVE',TableArn:'arn:aws:dynamodb:us-west-2:123456789012:table/networks',KeySchema:[{AttributeName:'Network',KeyType:'HASH'}]}};
    if(command.constructor.name==='GetItemCommand') { assert.equal(q.ConsistentRead,true);return {Item:structuredClone(item)}; }
    const v=q.ExpressionAttributeValues;
    const reject=()=>{throw Error('ConditionalCheckFailedException');};
    if(q.UpdateExpression==='SET #owner = :owner') {
      if(item.Owner || item.PlanID.S!==v[':plan'].S || item.Revision.N!==v[':rev'].N || item.Data.S!==v[':data'].S) reject();
      item.Owner=v[':owner'];
    } else if(q.UpdateExpression.startsWith('SET #data')) {
      if(item.Owner?.S!==v[':owner'].S || item.PlanID.S!==v[':plan'].S || !((item.Revision.N===v[':previous'].N && item.Data.S===v[':before'].S)||(item.Revision.N===v[':next'].N&&item.Data.S===v[':data'].S)))reject();
      item.Data=v[':data'];item.Revision=v[':next'];
      if(lost){lost=false;throw Error('lost ACK');}
    } else {
      if(item.Owner?.S!==v[':owner'].S || item.Revision.N!==v[':rev'].N)reject();
      delete item.Owner;
    }
    return {};
  }};
  const ctx={dashnet:async (_r,args)=>{
    const file=args[args.indexOf('--out')+1];
    writeFileSync(file,JSON.stringify({images:['drive','helper'].map((component)=>({component,pinned:pin(component==='helper'?'dashmate-helper':'drive','b'),platforms:[{architecture:'arm64',os:'linux',digest:'sha256:'+'b'.repeat(64)}]}))}),{flag:'wx'});return 0;
  }};
  const journal=createResetJournal({dirs,ctx,client}), r={id:'test-op',network:'devnet-test',anchor:{height:123}};
  return {journal,r,root,work,requests,item:()=>item,lost:()=>{lost=true;}};
}
test('candidate limits edits to Platform and uses strict registry refs',()=>{
  assert.equal(candidateYaml('images:\n  drive: docker.io/dashpay/drive:old\n',{drive:'dashpay/drive:new'}),'images:\n  drive: docker.io/dashpay/drive:new\n');
  assert.throws(()=>candidateYaml('images:\n  core: old\n',{core:'new'}),/outside/);
});
test('preparation pins target release and matching helper but leaves wallet and journal untouched',async(t)=>{
  const {journal,r,item,requests}=setup(t);
  await journal.prepare(r,{drive:'dashpay/drive:new'});
  assert.equal(item().Revision.N,'4');assert.equal(item().Owner,undefined);
  assert.equal(r.nativeImages['validator-1'].helper,pin('dashmate-helper','b'));
  journal.seal(r,observed,[]);
  assert.equal(r.nativeTransitions['wallet-1'].to.helper,beforeImages.helper);
  assert.ok(!requests.some((q)=>q.UpdateExpression));
});
test('stale journal cannot be claimed; failed/lost ACK execution retains owner and resumes exact transition',async(t)=>{
  const {journal,r,item,lost,work}=setup(t);
  await journal.prepare(r,{drive:'dashpay/drive:new'});journal.seal(r,observed,[]);
  item().Revision.N='5';
  await assert.rejects(journal.begin(r),/revision/);assert.equal(item().Owner,undefined);
  item().Revision.N='4';lost();
  await assert.rejects(journal.begin(r),/lost ACK/);
  assert.equal(item().Owner.S,'status-reset-test-op');
  assert.equal(JSON.parse(item().Data.S).upgrade.phase,'applying');
  await journal.begin(r);
  r.stages = {'core-migrate': {'validator-1': {ok:true,result:{journal:{preservation:{...preservation,coreId:'f'.repeat(64),coreConfig:'e'.repeat(64)}}}}}};
  lost();await assert.rejects(journal.complete(r),/lost ACK/);
  assert.ok(item().Owner,'claim kept until local receipts are durable');
  await journal.begin(r);await journal.complete(r);
  const record=JSON.parse(item().Data.S);
  assert.equal(record.upgrade.phase,'complete');assert.equal(record.deployment.genesisCoreHeight,123);
  assert.equal(record.runtime.images['validator-1'].drive,pin('drive','b'));
  assert.equal(record.upgrade.baseline['validator-1'].coreId,'f'.repeat(64),'verified Core migration updates future native preservation evidence');
  assert.equal(record.upgrade.baseline['wallet-1'].coreId,preservation.coreId);
  assert.equal(record.runtime.images['wallet-1'].helper,beforeImages.helper);
  assert.equal(item().Owner,undefined);
  assert.match(readFileSync(join(work,'network-current.yaml'),'utf8'),/drive@sha256:bbbb/);
  await journal.complete(r); // release ACK loss is also idempotent
});
test('journal construction rejects installed drift and Core target changes',()=>{
  const desired=Object.fromEntries(plan.targets.map((t)=>[t.name,Object.fromEntries(t.images.map((i)=>[i.component,i.pinned]))]));
  assert.throws(()=>transitionRecord(original,plan,'f'.repeat(64),desired,{...observed,'validator-1':{...observed['validator-1'],images:{}}},'2026-10-06T00:00:00Z'),/installed images/);
  desired['validator-1'].core=pin('dashd','b');
  assert.throws(()=>transitionRecord(original,plan,'f'.repeat(64),desired,observed,'2026-10-06T00:00:00Z'),/Core/);
});
test('unchanged sidecars keep pins; target helper cannot replace Tor',async()=>{
  const existing=[{service:'core_tor',requested:'tor:old',pinned:'old'},{service:'gateway_rate_limiter_redis',requested:'redis:alpine',pinned:'retained'}];
  const result=await resetSidecars(existing,{core_tor:'tor:old',gateway_rate_limiter_redis:'redis:alpine'},['amd64','arm64'],()=>{throw Error('must not resolve moving tags');});
  assert.deepEqual(result,existing);
  await assert.rejects(resetSidecars(existing,{core_tor:'tor:new'},['arm64']),/preserved Core/);
});

test('prepare again preserves previous immutable artifacts and resume uses the saved attempt',async(t)=>{
  const {journal,r,root,item}=setup(t);
  await journal.prepare(r,{drive:'dashpay/drive:old-choice'});
  const first=join(root,'private','resets',r.id,'candidate-lock.json');
  const before=readFileSync(first,'utf8');
  r.execId=r.id+'.12345';
  await journal.prepare(r,{drive:'dashpay/drive:new-choice'});
  assert.equal(readFileSync(first,'utf8'),before);
  assert.equal(r.nativeJournalExec,r.execId);
  assert.match(readFileSync(join(root,'private','resets',r.execId,'candidate.yaml'),'utf8'),/new-choice/);
  journal.seal(r,observed,[]);
  await journal.begin(r);
  await journal.begin(r);
  assert.equal(JSON.parse(item().Data.S).upgrade.planId,r.nativePlanId);
});
