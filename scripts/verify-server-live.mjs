import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { cleanupWithDeadline } from './cleanup-deadline.mjs';
import { createServerRuntime, readServerConfig, startHttpServer } from '../dist/server/oneapi.mjs';

// Explicit local acceptance only. The transport enforces the upstream budget,
// including preventing the normal account service from refreshing/retrying.
const budget = { models: 1, usage: 1, responses: 2 };
const sent = { models: 0, usage: 0, responses: 0 };
const upstreamControllers = new Set();
let rejected = false, runtime, http, cookie, keyId, settings, baselineIds;
let stage = 'startup';
const emit = value => console.log(JSON.stringify({ evidence: 'SERVER-001', ...value }));
const safeCode = value => typeof value === 'string' && /^[a-z0-9_]{1,100}$/.test(value) ? value : undefined;
const config = readServerConfig();
async function boundedFetch(request) {
  const path = new URL(request.url).pathname;
  const kind = path === '/backend-api/codex/models' ? 'models'
    : path === '/backend-api/wham/usage' ? 'usage' : path === '/backend-api/codex/responses' ? 'responses' : null;
  if (rejected || !kind || sent[kind] >= budget[kind]) throw new Error('acceptance_budget_exhausted');
  sent[kind]++;
  try {
    const controller = new AbortController();
    upstreamControllers.add(controller);
    const response = await fetch(new Request(request, { signal: AbortSignal.any([request.signal, controller.signal]) }));
    if (!response.ok) rejected = true;
    emit({ stage: 'upstream', kind, status: response.status });
    return response;
  } catch (error) { rejected = true; throw error; }
}
async function admin(path, method = 'GET', body) {
  const response = await fetch(http.url.origin + path, { method,
    headers: { Origin: http.url.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30000) });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) { const error = new Error('admin_failed'); error.status = response.status; error.safeCode = safeCode(data?.error?.code); throw error; }
  return { response, data };
}
try {
  emit({ stage: 'budget', budget, retries: 0, refreshes: 0, model: 'gpt-5.5' });
  runtime = await createServerRuntime({ databasePath: config.databasePath, publicDir: resolve('dist/server/public'), config: config.config, fetchImpl: boundedFetch });
  await runtime.ready;
  http = await startHttpServer({ runtime, host: '127.0.0.1', port: 0, publicOrigin: config.config.PUBLIC_ORIGIN });
  stage = 'admin_login';
  const login = await admin('/admin/session', 'POST', { password: config.config.ADMIN_API_KEY });
  cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const status = (await admin('/admin/status')).data;
  assert.equal(status.connected, true); assert.equal(status.reauthenticationRequired, false);
  emit({ stage, connected: true, reauthenticationRequired: false });
  stage = 'models';
  baselineIds = (await admin('/admin/api-keys')).data.data.map(item => item.id).sort();
  const created = (await admin('/admin/api-keys', 'POST', { name: 'server-acceptance-' + randomUUID(),
    modelAccess: { mode: 'allowlist', models: ['gpt-5.5'] }, concurrencyLimit: 1, expiresAt: Date.now() + 3600000 })).data;
  keyId = created.id;
  const client = new OpenAI({ apiKey: created.key, baseURL: http.url.origin + '/v1', maxRetries: 0, timeout: 60000 });
  const models = (await client.models.list()).data;
  assert.deepEqual(models.map(item => item.id), ['gpt-5.5']);

  const capability = models[0].capabilities?.reasoning;
  assert.ok(capability?.supported_efforts?.length);
  const effort = capability.supported_efforts.includes('low') ? 'low' : capability.supported_efforts[0];
  emit({ stage, models: models.map(item => item.id), supportedEfforts: capability.supported_efforts, selectedEffort: effort });
  stage = 'official_usage';
  const usage = (await admin('/admin/usage?refresh=true')).data;
  assert.equal(usage.available, true);
  emit({ stage, available: usage.available, windows: usage.windows });
  settings = (await admin('/admin/log-settings')).data;
  await admin('/admin/log-settings', 'PATCH', { captureBodies: false });
  stage = 'responses';
  const response = await client.responses.create({ model: 'gpt-5.5', input: 'Reply only OK', reasoning: { effort } });
  assert.equal(response.status, 'completed'); assert.ok(response.output_text?.trim());
  emit({ stage, completed: true, textLength: response.output_text.length, usage: response.usage });
  stage = 'chat_stream';
  await admin('/admin/log-settings', 'PATCH', { captureBodies: true });
  const stream = await client.chat.completions.create({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'Reply only OK' }],
    reasoning_effort: effort, stream: true, stream_options: { include_usage: true } });
  let text = '', chatUsage;
  for await (const chunk of stream) { text += chunk.choices[0]?.delta?.content ?? ''; if (chunk.usage) chatUsage = chunk.usage; }
  assert.ok(text.trim());
  emit({ stage, completed: true, textLength: text.length, usage: chatUsage });
  stage = 'logs';
  const logs = (await admin('/admin/logs?keyId=' + encodeURIComponent(keyId))).data.data;
  const basic = logs.find(item => item.protocol === 'responses' && item.outcome === 'completed');
  const full = logs.find(item => item.protocol === 'chat' && item.outcome === 'completed');
  assert.ok(basic && full); assert.equal(basic.bodyCaptured, false); assert.equal(full.bodyCaptured, true);
  const detail = (await admin('/admin/logs/' + full.id)).data;
  assert.ok(detail.requestBody && detail.responseBody);
  assert.equal(detail.requestBody.reasoning_effort, effort);
  assert.equal(basic.usage.inputTokens, response.usage.input_tokens);
  assert.equal(full.usage.outputTokens, chatUsage.completion_tokens);
  emit({ stage, basic: true, completeBodies: true, tokenUsageMatched: true, sent, completed: true });
} catch (error) {
  emit({ stage, failed: true, status: error.status, code: safeCode(error.safeCode ?? error.code), type: error.name, sent });
  process.exitCode = 1;
} finally {
  await cleanupWithDeadline(async () => {
  for (const controller of upstreamControllers) controller.abort();
  if (settings && cookie) {
    try { await admin('/admin/log-settings', 'PATCH', { captureBodies: settings.captureBodies }); emit({ stage: 'restore_log_settings', restored: true }); }
    catch { emit({ stage: 'restore_log_settings', failed: true }); process.exitCode = 1; }
  }
  if (keyId && cookie) {
    try {
      await admin('/admin/api-keys/' + keyId, 'DELETE', {});
      const after = (await admin('/admin/api-keys')).data.data.filter(item => item.id !== keyId).map(item => item.id).sort();
      assert.deepEqual(after, baselineIds);
      emit({ stage: 'cleanup_key', revoked: true, existingKeysPreserved: true });
    } catch { emit({ stage: 'cleanup_key', failed: true }); process.exitCode = 1; }
  }
  if (cookie) { try { await admin('/admin/session', 'DELETE', {}); emit({ stage: 'close_session', closed: true }); } catch { emit({ stage: 'close_session', failed: true }); process.exitCode = 1; } }
  await http?.close(); await runtime?.dispose();
  emit({ stage: 'close_runtime', closed: true });
  }, emit);
}
