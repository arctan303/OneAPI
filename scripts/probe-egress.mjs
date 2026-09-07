import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseJsonc,DIAGNOSTIC_FIELDS,HEALTH_SERVICE} from './probe-worker-upstream.mjs';
const operation=process.argv[2]??'ping';
if(!['ping','models','usage','generate','disabled'].includes(operation)) throw new Error('Unsupported operation');
const report={operation,startedAt:new Date().toISOString(),upstreamReadBudget:operation==='models'||operation==='usage'?2:0,generationBudget:operation==='generate'?1:0};
const outfile=`output/egress/probe-${operation}-${report.startedAt.replace(/[.:]/g,'-')}.json`;
function summarize(value) {
 if(!value||typeof value!=='object')return undefined;
 const result={};
 for(const key of ['status','ok','contentType','bodyBytes','bodySha256','modelCount','completed','responseChars','service','requestIdBound','code']){
  if(['string','number','boolean'].includes(typeof value[key]))result[key]=value[key];
 }
 if(Array.isArray(value.modelIds))result.modelIds=value.modelIds.filter(x=>typeof x==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(x)).slice(0,100);
 if(value.generationUsage&&typeof value.generationUsage==='object')result.generationUsage=Object.fromEntries(Object.entries(value.generationUsage).filter(([k,v])=>/token/i.test(k)&&(typeof v==='number'||v===null)));
 if(value.usage&&typeof value.usage==='object'&&typeof value.completed==='boolean')result.usage=Object.fromEntries(Object.entries(value.usage).filter(([k,v])=>/token/i.test(k)&&(typeof v==='number'||v===null)));
 if(value.usage&&typeof value.usage==='object'&&typeof value.completed!=='boolean'){
  result.usageWindows={};
  for(const window of ['fiveHour','sevenDay']){
   const item=value.usage[window];
   result.usageWindows[window]=item&&typeof item==='object'?Object.fromEntries(['usedPercent','remainingPercent','resetsAt','windowDurationMins'].filter(k=>typeof item[k]==='number'||item[k]===null).map(k=>[k,item[k]])):null;
  }
 }
 if(value.diagnostic&&typeof value.diagnostic==='object')result.diagnostic=Object.fromEntries(DIAGNOSTIC_FIELDS.filter(k=>Object.hasOwn(value.diagnostic,k)).map(k=>[k,value.diagnostic[k]]));
 return result;
}
try {
 const config=parseJsonc(await readFile('wrangler.worker.jsonc','utf8'));
 const origin=config.vars.PUBLIC_ORIGIN;
 if(typeof origin!=='string'||!origin.startsWith('https://')||new URL(origin).origin!==origin)throw new Error('Invalid origin');
 const health=await fetch(origin+'/health',{redirect:'error',signal:AbortSignal.timeout(15000)});
 const h=await health.json();
 if(!health.ok||h.ok!==true||h.service!==HEALTH_SERVICE)throw new Error('Invalid health');
 report.health=true;
 const vars=await readFile('.dev.vars.worker','utf8');
 const key=/^ADMIN_API_KEY=(.+)$/m.exec(vars)?.[1]?.trim().replace(/^['"]|['"]$/g,'');
 if(!key)throw new Error('Missing admin secret');
 const response=await fetch(origin+'/admin/diagnostics/egress',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({operation:operation==='disabled'?'ping':operation}),redirect:'error',signal:AbortSignal.timeout(80000)});
 const body=await response.json();
 report.httpStatus=response.status;
 if(body.error?.code)report.code=body.error.code;
 report.direct=summarize(body.direct);report.relay=summarize(body.relay);
 if(typeof body.sameCredential==='boolean')report.sameCredential=body.sameCredential;
 const valid=operation==='disabled'?response.status===503&&body.error?.code==='egress_diagnostic_disabled':response.ok&&body.relay?.ok===true&&(operation!=='models'||body.relay.modelCount>0)&&(operation!=='generate'||body.relay.completed===true&&body.relay.responseChars>0);
 report.passed=valid;
 if(!valid)process.exitCode=1;
} catch { report.passed=false;report.errorKind='probe_failed';process.exitCode=1; }
report.finishedAt=new Date().toISOString();
await mkdir('output/egress',{recursive:true});await writeFile(outfile,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,output:outfile}));
