import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOperatorQueue, validateSelection } from './operator-queue.js';

test('node/component review binds actor, exact plan, expiry and idempotent dispatch', () => {
 const root = mkdtempSync(join(tmpdir(), 'status-queue-'));
 try {
  const n = { name: 'testnet', snapshot: join(root, 'snapshot.json') };
  writeFileSync(n.snapshot, JSON.stringify({ fleet: { metadata: { name: n.name }, targets: [{ name: 'mn-1', containers: { core: 'dashd' } }, { name: 'hp-1', containers: { core: 'core', dapi: 'dapi', drive: 'drive', tenderdash: 'td' } }] } }));
  const selection = { nodes: ['mn-1'], components: ['core'], images: { core: 'dashpay/dashd:23.1' } };
  assert.equal(validateSelection(n, 'upgrade', selection).nodes[0], 'mn-1');
  assert.equal(validateSelection(n, 'upgrade', { ...selection, images: { core: 'docker.io/dashpay/dashd:23.1' } }).images.core, 'docker.io/dashpay/dashd:23.1');
  for (const change of [{ nodes: ['foreign'] }, { nodes: ['mn-1','mn-1'] }, { components: ['dapi'] }, { images: { core: 'attacker/dashd:latest' } }, { images: { core: 'dashpay/dashd:23', dapi: 'dashpay/rs-dapi:4' } }]) assert.throws(() => validateSelection(n, 'upgrade', { ...selection, ...change }));
  const config = { operationsDir: join(root, 'operations'), workflow: { enabled: true } }, user = { id: 42, login: 'operator' };
  const queue = createOperatorQueue(config), draft = queue.prepare(n, 'upgrade', selection, user), planId = 'a'.repeat(64), requestId = randomUUID();
  assert.throws(() => queue.dispatch(n, 'upgrade', planId, requestId, user, draft.id), /prepared/);
  const file = join(config.operationsDir, 'drafts', draft.id+'.json');
  const ready = { ...draft, status: 'ready', preparedAt: new Date().toISOString(), review: { planId, targets: selection.nodes, changes: [{ node: 'mn-1', component: 'core' }] } };
  writeFileSync(file, JSON.stringify(ready));
  assert.throws(() => queue.draft(n, draft.id, { id: 99 }), /another/);
  assert.throws(() => queue.dispatch(n, 'upgrade', 'b'.repeat(64), requestId, user, draft.id), /Exact/);
  for (const preparedAt of ['bad-date', new Date(Date.now()-31*60_000).toISOString(), new Date(Date.now()+120_000).toISOString()]) {
   writeFileSync(file, JSON.stringify({ ...ready, preparedAt })); assert.throws(() => queue.dispatch(n, 'upgrade', planId, requestId, user, draft.id), /expired/);
  }
  writeFileSync(file, JSON.stringify(ready));
  const result = queue.dispatch(n, 'upgrade', planId, requestId, user, draft.id);
  assert.equal(result.status, 'queued'); assert.deepEqual(result.targets, ['mn-1']);
  const restarted = createOperatorQueue(config);
  assert.deepEqual(restarted.dispatch(n, 'upgrade', planId, requestId, user, draft.id), result);
  assert.throws(() => restarted.dispatch(n, 'upgrade', planId, randomUUID(), user, draft.id), /already active/);
  assert.throws(() => restarted.dispatch(n, 'upgrade', 'b'.repeat(64), requestId, user, draft.id), /another operation/);
  assert.equal(JSON.parse(readFileSync(join(config.operationsDir, requestId+'.json'))).draftId, draft.id);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resume retains the reviewed artifact and cannot bypass an unknown dispatch or another actor', () => {
 const root=mkdtempSync(join(tmpdir(),'queue-resume-'));
 try {
  const n={name:'testnet',snapshot:join(root,'snapshot.json')},user={id:42,login:'operator'};
  writeFileSync(n.snapshot,JSON.stringify({fleet:{metadata:{name:n.name},targets:[{name:'one',containers:{core:'core'}}]}}));
  const config={operationsDir:join(root,'ops'),workflow:{enabled:true}},q=createOperatorQueue(config);
  const d=q.prepare(n,'upgrade',{nodes:['one'],components:['core'],images:{core:'dashpay/dashd:23'}},user);
  const df=join(config.operationsDir,'drafts',d.id+'.json');writeFileSync(df,JSON.stringify({...d,status:'ready',preparedAt:new Date().toISOString(),review:{planId:'a'.repeat(64),targets:['one'],changes:[]}}));
  const op=q.dispatch(n,'upgrade','a'.repeat(64),randomUUID(),user,d.id);
  assert.throws(()=>q.resume(n,'upgrade',op.id,randomUUID(),user),/finished/);
  writeFileSync(join(config.operationsDir,op.id+'.json'),JSON.stringify({...op,status:'completed',conclusion:'failure'}));
  assert.throws(()=>q.resume(n,'upgrade',op.id,randomUUID(),{id:99}),/finished/);
  const id=randomUUID(),r=q.resume(n,'upgrade',op.id,id,user);
  assert.equal(r.planId,op.planId);assert.equal(r.draftId,d.id);assert.equal(r.resumeOf,op.id);
  assert.deepEqual(q.resume(n,'upgrade',op.id,id,user),r);
 }finally{rmSync(root,{recursive:true,force:true});}
});
