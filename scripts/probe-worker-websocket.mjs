import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  DIAGNOSTIC_FIELDS,
  HEALTH_SERVICE,
  parseJsonc,
} from './probe-worker-upstream.mjs';

const MODES = new Set(['probe', 'disabled']);
const RESULT_FIELDS = [
  'status',
  'upgraded',
  'messageObserved',
  'errorObserved',
  'closed',
  'closeCode',
  'serverSelectedModelPresent',
  'reasoningIncluded',
];
const DEADLINE_MS = 15_000;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_STRING_BYTES = 256;

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

async function jsonBody(response) {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel('websocket probe JSON body exceeded limit').catch(() => undefined);
        return {};
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function safeMessageCode(payload) {
  const value = payload?.error?.code ?? payload?.error?.messageCode ?? payload?.messageCode;
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function safeDiagnosticValue(value) {
  if (typeof value === 'string') return value.length <= MAX_STRING_BYTES ? value : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function diagnosticFrom(payload, result) {
  const candidates = [
    result?.diagnostic,
    payload?.error?.diagnostic,
    payload?.diagnostic,
    payload?.error?.upstreamDiagnostic,
    payload?.upstreamDiagnostic,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const picked = {};
    for (const field of DIAGNOSTIC_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(candidate, field)) continue;
      const value = safeDiagnosticValue(candidate[field]);
      if (value !== undefined) picked[field] = value;
    }
    if (Object.keys(picked).length > 0) return picked;
  }
  return undefined;
}

function safeResult(payload) {
  const result = payload?.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
    ? payload.result
    : payload;
  const output = {};
  for (const field of RESULT_FIELDS) {
    const value = result?.[field];
    if (typeof value === 'boolean' || value === null) output[field] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) output[field] = value;
    else if (typeof value === 'string' && value.length <= MAX_STRING_BYTES) output[field] = value;
  }
  const diagnostic = diagnosticFrom(payload, result);
  if (diagnostic) output.diagnostic = diagnostic;
  return output;
}

function timestampValue(value) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) return undefined;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function expiryWindow(payload, nowMs) {
  const candidates = [
    payload?.account?.tokenExpiresAt,
    payload?.tokenExpiresAt,
    payload?.expiresAt,
  ];
  let expiresAt;
  for (const candidate of candidates) {
    const parsed = timestampValue(candidate);
    if (parsed !== undefined) {
      expiresAt = parsed;
      break;
    }
  }
  if (expiresAt === undefined) return 'unknown';
  const remaining = expiresAt - nowMs;
  if (remaining <= 0) return 'expired';
  if (remaining <= 5 * 60 * 1000) return 'within_5m';
  if (remaining <= 60 * 60 * 1000) return 'within_1h';
  if (remaining <= 24 * 60 * 60 * 1000) return 'within_24h';
  return 'over_24h';
}

function lastRefreshWindow(payload, nowMs) {
  const candidates = [
    payload?.account?.lastRefreshAt,
    payload?.lastRefreshAt,
  ];
  let refreshedAt;
  for (const candidate of candidates) {
    const parsed = timestampValue(candidate);
    if (parsed !== undefined) {
      refreshedAt = parsed;
      break;
    }
  }
  if (refreshedAt === undefined) return 'unknown';
  const age = nowMs - refreshedAt;
  if (age < 0) return 'future';
  if (age <= 5 * 60 * 1000) return 'within_5m';
  if (age <= 60 * 60 * 1000) return 'within_1h';
  if (age <= 24 * 60 * 60 * 1000) return 'within_24h';
  return 'over_24h';
}

function preciseTimestamp(value) {
  if (value === null) return null;
  const parsed = timestampValue(value);
  return parsed === undefined ? 'invalid' : parsed;
}

function statusState(payload, nowMs) {
  const publicState = {
    connected: payload?.connected === true,
    reauthenticationRequired: payload?.reauthenticationRequired === true,
    expiresWindow: expiryWindow(payload, nowMs),
    lastRefreshWindow: lastRefreshWindow(payload, nowMs),
  };
  const account = payload?.account && typeof payload.account === 'object' && !Array.isArray(payload.account)
    ? payload.account
    : null;
  const preciseState = {
    ...publicState,
    accountId: typeof account?.id === 'string' ? account.id : null,
    tokenExpiresAt: preciseTimestamp(account?.tokenExpiresAt),
    lastRefreshAt: preciseTimestamp(account?.lastRefreshAt),
  };
  return {
    publicState,
    comparable: JSON.stringify(preciseState),
  };
}

