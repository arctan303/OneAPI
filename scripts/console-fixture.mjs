import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Dev-only UI fixture: isolated storage, synthetic credentials, fixed Mock outbound.
// Never reads .env or loads the real account. Close with SIGINT/SIGTERM.
const root = await mkdtemp(join(tmpdir(), 'oneapi-console-fixture-'));
let server, runtime, timer;
try {
  await build({ stdin: { contents: `export { createServerRuntime } from './src/runtime/node/runtime.ts'; export { mockUpstreamFetch } from './src/codex/mock.ts'; export { startHttpServer } from './server/http.mjs';`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(root,'runtime.mjs'), bundle:true, platform:'node',format:'esm',target:'node24',logLevel:'warning' });
  const { createServerRuntime, mockUpstreamFetch, startHttpServer } = await import(pathToFileURL(join(root,'runtime.mjs')).href);
  const config = { ADMIN_API_KEY:'console-fixture-admin-password-000001', GATEWAY_API_KEY:'console-fixture-gateway-key-0000001', TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64') };
  const fetchImpl = request => new URL(request.url).pathname === '/api/accounts/deviceauth/usercode'
    ? Promise.resolve(Response.json({device_auth_id:'mock-device-auth-id',user_code:'MOCK-CODE',interval:'1'})) : mockUpstreamFetch(request);
  runtime = await createServerRuntime({databasePath:join(root,'fixture.sqlite'),publicDir:resolve('public'),config,fetchImpl,logger:()=>{}});
  await runtime.ready;
  const admin = async (path,method='GET',body) => {
    const response = await runtime.fetch(new Request('http://127.0.0.1'+path,{method,headers:{Authorization:'Bearer '+config.ADMIN_API_KEY,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),{remoteAddress:'127.0.0.1'});
    if (!response.ok) throw new Error('Fixture seed failed: '+path+' '+response.status);
    return response.status===204?null:response.json();
  };
  const start=await admin('/admin/device/start','POST',{});
  await new Promise(resolve=>setTimeout(resolve,Math.max(10,start.nextPollAt-Date.now()+10)));
  await admin('/admin/device/poll','POST',{login_id:start.id});
  const key=await admin('/admin/api-keys','POST',{name:'Browser fixture key',modelAccess:{mode:'allowlist',models:['gpt-mock']}});
  const generation=await runtime.fetch(new Request('http://127.0.0.1/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+key.key,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-mock',input:'fixture seed',max_output_tokens:32})}),{remoteAddress:'127.0.0.1'});
  if (!generation.ok) throw new Error('Fixture generation failed');
  await generation.arrayBuffer();
  server=await startHttpServer({runtime,host:'127.0.0.1',port:18795});
  console.log(JSON.stringify({event:'console_fixture_ready',url:server.url.origin,synthetic:true,realOutbound:false}));
  await new Promise(resolve=>{
    process.once('SIGINT',resolve);process.once('SIGTERM',resolve);
    timer=setTimeout(resolve,30*60*1000);
  });
} finally {
  clearTimeout(timer);
  await server?.close();await runtime?.dispose();
  if (!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('oneapi-console-fixture-')) throw new Error('cleanup rejected');
  await rm(root,{recursive:true,force:true});
}
