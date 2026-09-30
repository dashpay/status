import test from 'node:test';
import assert from 'node:assert/strict';
import { observe } from '../agent/trends.js';
import { convergence, expectations, monitoringSummary } from './monitoring.js';
import { evaluateNetwork, projectNetwork } from './evaluate.js';
import { DEFAULT_SETTINGS } from './settings.js';

const now = Date.parse('2026-09-30T08:00:00Z');
const host = (at, core = 100, platform = 50) => ({ name: 'hp-1', instanceId: 'i-1', state: 'running', role: 'validator', probe: { at: new Date(at).toISOString(), ok: true,
  data: { core: { chain: 'test', blocks: core, headers: core, ibd: false, chainLockHeight: core, masternode: { state: 'READY', lastPaidHeight: core } },
    tenderdash: { height: platform, catchingUp: false, network: 'dash-testnet-51', thresholdSigned: true }, dapi: { ok: true, query: { ok: true, latencyMs: 5 } }, containers: [] } } });

test('progress survives collector restarts, is chain-specific and resets after gaps/replacement/sync', () => {
  let previous;
  for (let t=0;t<=1860_000;t+=60_000) previous = { hosts: observe([host(now+t,100,50+t/60_000)],previous,now+t) };
  let h=previous.hosts[0];
  assert.equal(h.observation.core.stalledSeconds,1860);
  assert.equal(h.observation.platform.stalledSeconds,0);
  assert.ok(h.observation.samples.length<=120);
  assert.equal(observe([host(now+2200_000)],previous,now+2200_000)[0].observation.core.stalledSeconds,null);
  h=host(now+1920_000); h.instanceId='i-new';
  assert.equal(observe([h],previous,now+1920_000)[0].observation.continuous,false);
  h=host(now+1920_000); h.probe.data.core.ibd=true;
  assert.equal(observe([h],previous,now+1920_000)[0].observation.core.stalledSeconds,null);
  h=host(now+1920_000); h.probe.ok=false;
  assert.equal(observe([h],previous,now+1920_000)[0].observation.samples.length,0);
});

test('only confirmed executed changes establish image intent; active rollout is distinct from drift', () => {
  const op={createdAt:new Date(now).toISOString(), updatedAt:new Date(now).toISOString(),status:'review',review:{changes:[{node:'hp-1',component:'core',from:'dashpay/dashd:23',to:'dashpay/dashd@sha256:abc'}]}};
  assert.deepEqual(expectations([op],now),{});
  op.confirmedAt=new Date(now).toISOString(); op.progress={};op.status='running';
  const pins=expectations([op],now), h=host(now+1000), c={repo:'dashpay/dashd',image:'dashpay/dashd:23',running:true};
  const check=()=>convergence(h,{containers:[c]}, {},pins,{'dashpay/dashd':'core'})[0];
  assert.equal(check().status,'rolling');
  c.image='dashpay/dashd:unknown'; assert.equal(check().status,'drift');
  c.digest='sha256:abc'; assert.equal(check().status,'matched');
  assert.equal(convergence(h,{containers:[]},{},pins,{'dashpay/dashd':'core'})[0].status,'rolling');
  op.status='succeeded';op.finishedAt=new Date(now+2000).toISOString();
  assert.equal(convergence(h,{containers:[{...c,digest:null}]},{},expectations([op],now+3000),{'dashpay/dashd':'core'})[0].status,'awaiting-sample');
});

test('missing/idle evidence never counts as success, stale payouts never prove InstantSend', () => {
  const h=host(now); h.probe.data.dapi.query=null;
  h.probe.data.faucet={payouts:[{time:now/1000-90000,instantlock:true,confirmations:100}]};
  h.probe.data.services=[{service:'prometheus',ok:null,reason:'authentication required'}];
  const m=monitoringSummary([{host:h,data:h.probe.data}],[],now);
  assert.deepEqual(m.dapi.queries,{observed:0,total:1,failed:0});
  assert.equal(m.quorum.observedPayouts,0);
  assert.deepEqual(m.services.checks,{observed:0,total:1,failed:0});
});

test('real query failures and mismatched endpoints affect status while rotating membership does not', () => {
  const network=DEFAULT_SETTINGS.networks[0]; const h=host(now);
  h.probe.data.tenderdash.inValidatorSet=false;
  assert.equal(evaluateNetwork(network,{hosts:[h]},DEFAULT_SETTINGS,now).level,'ok');
  h.probe.data.dapi.query.ok=false;
  assert.equal(evaluateNetwork(network,{hosts:[h]},DEFAULT_SETTINGS,now).level,'down');
  h.probe.data.dapi.query.ok=true;
  const e=evaluateNetwork(network,{hosts:[h],endpoints:[{kind:'dapi',ok:true,height:50,chainId:'wrong'},{kind:'dapi',ok:true,height:50,chainId:'right'}]},DEFAULT_SETTINGS,now);
  assert.equal(e.level,'warn');
  const state={hosts:[h]}; h.observation={samples:[{restarts:{private:'value'}}],continuous:true};
  const pub=projectNetwork(network,e,state,false);
  assert.equal(pub.hosts[0].observation.samples,undefined);
  assert.equal(pub.hosts[0].instanceId,undefined);
});

test('sync completion cannot inherit time stalled during initial sync; stale observations cannot stay green', () => {
  let previous;
  for (let t=0;t<=1860_000;t+=60_000) { const h=host(now+t); h.probe.data.core.ibd=true; previous={hosts:observe([h],previous,now+t)}; }
  assert.equal(observe([host(now+1920_000)],previous,now+1920_000)[0].observation.core.stalledSeconds,null);
  const e=evaluateNetwork(DEFAULT_SETTINGS.networks[0],{hosts:[host(now)]},DEFAULT_SETTINGS,now+240_000);
  assert.equal(e.rows[0].level,'unreachable');
  assert.equal(e.summary.monitoring.dapi.queries.observed,0);
});
