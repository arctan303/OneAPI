// Bounded live smoke: one model list, one usage read, at most two generations, SDK retries disabled.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import OpenAI from 'openai';
const config=JSON.parse(await readFile('wrangler.worker.jsonc','utf8'));
const origin=config.vars.PUBLIC_ORIGIN;
if(typeof origin!=='string'||new URL(origin).origin!==origin||!origin.startsWith('https://'))throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin');
const adminOnly=process.argv.includes('--admin-only');
const secrets=Object.fromEntries((await readFile('.dev.vars.worker','utf8')).split(/\r?\n/).filter(x=>/^[A-Z_]+=/.test(x)).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
const adminHeaders={Authorization:`Bearer ${secrets.ADMIN_API_KEY}`};
const report={origin,startedAt:new Date().toISOString(),generations:0,retries:0};
let keyId, cookie;
async function req(path,init={}) {return fetch(origin+path,{...init,redirect:'error',signal:AbortSignal.timeout(20000)});}
async function json(r) {return r.json().catch(()=>({}));}
try {
 const health=await req('/health');assert.equal(health.status,200);
 const healthBody=await json(health);assert.equal(healthBody.ok,true);assert.equal(healthBody.service,'oneapi-codex-gateway-demo');
 assert.equal((await req('/admin/status')).status,401);
 const login=await req('/admin/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:secrets.ADMIN_API_KEY})});
 assert.equal(login.status,200); cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
 assert.equal((await req('/admin/status',{headers:{Cookie:cookie}})).status,200);report.adminLogin=true;
 assert.equal((await req('/admin/api-keys',{method:'POST',headers:{Cookie:cookie,Origin:'https://foreign.example','Content-Type':'application/json'},body:JSON.stringify({name:'rejected-cross-origin'})})).status,403);report.csrfRejected=true;
 const access=await req('/admin/access',{headers:adminHeaders});assert.equal(access.status,200);report.accessEnabled=(await json(access)).enabled;
 const before=await json(await req('/admin/status',{headers:adminHeaders}));report.connected=before.connected;report.reauthenticationRequired=before.reauthenticationRequired;
 const created=await req('/admin/api-keys',{method:'POST',headers:{...adminHeaders,'Content-Type':'application/json'},body:JSON.stringify({name:'phase02-cloud-smoke',modelAccess:{mode:'allowlist',models:['gpt-5.5']}})});
 assert.equal(created.status,201);const data=await json(created);keyId=data.id??data.apiKey?.id;const key=data.key??data.apiKey?.key;assert.ok(keyId&&key);
 assert.equal((await req('/admin/status',{headers:{Authorization:`Bearer ${key}`}})).status,401);report.keyAdminDenied=true;
 if(adminOnly){report.upstreamSkipped='admin_only';}
 else if(!report.connected) {report.upstreamSkipped='account_not_connected';process.exitCode=1;}
 else {
  const usage=await req('/admin/usage',{headers:adminHeaders});const u=await json(usage);report.usage={status:usage.status,available:u.available===true,code:u.error?.code??null};if(!usage.ok||u.available!==true)process.exitCode=1;
  const models=await req('/v1/models',{headers:{Authorization:`Bearer ${key}`}});const m=await json(models);report.models={status:models.status,code:m.error?.code??null,items:m.data?.map(x=>({id:x.id,reasoning:x.capabilities?.reasoning}))};
  if(models.ok) {
   assert.ok(m.data.every(x=>x.id==='gpt-5.5'));assert.ok(m.data.length);report.filteredModels=true;
   const client=new OpenAI({apiKey:key,baseURL:origin+'/v1',maxRetries:0,timeout:60000});
   report.generations++;
   const response=await client.responses.create({model:'gpt-5.5',input:'Reply only WORKER_OK',reasoning:{effort:'low'}});
   assert.equal(response.status,'completed');assert.ok(response.output_text);report.responses={completed:true,chars:response.output_text.length,usage:response.usage};
   report.generations++;
   const stream=await client.chat.completions.create({model:'gpt-5.5',messages:[{role:'user',content:'Reply only WORKER_OK'}],reasoning_effort:'low',stream:true,stream_options:{include_usage:true}});
   let output='',usage;for await(const chunk of stream){output+=chunk.choices?.[0]?.delta?.content??'';if(chunk.usage)usage=chunk.usage;}
   assert.ok(output);report.chat={completed:true,chars:output.length,usage};
  } else {report.upstreamSkipped='models_failed';process.exitCode=1;}
 }
 const logs=await json(await req(`/admin/logs?keyId=${encodeURIComponent(keyId)}`,{headers:adminHeaders}));report.logRows=logs.data?.length??logs.logs?.length??logs.items?.length??null;
} catch(error) {report.failure={name:error.name,status:error.status??null,code:error.code??null};process.exitCode=1;}
finally {
 const cleanupErrors=[];
 if(keyId) {
  try {
   const r=await req(`/admin/api-keys/${keyId}`,{method:'DELETE',headers:{...adminHeaders,'Content-Type':'application/json'},body:'{}'});
   report.tempKeyRemoved=r.ok;
   if(!r.ok) cleanupErrors.push({action:'delete_test_key',status:r.status});
  } catch {report.tempKeyRemoved=false;cleanupErrors.push({action:'delete_test_key',status:null});}
 }
 if(cookie) {
  try {
   const r=await req('/admin/session',{method:'DELETE',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{}'});
   report.testSessionLoggedOut=r.ok;
   if(!r.ok) cleanupErrors.push({action:'logout_test_session',status:r.status});
  } catch {report.testSessionLoggedOut=false;cleanupErrors.push({action:'logout_test_session',status:null});}
 }
 if(cleanupErrors.length){report.cleanupErrors=cleanupErrors;process.exitCode=1;}
 report.finishedAt=new Date().toISOString();
 try {await writeFile('output/phase02/cloud-smoke.json',JSON.stringify(report,null,2));}
 catch {report.reportWriteFailed=true;process.exitCode=1;}
 console.log(JSON.stringify(report));
}
