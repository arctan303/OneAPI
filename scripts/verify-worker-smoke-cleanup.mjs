import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile('scripts/verify-worker-live.mjs','utf8');
const originalFetch=globalThis.fetch, originalLog=console.log;
const fixtures=['cleanup_throw','cleanup_status','write_failure','wrong_service','http_origin','usage_unavailable'];
try {
 for(const mode of fixtures) {
  const calls=[], reports=[], prints=[];
  globalThis.__workerSmokeFixture={
   readFile:async path=>path.includes('jsonc')?JSON.stringify({vars:{PUBLIC_ORIGIN:mode==='http_origin'?'http://fixture.test':'https://fixture.test'}}):'ADMIN_API_KEY=fake-admin\n',
   writeFile:async(_path,body)=>{if(mode==='write_failure')throw new Error('fixture disk');reports.push(JSON.parse(body));}
  };
  globalThis.fetch=async(url,init={})=>{
   const path=new URL(url).pathname;const method=init.method??'GET';calls.push(method+' '+path);
   const headers=new Headers(init.headers);
   if(path==='/health')return Response.json({ok:true,service:mode==='wrong_service'?'unrelated-service':'oneapi-codex-gateway-demo'});
   if(path==='/admin/session'&&method==='POST')return Response.json({authenticated:true},{headers:{'set-cookie':'fake-session=fixture; HttpOnly'}});
   if(path==='/admin/status') {
    if(!headers.has('cookie')&&!headers.has('authorization'))return new Response('',{status:401});
    if(headers.get('authorization')==='Bearer fake-call-key')return new Response('',{status:mode==='usage_unavailable'?401:500}); // preserve original main failure outside usage fixture
    return Response.json({connected:mode==='usage_unavailable'});
   }
   if(path==='/admin/access')return Response.json({enabled:false});
   if(path==='/admin/usage')return Response.json({available:false,error:{code:'upstream_http_403'}});
   if(path==='/v1/models')return Response.json({data:[{id:'gpt-5.5'}]});
   if(path==='/admin/logs')return Response.json({data:[]});
   if(path==='/admin/api-keys'&&method==='POST')return headers.get('origin')==='https://foreign.example'?new Response('',{status:403}):Response.json({id:'fixture-id',key:'fake-call-key'},{status:201});
   if(method==='DELETE') {
    if(mode==='cleanup_throw')throw new Error('fixture network');
    if(mode==='cleanup_status')return new Response('',{status:503});
    return new Response(null,{status:204});
   }
   throw new Error('Unexpected fixture path');
  };
  console.log=x=>prints.push(JSON.parse(x));process.exitCode=0;
  let code=source.replace("import {readFile,writeFile} from 'node:fs/promises';","const {readFile,writeFile}=globalThis.__workerSmokeFixture;").replace("import OpenAI from 'openai';","class OpenAI { responses={create:async()=>({status:'completed',output_text:'fixture'})}; chat={completions:{create:async()=> (async function*(){yield {choices:[{delta:{content:'fixture'}}]};})()}}; }");
  const run=()=>import('data:text/javascript;base64,'+Buffer.from(code+'\n//'+mode).toString('base64'));
  if(mode==='http_origin') {await assert.rejects(run,/exact HTTPS origin/);assert.equal(calls.length,0);console.log=originalLog;originalLog(JSON.stringify({fixture:mode,passed:true,noCredentialSent:true}));continue;}
  await run();
  if(mode==='wrong_service') {assert.deepEqual(calls,['GET /health']);assert.equal(process.exitCode,1);console.log=originalLog;originalLog(JSON.stringify({fixture:mode,passed:true,noCredentialSent:true}));continue;}
  assert.equal(process.exitCode,1);
  assert.ok(calls.includes('DELETE /admin/api-keys/fixture-id'));
  assert.ok(calls.includes('DELETE /admin/session'));
  const report=prints.at(-1);
  if(mode==='usage_unavailable') {assert.equal(report.failure,undefined);assert.equal(report.usage.available,false);assert.equal(report.responses.completed,true);assert.equal(report.chat.completed,true);assert.equal(report.tempKeyRemoved,true);assert.equal(report.testSessionLoggedOut,true);console.log=originalLog;originalLog(JSON.stringify({fixture:mode,passed:true}));continue;}
  assert.equal(report.failure.name,'AssertionError');
  if(mode==='write_failure')assert.equal(report.reportWriteFailed,true);
  else {assert.equal(reports.length,1);assert.equal(report.cleanupErrors.length,2);}
  console.log=originalLog;originalLog(JSON.stringify({fixture:mode,passed:true}));
 }
 process.exitCode=0;
} finally {globalThis.fetch=originalFetch;console.log=originalLog;delete globalThis.__workerSmokeFixture;}