function reportPath(root, mode, timestamp) {
  const safeTimestamp = timestamp.toISOString().replace(/[.:]/g, '-');
  return path.join(root, 'output', 'ws-probe', `${mode}-${safeTimestamp}.json`);
}

function deadlineSignal() {
  return AbortSignal.timeout(DEADLINE_MS);
}

async function readStatus(origin, authHeaders, fetchImpl, nowMs) {
  const response = await fetchImpl(`${origin}/admin/status`, {
    redirect: 'error',
    headers: authHeaders,
    signal: deadlineSignal(),
  });
  const payload = await jsonBody(response);
  const state = statusState(payload, nowMs);
  return { response, state };
}

export async function runProbe({
  root = process.cwd(),
  mode = 'probe',
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  if (!MODES.has(mode)) throw new Error('mode must be probe or disabled');
  const report = { mode, health: {}, status: {}, target: {} };
  let failed = false;

  try {
    const config = parseJsonc(await readFile(path.join(root, 'wrangler.worker.jsonc'), 'utf8'));
    const origin = exactHttpsOrigin(config?.vars?.PUBLIC_ORIGIN);
    const healthResponse = await fetchImpl(`${origin}/health`, {
      redirect: 'error',
      signal: deadlineSignal(),
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
      const authHeaders = { Authorization: `Bearer ${adminApiKey}` };
      const before = await readStatus(origin, authHeaders, fetchImpl, now.getTime());
      report.status.before = {
        statusCode: before.response.status,
        ...before.state.publicState,
      };
      const probeBlocked = mode === 'probe'
        && (!before.response.ok
          || !before.state.publicState.connected
          || before.state.publicState.reauthenticationRequired
          || before.state.publicState.expiresWindow === 'expired');
      if (probeBlocked) {
        failed = true;
      } else {
        let targetPayload = {};
        let targetResponse;
        try {
          targetResponse = await fetchImpl(`${origin}/admin/diagnostics/websocket`, {
            method: 'POST',
            redirect: 'error',
            headers: {
              ...authHeaders,
              'Content-Type': 'application/json',
            },
            body: '{}',
            signal: deadlineSignal(),
          });
          targetPayload = await jsonBody(targetResponse);
          report.target = {
            statusCode: targetResponse.status,
            result: safeResult(targetPayload),
          };
          const code = safeMessageCode(targetPayload);
          if (code) report.target.messageCode = code;
        } catch (error) {
          failed = true;
          report.target = {
            statusCode: null,
            result: {},
            errorKind: error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : 'request_failed',
          };
        }

        const after = await readStatus(origin, authHeaders, fetchImpl, now.getTime());
        report.status.after = {
          statusCode: after.response.status,
          ...after.state.publicState,
        };
        report.status.stable = before.response.ok
          && after.response.ok
          && before.state.comparable === after.state.comparable;
        if (!report.status.stable) failed = true;

        if (targetResponse) {
          const targetResult = report.target.result;
          const valid = mode === 'disabled'
            ? targetResponse.status === 503
              && report.target.messageCode === 'websocket_diagnostic_disabled'
            : targetResponse.ok
              && targetResult.status === 101
              && targetResult.upgraded === true;
          if (!valid) failed = true;
        }
      }
    }
  } catch (error) {
    failed = true;
    report.errorKind = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : 'probe_failed';
  }

  report.passed = !failed;
  const outputPath = reportPath(root, mode, now);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  report.output = path.relative(root, outputPath).replaceAll(path.sep, '/');
  return { report, failed, outputPath };
}

export async function main(argv = process.argv.slice(2)) {
  const mode = argv[0] ?? 'probe';
  try {
    const result = await runProbe({ mode });
    console.log(JSON.stringify(result.report));
    if (result.failed) process.exitCode = 1;
    return result;
  } catch {
    const report = { mode, passed: false, errorKind: 'probe_failed' };
    console.log(JSON.stringify(report));
    process.exitCode = 1;
    return { report, failed: true };
  }
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();
