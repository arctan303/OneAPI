// Send only named Worker secrets over Wrangler stdin; do not print secret values.
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const values=Object.fromEntries((await readFile('.dev.vars.worker','utf8')).split(/\r?\n/).filter(x=>/^[A-Z_]+=/.test(x)).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
const names=['ADMIN_API_KEY','GATEWAY_API_KEY','TOKEN_ENCRYPTION_KEY',...(process.argv.includes('--enable-import')?['ACCOUNT_IMPORT_SECRET']:[])];
if(names.some(name=>!values[name]))throw new Error('Missing Worker secrets; run prepare-worker-secrets first');
const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','bulk','--config','wrangler.worker.jsonc'],{stdio:['pipe','inherit','inherit'],windowsHide:true});
child.stdin.end(JSON.stringify(Object.fromEntries(names.map(name=>[name,values[name]]))));
child.on('error',()=>{console.error('Wrangler could not start');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
