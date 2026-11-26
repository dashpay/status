// Production smoke gate: HTTP health alone does not prove retained console features.
import assert from 'node:assert/strict';
const origin=process.argv[2];assert.ok(origin,'Usage: node scripts/check-console-features.mjs <origin>');
for(const path of ['/api/remediation','/api/websites','/api/ci/queue','/api/hooks']){
 const r=await fetch(origin+path,{signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,200,`${path}: console capability missing`);
 assert.match(r.headers.get('content-type')||'',/application\/json/);await r.json();
}
const html=await (await fetch(origin,{signal:AbortSignal.timeout(15000)})).text();
const scripts=[...html.matchAll(/src="(\/assets\/[^"\s]+\.js)"/g)].map(m=>m[1]);assert.ok(scripts.length);
const bundles=await Promise.all(scripts.map(async p=>{const r=await fetch(origin+p,{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200,p);return r.text()}));
for(const feature of ['/remediation','/websites','/webhooks','Functional monitoring'])assert.ok(bundles.some(s=>s.includes(feature)),`frontend missing ${feature}`);
console.log(JSON.stringify({remediation:'passed',websiteMonitoring:'passed',ciQueue:'passed',frontendFeatures:'passed',webhooks:'passed'}));
