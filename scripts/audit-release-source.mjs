import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function git(args) {
  const result = spawnSync('git', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Could not inspect Git index');
  return result.stdout;
}
const configured = [];
for (const file of ['.env', '.dev.vars', '.dev.vars.worker']) {
  const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN)[A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    if (value.length >= 16) configured.push(Buffer.from(value));
  }
}
const files = git(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
const findings = [];
let bytes = 0;
for (const file of files) {
  const allowedFixture = ['.env.example', '.dev.vars.example', '.dev.vars.test', 'test/mock.env'].includes(file);
  if (!allowedFixture && (/(^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/.test(file)
      || /^(?:data|output|dist|node_modules|\.wrangler)\//.test(file) || /\.(?:sqlite|log)(?:$|-)/.test(file))) {
    findings.push({ file, kind: 'private_runtime_file' });
  }
  const blob = git(['show', ':' + file]);
  bytes += blob.length;
  if (configured.some(value => blob.includes(value))) findings.push({ file, kind: 'configured_secret' });
  if (blob.includes(0)) findings.push({ file, kind: 'binary_requires_review' });
  const text = blob.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
      || /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,})\b/.test(text)
      || /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/.test(text)) {
    findings.push({ file, kind: 'credential_literal_requires_review' });
  }
}
console.log(JSON.stringify({ scope: 'git_index', files: files.length, bytes, configuredValuesChecked: configured.length, findings }));
if (findings.length) process.exitCode = 1;
