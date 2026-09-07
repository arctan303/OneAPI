import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const HEALTH_SERVICE = 'oneapi-codex-gateway-demo';
const DIAGNOSTIC_FIELDS = [
  'event',
  'upstreamHostname',
  'upstreamPath',
  'status',
  'contentType',
  'server',
  'cfRay',
  'cfMitigated',
  'upstreamRequestId',
  'htmlTitle',
  'errorCategory',
  'bodyBytes',
  'bodySha256',
  'cfErrorCode',
  'bodyTruncated',
  'contentEncoding',
  'bodyFormat',
  'bodyMarker',
];

const MODES = new Set(['models', 'usage', 'generate']);

function parseJsonc(source) {
  let output = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inLineComment) {
      if (current === '\n' || current === '\r') {
        inLineComment = false;
        output += current;
      }
      continue;
    }
    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
    } else if (current === '/' && next === '/') {
      inLineComment = true;
      index += 1;
    } else if (current === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
    } else {
      output += current;
    }
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, '$1'));
}

function exactHttpsOrigin(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin');
  }
  const parsed = new URL(value);
  if (parsed.origin !== value || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin');
  }
  return parsed.origin;
}

function readAdminApiKey(source) {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^ADMIN_API_KEY=(.*)$/);
    if (!match) continue;
    const value = match[1].trim();
    if (value.length === 0) break;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }
  throw new Error('ADMIN_API_KEY is missing');
}

function diagnosticFrom(payload) {
  const candidates = [
    payload?.error?.diagnostic,
    payload?.diagnostic,
    payload?.error?.upstreamDiagnostic,
    payload?.upstreamDiagnostic,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const picked = {};
    for (const field of DIAGNOSTIC_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(candidate, field)) picked[field] = candidate[field];
    }
    if (Object.keys(picked).length > 0) return picked;
  }
  return undefined;
}

const USAGE_NUMBER_FIELDS = new Set([
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'prompt_tokens',
  'completion_tokens',
  'cached_tokens',
  'audio_tokens',
  'reasoning_tokens',
  'accepted_prediction_tokens',
  'rejected_prediction_tokens',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'promptTokens',
  'completionTokens',
  'cachedTokens',
  'audioTokens',
  'reasoningTokens',
  'acceptedPredictionTokens',
  'rejectedPredictionTokens',
  'usedPercent',
  'remainingPercent',
  'resetsAt',
  'windowDurationMins',
  'fetchedAt',
  'lastSuccessAt',
]);
const SENSITIVE_USAGE_FIELD = /token|key|secret|password|cookie|auth/i;

function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (USAGE_NUMBER_FIELDS.has(key)) {
      if (typeof item === 'number' && Number.isFinite(item)) output[key] = item;
      continue;
    }
    if (SENSITIVE_USAGE_FIELD.test(key) || !item || typeof item !== 'object' || Array.isArray(item)) continue;
    const nested = safeUsage(item);
    if (nested && Object.keys(nested).length > 0) output[key] = nested;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function responseCharacters(payload) {
  const candidates = [
    payload?.output_text,
    payload?.text,
    payload?.response?.output_text,
    payload?.response?.text,
  ];
  for (const value of candidates) if (typeof value === 'string') return value.length;
  const output = payload?.output ?? payload?.response?.output;
  if (Array.isArray(output)) {
    let count = 0;
    let found = false;
    for (const item of output) {
      for (const content of item?.content ?? []) {
        if (typeof content?.text === 'string') {
          count += content.text.length;
          found = true;
        }
      }
    }
    if (found) return count;
  }
  return undefined;
}

