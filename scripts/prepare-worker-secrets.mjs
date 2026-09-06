// Generate separate Worker secrets once. OAuth tokens never enter this file.
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const local=await readFile('.dev.vars','utf8');
let admin=/^ADMIN_API_KEY\s*=\s*(.+)$/m.exec(local)?.[1]?.trim();
if(admin&&((admin.startsWith('"')&&admin.endsWith('"'))||(admin.startsWith("'")&&admin.endsWith("'"))))admin=admin.slice(1,-1);
if(!admin||/[\r\n]/.test(admin)) throw new Error('Local ADMIN_API_KEY required');
const values={ADMIN_API_KEY:admin,GATEWAY_API_KEY:`gw_${randomBytes(32).toString('base64url')}`,TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('base64'),ACCOUNT_IMPORT_SECRET:randomBytes(32).toString('base64url')};
await writeFile('.dev.vars.worker',Object.entries(values).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{flag:'wx',mode:0o600});
console.log('Created ignored .dev.vars.worker. Administrator password retained; gateway/encryption/import secrets are new. No OAuth copied.');
