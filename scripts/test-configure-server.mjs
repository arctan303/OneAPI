import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { configureEnv } from './configure-server.mjs';
const synthetic = [
  '# retained setup comment',
  'HOST=127.0.0.1 # retained host comment', 'PORT=8787', 'DATA_DIR=./existing-data',
  'ADMIN_API_KEY='+'fixture-admin-'.repeat(4),'GATEWAY_API_KEY='+'fixture-gateway-'.repeat(4),
  'TOKEN_ENCRYPTION_KEY='+Buffer.alloc(32,4).toString('base64'),
  'CUSTOM_SETTING="keep these words"',''
].join('\r\n');
const interfaces = { fixture:[{address:'192.168.9.10',internal:false},{address:'fd12::10',internal:false}] };
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(),'oneapi-configure-'));
  const path = join(root,'.env');
  await writeFile(path,synthetic,{mode:0o640});
  try { await fn(path,root); }
  finally {
    if (!resolve(root).startsWith(resolve(tmpdir())+sep) || !root.includes('oneapi-configure-')) throw new Error('cleanup rejected');
    await rm(root,{recursive:true,force:true});
  }
}
test('LAN save preserves secrets, comments, data location and unrelated fields', async()=>fixture(async(path,root)=>{
  const originalMode=(await stat(path)).mode & 0o777;
  const result=await configureEnv({envPath:path,mode:'lan',host:'0.0.0.0',port:'9090'},interfaces);
  const output=await readFile(path,'utf8'), before=parseEnv(synthetic), after=parseEnv(output);
  for(const key of Object.keys(before).filter(key=>!['HOST','PORT'].includes(key))) assert.equal(after[key],before[key]);
  assert.equal(after.HOST,'0.0.0.0'); assert.equal(after.PORT,'9090');
  assert.equal(after.LAN_ORIGINS,'http://192.168.9.10:9090');
  assert.match(output,/# retained host comment/); assert.match(output,/\r\n/);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777,originalMode);
  assert.equal(result.restartRequired,true); assert.ok(!JSON.stringify(result).includes(before.ADMIN_API_KEY));
  assert.deepEqual(await readdir(root),['.env']);
}));
test('public mode and returning to local explicitly clear old LAN/public origins', async()=>fixture(async(path)=>{
  await configureEnv({envPath:path,mode:'public',publicOrigin:'https://api.example.test',port:'9999'},interfaces);
  assert.equal(parseEnv(await readFile(path,'utf8')).PUBLIC_ORIGIN,'https://api.example.test');
  await configureEnv({envPath:path,mode:'local',port:'8787'},interfaces);
  const result=parseEnv(await readFile(path,'utf8'));
  assert.equal(result.HOST,'127.0.0.1'); assert.equal(result.PUBLIC_ORIGIN,''); assert.equal(result.LAN_ORIGINS,'');
}));
test('invalid options and failed atomic replacement leave original file intact', async()=>fixture(async(path,root)=>{
  for (const options of [{mode:'local',port:'0'},{mode:'local',host:'0.0.0.0'},{mode:'public',publicOrigin:'http://api.example.test'},{mode:'lan',lanOrigins:'http://fd12:8787'}]) {
    await assert.rejects(configureEnv({envPath:path,...options},interfaces));
    assert.equal(await readFile(path,'utf8'),synthetic);
  }
  await assert.rejects(configureEnv({envPath:path,mode:'local'},interfaces,{beforeReplace(){throw new Error('simulated rename precondition failure');}}));
  assert.equal(await readFile(path,'utf8'),synthetic);
  assert.deepEqual(await readdir(root),['.env']);
}));
test('LAN discovery over 32 origins fails before replacing the existing configuration', async()=>fixture(async(path,root)=>{
  const crowdedInterfaces = {
    fixture: Array.from({length:33},(_,index)=>({address:`10.0.0.${index+1}`,family:'IPv4',internal:false})),
  };
  await assert.rejects(
    configureEnv({envPath:path,mode:'lan',host:'0.0.0.0',port:'9090'},crowdedInterfaces),
    /at most 32 origins/,
  );
  assert.equal(await readFile(path,'utf8'),synthetic);
  assert.deepEqual(await readdir(root),['.env']);
}));
test('concurrent edits are preserved and require a fresh configuration attempt', async()=>fixture(async(path)=>{
  const concurrent=synthetic+'# concurrent edit\r\n';
  await assert.rejects(configureEnv({envPath:path,mode:'local'},interfaces,{beforeReplace(){return writeFile(path,concurrent);}}),/changed_during_edit/);
  assert.equal(await readFile(path,'utf8'),concurrent);
}));
test('missing files, duplicate network keys and multiline env fail without replacement', async()=>fixture(async(path,root)=>{
  await assert.rejects(configureEnv({envPath:join(root,'missing'),mode:'local'},interfaces));
  for (const original of [synthetic+'HOST=127.0.0.1\n',synthetic+'CUSTOM_MULTILINE="hello\nHOST=inside-secret\n"\n']) {
    await writeFile(path,original);
    await assert.rejects(configureEnv({envPath:path,mode:'local'},interfaces));
    assert.equal(await readFile(path,'utf8'),original);
  }
}));
test('symlink configuration is rejected without changing its target', async(t)=>fixture(async(path,root)=>{
  const link=join(root,'linked.env');
  try { await symlink(path,link); } catch(error) { if (error.code==='EPERM') { t.skip('OS does not permit fixture symlinks');return; } throw error; }
  await assert.rejects(configureEnv({envPath:link,mode:'local'},interfaces),/symlink/);
  assert.equal(await readFile(path,'utf8'),synthetic);
}));
test('CLI help and invalid noninteractive invocation do not require or disclose secrets', async()=>fixture(async(path)=>{
  const script=resolve('scripts/configure-server.mjs');
  const help=spawnSync(process.execPath,[script,'--help'],{encoding:'utf8',windowsHide:true,timeout:5000});
  assert.equal(help.status,0); assert.match(help.stdout,/--help/);
  const invalid=spawnSync(process.execPath,[script,'--env-path',path,'--mode','local','--port','bad'],{encoding:'utf8',windowsHide:true,timeout:5000});
  assert.equal(invalid.status,1); assert.match(invalid.stderr,/network_configuration_failed/);
  assert.ok(!invalid.stderr.includes(parseEnv(synthetic).ADMIN_API_KEY));
  assert.equal(await readFile(path,'utf8'),synthetic);
}));

test('symlinked parent directory is rejected (Windows junction or POSIX directory link)', async()=>fixture(async(path,root)=>{
  const link=join(root,'indirect');
  await symlink(root,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(configureEnv({envPath:join(link,'.env'),mode:'local'},interfaces),/symlink/);
  assert.equal(await readFile(path,'utf8'),synthetic);
}));

test('Windows replacement preserves a protected source ACL', {skip:process.platform!=='win32'}, async()=>fixture(async(path)=>{
  function aclScript(script) {
    const result=spawnSync(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,ONEAPI_ACL_FIXTURE:path}});
    assert.equal(result.status,0,'synthetic ACL operation should succeed');return result.stdout.trim();
  }
  const read='$acl=[System.IO.File]::GetAccessControl($env:ONEAPI_ACL_FIXTURE); $acl.Sddl';
  aclScript('$acl=[System.IO.File]::GetAccessControl($env:ONEAPI_ACL_FIXTURE); $acl.SetAccessRuleProtection($true,$true); [System.IO.File]::SetAccessControl($env:ONEAPI_ACL_FIXTURE,$acl)');
  const before=aclScript(read);
  await configureEnv({envPath:path,mode:'local',port:'9090'},interfaces);
  assert.equal(aclScript(read),before);
}));
