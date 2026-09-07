import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version');
const out = resolve(root, 'dist/server');
await mkdir(join(out, 'public'), { recursive: true });
const result = await build({
  absWorkingDir: root, entryPoints: { oneapi: 'server/main.mjs', migrate: 'scripts/migrate-server.mjs', configure: 'scripts/configure-server.mjs' }, outdir: out, outExtension: { '.js': '.mjs' },
  bundle: true, format: 'esm', platform: 'node', target: 'node24', metafile: true,
  sourcemap: false, logLevel: 'warning',
});
const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
if (imports.some(item => !item.path.startsWith('node:'))) throw new Error('Production build has non-Node runtime imports');
if (Object.keys(result.metafile.inputs).some(name => /node_modules\/(?:miniflare|wrangler|workerd)\//.test(name.replaceAll('\\', '/')))) {
  throw new Error('Production build includes a development runtime');
}
const copies = [
  ['public/index.html', 'public/index.html'], ['public/app.js', 'public/app.js'], ['public/styles.css', 'public/styles.css'],
  ['scripts/setup-server.mjs', 'setup.mjs'], ['.env.example', '.env.example'],
  ['docs/INSTALL.md', 'INSTALL.md'], ['docs/NETWORK.md', 'NETWORK.md'],
  ['deploy/README.md', 'README.md'], ['deploy/oneapi.service', 'oneapi.service'], ['deploy/Caddyfile.example', 'Caddyfile.example'],
];
for (const [source, destination] of copies) {
  if (source === 'deploy/README.md') {
    const contents = await readFile(join(root, source), 'utf8');
    await writeFile(join(out, destination), contents.replaceAll('(../docs/NETWORK.md)', '(NETWORK.md)'));
  } else await copyFile(join(root, source), join(out, destination));
}
await writeFile(join(out, 'package.json'), JSON.stringify({ name: 'oneapi-server', version, private: true,
  type: 'module', engines: { node: '>=24.15.0 <25' }, scripts: { start: 'node --env-file-if-exists=.env oneapi.mjs', setup: 'node setup.mjs', configure: 'node configure.mjs' } }, null, 2) + '\n');
const files = ['oneapi.mjs', 'migrate.mjs', 'configure.mjs', 'package.json', ...copies.map(([, destination]) => destination)];
const manifest = [];
for (const file of files) {
  const bytes = await readFile(join(out, file));
  manifest.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(out, 'manifest.json'), JSON.stringify({ version, runtime: 'Node.js >=24.15.0 <25', runtimePackages: 0, files: manifest }, null, 2) + '\n');
console.log(JSON.stringify({ event: 'server_built', directory: 'dist/server', bundleBytes: (await stat(join(out, 'oneapi.mjs'))).size,
  payloadBytes: manifest.reduce((total, item) => total + item.bytes, 0), runtimePackages: 0 }));
