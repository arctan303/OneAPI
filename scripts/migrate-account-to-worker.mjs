// Explicit one-time migration of this Demo's credentials to its own configured Worker.
// No plaintext OAuth file is created; no credential is written to stdout.
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { deserialize } from 'node:v8';
import { resolve } from 'node:path';
function vars(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter(x=>/^[A-Z_]+\s*=/.test(x)).map(line=> {
    const i=line.indexOf('='); let value=line.slice(i+1).trim();
    if ((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'"))) value=value.slice(1,-1);
    return [line.slice(0,i).trim(),value];
  }));
}
async function main() {
  const cloudConfig=JSON.parse(await readFile('wrangler.worker.jsonc','utf8'));
  const origin=cloudConfig.vars.PUBLIC_ORIGIN;
  if(new URL(origin).origin!==origin || !origin.startsWith('https://')) throw new Error('Configured PUBLIC_ORIGIN must be an exact HTTPS origin');
  const local=vars(await readFile('.dev.vars','utf8'));
  const cloud=vars(await readFile('.dev.vars.worker','utf8'));
  if(!cloud.ADMIN_API_KEY||!cloud.ACCOUNT_IMPORT_SECRET) throw new Error('Missing cloud import secrets');
  const headers={Authorization:`Bearer ${cloud.ADMIN_API_KEY}`};
  const health=await fetch(`${origin}/health`,{redirect:'error',signal:AbortSignal.timeout(15000)});
  const healthBody=await health.json();
  if(!health.ok || healthBody.ok!==true || healthBody.service!=='oneapi-codex-gateway-demo') throw new Error('Target health check failed');
  const status=await fetch(`${origin}/admin/status`,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!status.ok) throw new Error(`Target admin verification failed (${status.status})`);
  if((await status.json()).connected) throw new Error('Target already has an account; refusing overwrite');
  const dir=resolve('.wrangler/state/v3/do/oneapi-codex-gateway-demo-AccountDurableObject');
  const files=(await readdir(dir)).filter(x=>/^[0-9a-f]{64}\.sqlite$/.test(x));
  if(files.length!==1) throw new Error('Ambiguous or absent local account store');
  const db=new DatabaseSync(resolve(dir,files[0]),{readOnly:true});
  let envelope;
  try { const row=db.prepare('SELECT value FROM _cf_KV WHERE key = ?').get('credentials');
    if(!row) throw new Error('No local Demo credentials'); envelope=deserialize(row.value);
  } finally {db.close();}
  if(envelope.version!==1) throw new Error('Unsupported local envelope');
  const rawKey=Buffer.from(local.TOKEN_ENCRYPTION_KEY??'','base64');
  if(rawKey.length!==32) throw new Error('Invalid local encryption key');
  const key=await crypto.subtle.importKey('raw',rawKey,'AES-GCM',false,['decrypt']);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(envelope.iv,'base64'),additionalData:new TextEncoder().encode('oneapi:credentials:v1')},key,Buffer.from(envelope.ciphertext,'base64'));
  const stored=JSON.parse(new TextDecoder().decode(plain));
  const credentials={idToken:stored.idToken,accessToken:stored.accessToken,refreshToken:stored.refreshToken};
  const body=JSON.stringify(credentials);
  if(Buffer.byteLength(body)>32768) throw new Error('Credential payload exceeds import limit');
  const response=await fetch(`${origin}/admin/account/import`, {method:'POST',headers:{...headers,'Content-Type':'application/json','X-OneAPI-Import-Secret':cloud.ACCOUNT_IMPORT_SECRET},body,redirect:'error',signal:AbortSignal.timeout(20000)});
  console.log(JSON.stringify({event:'account_import',status:response.status,success:response.status===204}));
  if(response.status!==204) {const error=await response.json().catch(()=>null); console.log(JSON.stringify({code:error?.error?.code??'unknown'})); process.exitCode=1;}
}
main().catch(()=>{console.error('Account migration stopped safely; check target connectivity, authorization and local store. No credential printed.');process.exitCode=1;});
