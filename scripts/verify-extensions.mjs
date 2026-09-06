import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { createRuntime } from './dev-local.mjs';

// Default is an isolated Mock runtime; --live uses two generations, --reasoning-only uses one.
const live = process.argv.includes('--live');
const reasoningOnly = process.argv.includes('--reasoning-only');
const withReasoning = reasoningOnly || process.argv.includes('--reasoning') || !live;
const readOnly = process.argv.includes('--read-only');
const emit = value => console.log(JSON.stringify({ evidence: 'phase01', ...value }));
let base = 'http://127.0.0.1:8787', runtime, tempRoot, cookie, settings, baselineIds;
const createdIds = [];
let stage = 'setup';
const model = live ? 'gpt-5.5' : 'gpt-mock';
async function admin(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method, headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000)
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) { const e = new Error('Admin request rejected'); e.status = response.status; e.safeCode = data?.error?.code; throw e; }
  return { response, data };
}
async function expectDenied(key, path, body, statuses = [403]) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(20000)
  });
  assert.ok(statuses.includes(response.status), 'Expected local authorization rejection');
  await response.arrayBuffer();
  return response.status;
}
try {
  if (!live) {
    tempRoot = await mkdtemp(resolve(tmpdir(), 'oneapi-phase01-'));
    runtime = await createRuntime({ useMock: true, persistRoot: tempRoot, requestedPort: 0 });
    base = (await runtime.ready).origin;
  }
  const vars = Object.fromEntries(readFileSync(live ? '.dev.vars' : '.dev.vars.test', 'utf8').split(/\r?\n/).filter(x => x.includes('=') && !x.startsWith('#')).map(x => { const i = x.indexOf('='); return [x.slice(0,i).trim(), x.slice(i+1).trim()]; }));
  stage = 'login';
  const login = await admin('/admin/session', 'POST', { password: vars.ADMIN_API_KEY });
  cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Admin cookie missing');
  if (!live) {
    const start = (await admin('/admin/device/start', 'POST', {})).data;
    await new Promise(r => setTimeout(r, Math.max(30, start.nextPollAt - Date.now() + 5)));
    assert.equal((await admin('/admin/device/poll', 'POST', { login_id: start.id })).data.status, 'connected');
  }
  stage = 'account_and_official_quota';
  const status = (await admin('/admin/status')).data;
  assert.equal(status.connected, true);
  assert.equal(status.reauthenticationRequired, false);
  const quota = (await admin('/admin/usage?refresh=true')).data;
  emit({ stage, connected: true, hasEmail: Boolean(status.account?.email), plan: status.account?.plan ?? null,
    quota: { available: quota.available, fetchedAt: quota.fetchedAt, lastSuccessAt: quota.lastSuccessAt,
      windows: quota.windows, additional: quota.additional, errorCode: quota.error?.code ?? null } });
  if (!quota.available) process.exitCode = 1; // Continue independent capabilities, but never claim quota passed.
  if (!readOnly) {
    stage = 'catalog_and_key';
    const catalogEntries = (await admin('/admin/test/models')).data.data;
    const catalog = catalogEntries.map(x => x.id);
    const capability = catalogEntries.find(x => x.id === model)?.capabilities?.reasoning;
    let effort;
    if (withReasoning) {
      assert.ok(Array.isArray(capability?.supported_efforts) && capability.supported_efforts.length, 'Reasoning capability absent');
      effort = capability.supported_efforts.includes('low') ? 'low' : capability.supported_efforts[0];
      emit({ stage: 'reasoning_capabilities', model, supported: capability.supported_efforts, defaultEffort: capability.default_effort, selectedEffort: effort });
    }
    assert.ok(catalog.includes(model), 'Selected model absent');
    baselineIds = (await admin('/admin/api-keys')).data.data.map(x => x.id).sort();
    settings = (await admin('/admin/log-settings')).data;
    await admin('/admin/log-settings', 'PATCH', { captureBodies: false });
    const key = (await admin('/admin/api-keys', 'POST', {
      name: 'phase01-check-' + randomUUID(), modelAccess: { mode: 'allowlist', models: [model] },
      concurrencyLimit: 1, expiresAt: Date.now() + 3600000
    })).data;
    createdIds.push(key.id);
    const client = new OpenAI({ apiKey: key.key, baseURL: base + '/v1', maxRetries: 0, timeout: 60000 });
    const keyModels = (await client.models.list()).data;
    assert.deepEqual(keyModels.map(x => x.id), [model]);
    if (withReasoning) assert.deepEqual(keyModels[0].capabilities.reasoning, capability);
    const forbidden = catalog.find(x => x !== model) ?? 'not-allowed-model';
    await expectDenied(key.key, '/v1/responses', { model: forbidden, input: 'must not run' });
    await expectDenied(key.key, '/v1/chat/completions', { model: forbidden, messages: [{ role: 'user', content: 'must not run' }] });
    await expectDenied(key.key, '/admin/logs', undefined, [401]);
    emit({ stage, filteredModels: [model], protocolsDenyOtherModels: true, logsAdminOnly: true });

    if (withReasoning) {
      await expectDenied(key.key, '/v1/responses', { model, input: 'must not run', reasoning: { effort: 'invalid-fixture' } }, [400]);
      await expectDenied(key.key, '/v1/chat/completions', { model, messages: [{role:'user',content:'must not run'}], reasoning_effort: 'invalid-fixture' }, [400]);
    }
    let logs;
    emit({ stage: 'generation_budget', live, model, plannedGenerations: reasoningOnly ? 1 : 2, sdkRetries: 0 });
    if (!reasoningOnly) {
    stage = 'responses_basic_log';
    const result = await client.responses.create({ model, input: 'Reply with exactly PHASE1_OK', ...(effort ? { reasoning: { effort } } : {}) });
    assert.equal(result.status, 'completed');
    assert.ok(result.output_text?.trim(), 'No response text');
    logs = (await admin('/admin/logs?keyId=' + key.id)).data.data;
    const basic = logs.find(x => x.outcome === 'completed' && x.protocol === 'responses');
    assert.ok(basic, 'Completed Responses log absent');
    assert.equal(basic.bodyCaptured, false);
    const basicDetail = (await admin('/admin/logs/' + basic.id)).data;
    assert.equal(basicDetail.requestBody, null);
    assert.equal(basicDetail.responseBody, null);
    assert.equal(basic.usage.inputTokens, result.usage?.input_tokens ?? null);
    assert.equal(basic.usage.outputTokens, result.usage?.output_tokens ?? null);
    emit({ stage, textLength: result.output_text.length, usage: basic.usage, bodiesAbsent: true, requestedEffort: effort ?? null });
    }

    stage = 'chat_stream_full_log';
    await admin('/admin/log-settings', 'PATCH', { captureBodies: true });
    const stream = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with exactly PHASE1_CHAT' }], stream: true, stream_options: { include_usage: true }, ...(effort ? { reasoning_effort: effort } : {}) });
    let text = '', usage = null;
    for await (const chunk of stream) { text += chunk.choices[0]?.delta?.content ?? ''; if (chunk.usage) usage = chunk.usage; }
    assert.ok(text.trim(), 'No streamed text');
    logs = (await admin('/admin/logs?keyId=' + key.id)).data.data;
    const full = logs.find(x => x.outcome === 'completed' && x.protocol === 'chat');
    assert.ok(full, 'Completed Chat log absent');
    const detail = (await admin('/admin/logs/' + full.id)).data;
    assert.equal(full.bodyCaptured, true);
    assert.ok(detail.requestBody && detail.responseBody, 'Full log bodies absent');
    if (withReasoning) assert.equal(detail.requestBody.reasoning_effort, effort);
    assert.equal(full.usage.inputTokens, usage?.prompt_tokens ?? null);
    assert.equal(full.usage.outputTokens, usage?.completion_tokens ?? null);
    const serialized = JSON.stringify(detail);
    for (const secret of [key.key, cookie, vars.ADMIN_API_KEY, vars.GATEWAY_API_KEY, vars.TOKEN_ENCRYPTION_KEY]) if (secret) assert.ok(!serialized.includes(secret), 'Secret found in log');
    emit({ stage, textLength: text.length, usage: full.usage, bodyCaptured: true, responseTruncated: full.responseTruncated, requestedEffort: effort ?? null });

    stage = 'key_disable_restore';
    await admin('/admin/api-keys/' + key.id, 'PATCH', { enabled: false });
    await expectDenied(key.key, '/v1/models', undefined, [401,403]);
    await admin('/admin/api-keys/' + key.id, 'PATCH', { enabled: true });
    assert.deepEqual((await client.models.list()).data.map(x => x.id), [model]);
    await admin('/admin/api-keys/' + key.id, 'DELETE', {}); createdIds.pop();
    assert.ok((await admin('/admin/logs?keyId=' + key.id)).data.data.length >= 2, 'Deleted key lost history');
    emit({ stage, disabledRejected: true, restoredModels: true, deletedKeyHistoryRetained: true });
  }
  emit({ stage: 'complete', live, quotaAvailable: quota.available });
} catch (error) {
  emit({ stage, failed: true, type: error.name, status: error.status, code: /^[a-z0-9_]{1,100}$/.test(error.safeCode ?? '') ? error.safeCode : undefined });
  process.exitCode = 1;
} finally {
  for (const id of createdIds) { try { await admin('/admin/api-keys/' + id, 'DELETE', {}); } catch { emit({ stage: 'cleanup_key', failed: true, id }); process.exitCode = 1; } }
  if (settings) { try { await admin('/admin/log-settings', 'PATCH', settings); } catch { emit({ stage: 'restore_log_settings', failed: true }); process.exitCode = 1; } }
  if (baselineIds) { try { assert.deepEqual((await admin('/admin/api-keys')).data.data.map(x => x.id).sort(), baselineIds); emit({ stage: 'key_baseline_restored', passed: true }); } catch { emit({ stage: 'key_baseline_restored', failed: true }); process.exitCode = 1; } }
  if (cookie) { try { await admin('/admin/session', 'DELETE', {}); } catch { emit({ stage: 'close_session', failed: true }); process.exitCode = 1; } }
  await runtime?.dispose();
  if (tempRoot) { const target = resolve(tempRoot); assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('oneapi-phase01-')); await rm(target, { recursive: true, force: true }); }
}
