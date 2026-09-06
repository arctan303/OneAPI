// Read-only preflight. Never print the Wrangler OAuth credential.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const config = await readFile(join(homedir(), '.wrangler/config/default.toml'), 'utf8');
const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(config)?.[1];
if (!token) throw new Error('Wrangler OAuth credential unavailable');
const deployment = JSON.parse(await readFile('wrangler.worker.jsonc', 'utf8'));
const account = deployment.account_id;
const hostname = new URL(deployment.vars.PUBLIC_ORIGIN).hostname;
const zoneName = hostname.split('.').slice(-2).join('.');
async function get(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20000)
  });
  const body = await response.json();
  return { status: response.status, success: body.success, result: body.result, result_info: body.result_info,
    errors: body.errors?.map(({code, message}) => ({code, message})) };
}
const paths = { workers: `/accounts/${account}/workers/scripts`, domains: `/accounts/${account}/workers/domains`,
  zones: `/zones?name=${encodeURIComponent(zoneName)}`, access: `/accounts/${account}/access/apps`,
  subdomain: `/accounts/${account}/workers/subdomain` };
const results = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name,path]) => [name,await get(path)])));
const zone = results.zones.result?.find(x => x.name === zoneName);
if (zone) {
  results.routes = await get(`/zones/${zone.id}/workers/routes`);
  results.dns = await get(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`);
}
await mkdir('output/phase02', {recursive:true});
await writeFile('output/phase02/inventory.json', JSON.stringify(results,null,2));
for (const [name,data] of Object.entries(results)) console.log(JSON.stringify({name,status:data.status,success:data.success,
  items:Array.isArray(data.result) ? data.result.map(x=>({id:x.id,name:x.name,hostname:x.hostname,service:x.service,pattern:x.pattern,script:x.script,type:x.type,content:name==='dns'?x.content:undefined})) : data.result, errors:data.errors}));
