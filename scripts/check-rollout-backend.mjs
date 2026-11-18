// Run inside the candidate image, before promotion. No credentials or network required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root=process.argv[2] || '/app';
const { rolloutFor,rolloutArgs,reviewedRollout }=await import(pathToFileURL(`${root}/shared/rollout.js`));
const { validateRequest }=await import(pathToFileURL(`${root}/agent/ops.js`));
const { DEFAULT_SETTINGS }=await import(pathToFileURL(`${root}/shared/settings.js`));
const request={id:'6c8139ad-e92f-40da-943d-1e001efaccb5',network:'testnet',action:'upgrade',nodes:['masternode-11','masternode-12','masternode-13'],components:['core'],images:{core:'dashpay/dashd:24.0.2'},options:{concurrency:3,pauseMining:false}};
assert.equal(validateRequest(DEFAULT_SETTINGS,request).rollout.concurrency,3);
const policy=rolloutFor(request);assert.deepEqual(rolloutArgs(policy),['--concurrency','3']);
assert.throws(()=>reviewedRollout({},policy,[]),/did not bind/);
assert.equal(reviewedRollout({rollout:{concurrency:3}},policy,[]).concurrency,3);
for(const command of ['managed-plan','upgrade-plan']){
 const p=spawnSync(process.env.DASHNET_BINARY || 'dashnet',[command,'--help'],{encoding:'utf8'});
 assert.equal(p.status,0,`${command}: ${p.error || p.stderr}`);
 assert.match(p.stdout+p.stderr,/-concurrency\b/,`${command} missing concurrency`);
 assert.match(p.stdout+p.stderr,/-pause-mining\b/,`${command} missing mining controls`);
}
console.log('rollout backend capability gate passed');
