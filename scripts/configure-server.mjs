import { readFile, lstat, open, rename, unlink, chown } from 'node:fs/promises';
import { resolve, dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { readServerConfig } from '../server/config.mjs';
import { isPrivateAddress } from '../server/network-config.mjs';

export const CONFIGURE_HELP = `Usage: node configure.mjs [options]
Without --mode, opens an interactive network configuration wizard.
  --env-path <file>           Existing environment file (default: .env)
  --mode <local|lan|public>   Save local, trusted LAN, or HTTPS proxy defaults
  --host <ip|localhost>       Listening address
  --port <1-65535>            Listening port
  --public-origin <https://> Public URL for public mode
  --lan-origins <origins>     Explicit private IP origins instead of LAN discovery
  --help                     Show help without reading the environment file
Only HOST, PORT, LAN_ORIGINS and PUBLIC_ORIGIN are updated. Restart manually.`;
const NETWORK_KEYS = new Set(['HOST', 'PORT', 'LAN_ORIGINS', 'PUBLIC_ORIGIN']);

function argumentsFrom(argv) {
  const fields = new Map([['--env-path','envPath'],['--mode','mode'],['--host','host'],['--port','port'],['--public-origin','publicOrigin'],['--lan-origins','lanOrigins']]);
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') { result.help = true; continue; }
    const key = fields.get(argv[i]);
    if (!key || result[key] !== undefined || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error('invalid_arguments');
    result[key] = argv[++i];
  }
  return result;
}

async function regularFile(path) {
  // Reject symlinked files and ancestors before reading or writing secrets.
  const root = parse(path).root;
  let part = root;
  for (const segment of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    part = join(part, segment);
    const info = await lstat(part);
    if (info.isSymbolicLink()) throw new Error('symlink_rejected');
  }
  const info = await lstat(path);
  if (!info.isFile() || info.nlink > 1) throw new Error('regular_single_link_file_required');
  return info;
}

function replacementText(text, fields) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Set();
  const lines = text.split(/\r?\n/).map(line => {
    const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) return line;
    const [, prefix, key, value] = match;
    // Refuse multiline values rather than treating their contents as assignments.
    if (/^["'`]/.test(value) && value.indexOf(value[0], 1) < 0) throw new Error('multiline_env_not_supported');
    if (!NETWORK_KEYS.has(key)) return line;
    if (seen.has(key)) throw new Error('duplicate_network_field');
    seen.add(key);
    const comment = /\s+#.*$/.exec(value)?.[0] ?? '';
    return `${prefix}${key}=${fields[key]}${comment}`;
  });
  while (lines.at(-1) === '') lines.pop();
  for (const key of NETWORK_KEYS) if (!seen.has(key)) lines.push(`${key}=${fields[key]}`);
  return lines.join(newline) + newline;
}

export async function configureEnv(options, interfaces = networkInterfaces(), hooks = {}) {
  const target = resolve(options.envPath || '.env');
  const originalInfo = await regularFile(target);
  const original = await readFile(target, 'utf8');
  const env = parseEnv(original);
  if (!['local','lan','public'].includes(options.mode)) throw new Error('invalid_mode');
  if (options.mode !== 'public' && options.publicOrigin !== undefined) throw new Error('public_origin_requires_public_mode');
  if (options.mode !== 'lan' && options.lanOrigins !== undefined) throw new Error('lan_origins_requires_lan_mode');
  const host = options.host ?? (options.mode === 'lan' ? '0.0.0.0' : '127.0.0.1');
  const port = options.port ?? env.PORT ?? '8787';
  if (options.mode === 'local' && !['127.0.0.1','::1','localhost'].includes(host)) throw new Error('local_mode_requires_loopback');
  const source = { ...env, HOST: host, PORT: port, LAN_ORIGINS: '', PUBLIC_ORIGIN: '' };
  if (options.mode === 'public') {
    source.PUBLIC_ORIGIN = options.publicOrigin ?? env.PUBLIC_ORIGIN ?? '';
    if (!source.PUBLIC_ORIGIN) throw new Error('public_origin_required');
  }
  if (options.mode === 'lan' && options.lanOrigins !== undefined) source.LAN_ORIGINS = options.lanOrigins;
  const config = readServerConfig(source, dirname(target), options.mode === 'lan' && options.lanOrigins === undefined ? ['--lan'] : [], interfaces);
  if (options.mode === 'lan' && !config.config.LAN_ORIGINS) throw new Error('lan_origins_required');
  const fields = { HOST:config.host, PORT:String(config.port), LAN_ORIGINS:config.config.LAN_ORIGINS ?? '', PUBLIC_ORIGIN:config.config.PUBLIC_ORIGIN ?? '' };
  const updated = replacementText(original, fields);
  const temp = join(dirname(target), '.oneapi-network-' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await open(temp, 'wx', originalInfo.mode & 0o777 & 0o600);
    if (process.platform === 'win32') {
      // Copy the source ACL onto the empty temporary file before writing secrets.
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const aclScript = '$ErrorActionPreference = "Stop"; $sourceAcl = [System.IO.File]::GetAccessControl($env:ONEAPI_CONFIG_SOURCE); $acl = [System.Security.AccessControl.FileSecurity]::new(); $acl.SetSecurityDescriptorSddlForm($sourceAcl.Sddl, [System.Security.AccessControl.AccessControlSections]14); [System.IO.File]::SetAccessControl($env:ONEAPI_CONFIG_TEMP, $acl)';
      execFileSync(powershell, ['-NoProfile','-NonInteractive','-EncodedCommand', Buffer.from(aclScript, 'utf16le').toString('base64')],
        { windowsHide:true, timeout:15000, stdio:'ignore', env:{...process.env,ONEAPI_CONFIG_SOURCE:target,ONEAPI_CONFIG_TEMP:temp} });
    }
    await handle.writeFile(updated, 'utf8');
    await handle.chmod(originalInfo.mode & 0o777);
    await handle.sync();
    await handle.close(); handle = undefined;
    if (process.platform !== 'win32') await chown(temp, originalInfo.uid, originalInfo.gid);
    await hooks.beforeReplace?.();
    const current = await regularFile(target);
    if (current.dev !== originalInfo.dev || current.ino !== originalInfo.ino || await readFile(target, 'utf8') !== original) throw new Error('configuration_changed_during_edit');
    await rename(temp, target);
  } finally {
    await handle?.close();
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { event:'network_config_saved', path:target, restartRequired:true, accessUrls:config.accessUrls, secretsPrinted:false };
}

async function interactive(options) {
  if (!process.stdin.isTTY) throw new Error('use_mode_for_noninteractive_configuration');
  const target = resolve(options.envPath || '.env');
  await regularFile(target);
  const defaults = parseEnv(await readFile(target, 'utf8'));
  const currentMode = defaults.LAN_ORIGINS ? 'lan' : defaults.PUBLIC_ORIGIN ? 'public' : 'local';
  const rl = createInterface({ input:process.stdin, output:process.stdout });
  const ask = async (label, fallback) => (await rl.question(`${label} [${fallback}]: `)).trim() || fallback;
  try {
    console.log('网络配置：1 本机；2 可信局域网；3 公网 HTTPS / 反代 / Tunnel');
    const selected = await ask('模式', {local:'1',lan:'2',public:'3'}[currentMode]);
    options.mode = ({1:'local',2:'lan',3:'public'})[selected];
    if (!options.mode) throw new Error('invalid_mode');
    if (options.mode === 'lan') {
      const addresses = Object.values(networkInterfaces()).flat().filter(item => item && !item.internal && isPrivateAddress(item.address)).map(item => item.address);
      console.log('当前私网地址：' + (addresses.join(', ') || '未发现；请使用本机或 HTTPS 模式'));
      console.log('HTTP 局域网模式仅适用于可信网络。0.0.0.0 监听所有 IPv4 网卡。');
    }
    options.host ??= await ask('监听地址', options.mode === currentMode && defaults.HOST ? defaults.HOST : options.mode === 'lan' ? '0.0.0.0' : '127.0.0.1');
    options.port ??= await ask('监听端口', defaults.PORT || '8787');
    if (options.mode === 'public') options.publicOrigin ??= await ask('公开 HTTPS origin（例如 https://api.example.com）', defaults.PUBLIC_ORIGIN || '');
    return options;
  } finally { rl.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    let options = argumentsFrom(argv);
    if (options.help) { console.log(CONFIGURE_HELP); return; }
    if (!options.mode) options = await interactive(options);
    const result = await configureEnv(options);
    console.log(JSON.stringify(result));
    console.log('网络默认值已保存。请重启 OneAPI 服务；账号与密钥保留。');
    return result;
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'env_missing_run_setup_first' : 'network_configuration_failed';
    console.error(JSON.stringify({ error:code, message:'检查参数、现有配置文件、文件权限和地址；使用 --help 查看说明。配置失败时不替换原文件。', secretsPrinted:false }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
