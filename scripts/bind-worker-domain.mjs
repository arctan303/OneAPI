// No-conflict custom domain binding; never replace another Worker or DNS record.
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
const config=JSON.parse(await readFile('wrangler.worker.jsonc','utf8'));
const domain=new URL(config.vars.PUBLIC_ORIGIN).hostname;
const token=/^oauth_token\s*=\s*"([^"]+)"/m.exec(await readFile(join(homedir(),'.wrangler/config/default.toml'),'utf8'))?.[1];
if(!token) throw new Error('Wrangler login required');
const base=`/accounts/${config.account_id}/workers/scripts/${config.name}`;
async function api(path,method='GET',body) {
 const r=await fetch(`https://api.cloudflare.com/client/v4${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(25000)});
 const data=await r.json(); if(!r.ok||!data.success) throw new Error(`Cloudflare operation failed (${r.status}; codes ${data.errors?.map(x=>x.code).join(',')})`);return data.result;
}
const existing=await api(`/accounts/${config.account_id}/workers/domains`);
const match=existing.find(x=>x.hostname===domain);
if(match && match.service!==config.name) throw new Error('Domain belongs to a different Worker; refusing overwrite');
const origins=[{hostname:domain,zone_name:domain.split('.').slice(-2).join('.')}];
const changes=await api(`${base}/domains/changeset?replace_state=true`,'POST',origins);
console.log(JSON.stringify({domain,added:changes.added?.length,updated:changes.updated?.length,conflicting:changes.conflicting?.length,deleted:changes.deleted?.length}));
if(!Array.isArray(changes.conflicting)||changes.conflicting.length || changes.updated?.some(x=>x.modified) || changes.deleted?.length) throw new Error('Conflict or unexpected scope change; binding refused');
if(!process.argv.includes('--apply')) { console.log('Preflight only. Pass --apply to bind without overwrite.'); }
else {await api(`${base}/domains/records`,'PUT',{override_scope:false,override_existing_origin:false,override_existing_dns_record:false,origins});console.log(JSON.stringify({bound:true,domain,worker:config.name}));}
