import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve('dist/server');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version) || manifest.version !== version) throw new Error('Release version mismatch');
const expected = new Set([...manifest.files.map(item => item.file), 'manifest.json']);
async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Artifact symlink rejected');
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(relative(root, path).replaceAll('\\', '/'));
    else throw new Error('Artifact special file rejected');
  }
  return result;
}
const actual = await walk(root);
if (actual.length !== expected.size || actual.some(file => !expected.has(file))) throw new Error('Unexpected or missing artifact files');
const secrets = [];
for (const file of ['.env', '.dev.vars', '.dev.vars.worker']) {
  const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN)[A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) {
      const value = match[2].replace(/^["']|["']$/g, '');
      if (value.length >= 16) secrets.push({ name: match[1], value: Buffer.from(value) });
    }
  }
}
for (const file of actual) {
  const bytes = await readFile(join(root, file));
  const entry = manifest.files.find(item => item.file === file);
  if (entry && (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)) throw new Error('Artifact manifest mismatch');
  if (secrets.some(secret => bytes.includes(secret.value))) throw new Error('A configured secret appears in the artifact; packaging refused');
}
const archiveName = `oneapi-server-${version}.tar.gz`;
const archive = resolve('dist', archiveName);
await mkdir('dist', { recursive: true });
const tar = spawnSync('tar', ['-czf', archive, '-C', resolve('dist'), 'server'], { encoding: 'utf8', windowsHide: true });
if (tar.status !== 0) throw new Error('Archive command failed');
const bytes = await readFile(archive);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(archive + '.sha256', sha256 + '  ' + archiveName + '\n');
console.log(JSON.stringify({ event: 'server_packaged', archive: 'dist/' + archiveName,
  bytes: (await stat(archive)).size, sha256, files: actual.length, configuredSecretMatches: 0,
  credentialSourcesChecked: secrets.length, runtimePackages: manifest.runtimePackages }));
