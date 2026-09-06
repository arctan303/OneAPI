import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';

const url = new URL(process.env.ONEAPI_BASE_URL ?? 'http://127.0.0.1:8787');
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Only loopback HTTP origin is allowed');
const base = url.origin;
const model = process.env.ONEAPI_MODEL ?? 'gpt-5.5';
const modelsOnly = process.argv.includes('--models-only');
const allowedEnvFiles = new Set(['.dev.vars', 'test/mock.env']);
const envFile = process.env.ONEAPI_TEST_ENV_FILE ?? '.dev.vars';
if (!allowedEnvFiles.has(envFile)) throw Error('Unsupported environment file');
const vars = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter(x => x.includes('=') && !x.startsWith('#')).map(x => { const i = x.indexOf('='); return [x.slice(0, i).trim(), x.slice(i + 1).trim()]; }));
let cookie;
let keyId;
let stage = 'admin_login';
const evidence = (value) => console.log(JSON.stringify(value));
evidence({ stage: "client_request_budget", models: 1, generations: modelsOnly ? 0 : 1, sdkRetries: 0, model: modelsOnly ? undefined : model });
async function admin(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) { const error = Error('Request rejected'); error.status = response.status; error.safeCode = /^[a-z0-9_]{1,100}$/.test(data?.error?.code ?? '') ? data.error.code : undefined; throw error; }
  return { response, data };
}
try {
  const login = await admin('/admin/session', 'POST', { password: vars.ADMIN_API_KEY });
  cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw Error('No session');
  evidence({ stage, status: login.response.status });
  stage = 'account_status';
  const { data: status } = await admin('/admin/status');
  evidence({ stage, connected: status.connected, reauthenticationRequired: status.reauthenticationRequired });
  if (!status.connected || status.reauthenticationRequired) throw Error('Account connection required');
  stage = 'admin_models';
  const { data: models } = await admin('/admin/test/models');
  const ids = models.data.map(x => x.id);
  evidence({ stage, status: 200, models: ids });
  if (!modelsOnly) {
    if (!ids.includes(model)) throw Error('Selected model absent from account directory');
    stage = 'create_api_key';
    const created = await admin('/admin/api-keys', 'POST', { name: 'live-check-' + randomUUID() });
    keyId = created.data.id;
    evidence({ stage, status: created.response.status });
    const client = new OpenAI({ apiKey: created.data.key, baseURL: base + '/v1', maxRetries: 0, timeout: 60000 });
    stage = 'key_generation';
    const result = await client.responses.create({ model, input: 'Reply with exactly LIVE_OK' });
    const text = result.output_text ?? result.output?.flatMap(x => x.content ?? []).filter(x => x.type === 'output_text').map(x => x.text).join('');
    evidence({ stage: 'generation_shape', responseStatus: result.status ?? null, outputTextLength: typeof result.output_text === 'string' ? result.output_text.length : null, outputItems: Array.isArray(result.output) ? result.output.map(item => ({ type: item.type, role: item.role, status: item.status, content: Array.isArray(item.content) ? item.content.map(part => ({ type: part.type, textLength: typeof part.text === 'string' ? part.text.length : null })) : undefined })) : null });
    if (result.status !== 'completed' || !text?.trim()) throw Error('No completed text response');
    evidence({ stage, model, responseStatus: result.status, textLength: text.length, exactReply: text.trim() === 'LIVE_OK' });
  }
} catch (error) {
  evidence({ stage, failed: true, status: error.status, code: error.safeCode, type: error.name });
  process.exitCode = 1;
} finally {
  if (keyId) {
    try { const r = await admin('/admin/api-keys/' + keyId, 'DELETE', {}); evidence({ stage: 'revoke_test_key', status: r.response.status }); }
    catch { evidence({ stage: 'revoke_test_key', failed: true, keyId }); process.exitCode = 1; }
  }
  if (cookie) {
    try { const r = await admin('/admin/session', 'DELETE', {}); evidence({ stage: 'close_test_session', status: r.response.status }); }
    catch { evidence({ stage: 'close_test_session', failed: true }); process.exitCode = 1; }
  }
}