async function jsonBody(response) {
  try {
    const value = await response.json();
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function messageCode(payload) {
  const value = payload?.error?.messageCode ?? payload?.messageCode ?? payload?.error?.code;
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function targetFor(mode) {
  if (mode === 'models') return { path: '/admin/test/models', timeoutMs: 30_000 };
  if (mode === 'usage') return { path: '/admin/usage?refresh=true', timeoutMs: 30_000 };
  return {
    path: '/admin/test/responses',
    timeoutMs: 60_000,
    init: {
      method: 'POST',
      headers: { 'Authorization': '__ADMIN_AUTH__', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', input: 'Reply only OK', stream: false }),
    },
  };
}

function reportPath(root, mode, timestamp) {
  const safeTimestamp = timestamp.toISOString().replace(/[.:]/g, '-');
  return path.join(root, 'output', 'phase02', `probe-${mode}-${safeTimestamp}.json`);
}

export async function runProbe({ root = process.cwd(), mode = 'models', fetchImpl = fetch, now = new Date() } = {}) {
  if (!MODES.has(mode)) throw new Error('mode must be models, usage, or generate');
  const config = parseJsonc(await readFile(path.join(root, 'wrangler.worker.jsonc'), 'utf8'));
  const origin = exactHttpsOrigin(config?.vars?.PUBLIC_ORIGIN);
  const report = { mode, health: {}, target: {} };
  if (mode === 'generate') report.generationsAttempts = 0;
  let failed = false;

  const healthResponse = await fetchImpl(`${origin}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const healthPayload = await jsonBody(healthResponse);
  report.health = {
    statusCode: healthResponse.status,
    ok: healthPayload.ok === true,
    service: healthPayload.service === HEALTH_SERVICE ? HEALTH_SERVICE : 'unexpected',
  };
  if (healthResponse.status !== 200 || healthPayload.ok !== true || healthPayload.service !== HEALTH_SERVICE) {
    failed = true;
  } else {
    const adminApiKey = readAdminApiKey(await readFile(path.join(root, '.dev.vars.worker'), 'utf8'));
    const target = targetFor(mode);
    const init = {
      ...(target.init ?? {}),
      signal: AbortSignal.timeout(target.timeoutMs),
      headers: {
        ...(target.init?.headers ?? {}),
        Authorization: `Bearer ${adminApiKey}`,
      },
    };
    if (mode === 'generate') report.generationsAttempts = 1;
    const targetResponse = await fetchImpl(`${origin}${target.path}`, { ...init, redirect: 'error' });
    const payload = await jsonBody(targetResponse);
    const targetReport = { statusCode: targetResponse.status };
    if (mode === 'usage') targetReport.available = payload.available === true;
    if (mode === 'models') {
      const models = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : undefined;
      targetReport.modelCount = typeof payload.modelCount === 'number' ? payload.modelCount : models?.length;
    } else if (mode === 'usage') {
      targetReport.usage = safeUsage(payload.usage ?? payload);
    } else {
      targetReport.responseChars = responseCharacters(payload);
      targetReport.usage = safeUsage(payload.usage ?? payload.response?.usage);
    }
    const diagnostic = diagnosticFrom(payload);
    if (diagnostic) targetReport.diagnostic = diagnostic;
    const code = messageCode(payload);
    if (code) targetReport.messageCode = code;
    report.target = targetReport;
    if (mode === 'models') targetReport.available = targetResponse.ok && targetReport.modelCount > 0;
    if (mode === 'generate') targetReport.available = targetResponse.ok && typeof targetReport.responseChars === 'number';
    const validTarget = mode === 'usage'
      ? targetResponse.ok && targetReport.available === true
      : targetReport.available === true;
    if (!validTarget) failed = true;
  }

  const outputPath = reportPath(root, mode, now);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  report.output = path.relative(root, outputPath).replaceAll(path.sep, '/');
  return { report, failed, outputPath };
}

export async function main(argv = process.argv.slice(2)) {
  const mode = argv[0] ?? 'models';
  try {
    const result = await runProbe({ mode });
    console.log(JSON.stringify(result.report));
    if (result.failed) process.exitCode = 1;
    return result;
  } catch (error) {
    const report = { mode, failed: true, errorKind: error?.name === 'AbortError' ? 'timeout' : 'probe_failed' };
    try {
      const outputPath = reportPath(process.cwd(), mode, new Date());
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
      report.output = path.relative(process.cwd(), outputPath).replaceAll(path.sep, '/');
    } catch {
      report.errorKind = 'probe_failed';
    }
    console.log(JSON.stringify(report));
    process.exitCode = 1;
    return { report, failed: true };
  }
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();

export { DIAGNOSTIC_FIELDS, HEALTH_SERVICE, parseJsonc, responseCharacters };
