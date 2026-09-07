import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runProbe } from './probe-worker-upstream.mjs';


async function fixture(fetchImpl) {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-worker-upstream-'));
  await writeFile(path.join(root, 'wrangler.worker.jsonc'), `{
    // JSONC is accepted by the probe.
    "vars": { "PUBLIC_ORIGIN": "https://probe.example" },
  }\n`);
  await writeFile(path.join(root, '.dev.vars.worker'), 'ADMIN_API_KEY=fixture-admin-key\n');
  return { root, fetchImpl };
}

function response(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('health is the first request and carries no credentials', async () => {
  const calls = [];
  const { root, fetchImpl } = await fixture(async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? response(200, { ok: true, service: 'oneapi-codex-gateway-demo' })
      : response(200, { available: true, models: [{ id: 'gpt-5.5' }] });
  });
  try {
    const result = await runProbe({ root, fetchImpl, now: new Date('2026-09-07T00:00:00.000Z') });
    assert.equal(result.failed, false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://probe.example/health');
    assert.equal(calls[0].init.headers, undefined);
    assert.equal(calls[1].url, 'https://probe.example/admin/test/models');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer fixture-admin-key');
    assert.equal(result.report.target.available, true);
    assert.equal(result.report.target.modelCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('available false is a failed usage probe and diagnostics are whitelisted', async () => {
  const calls = [];
  const { root, fetchImpl } = await fixture(async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? response(200, { ok: true, service: 'oneapi-codex-gateway-demo' })
      : response(200, {
        available: false,
        usage: {
          prompt_tokens: 4,
          completion_tokens: 2,
          total_tokens: 6,
          usage_details: {
            total_tokens: 6,
            access_token: 'nested-secret-sentinel',
            deeper_usage: { refresh_token: 'nested-secret-sentinel', authorization: 'nested-secret-sentinel' },
          },
          secret: 'must-not-print',
        },
        error: { diagnostic: { event: 'upstream_error', status: 403, secret: 'must-not-print', html: '<html>' } },
      });
  });
  try {
    const result = await runProbe({ root, mode: 'usage', fetchImpl, now: new Date('2026-09-07T00:00:00.000Z') });
    assert.equal(result.failed, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://probe.example/admin/usage?refresh=true');
    assert.deepEqual(result.report.target.usage, {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
      usage_details: { total_tokens: 6 },
    });
    assert.deepEqual(result.report.target.diagnostic, { event: 'upstream_error', status: 403 });
    const serializedReport = JSON.stringify(result.report);
    const saved = await readFile(result.outputPath, 'utf8');
    assert.equal(serializedReport.includes('nested-secret-sentinel'), false);
    assert.equal(saved.includes('nested-secret-sentinel'), false);
    assert.equal(saved.includes('must-not-print'), false);
    assert.equal(saved.includes('<html>'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP 403 fails without exposing the plain API error message', async () => {
  const calls = [];
  const { root, fetchImpl } = await fixture(async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? response(200, { ok: true, service: 'oneapi-codex-gateway-demo' })
      : response(403, {
        error: {
          code: 'UPSTREAM_FORBIDDEN',
          message: 'secret raw upstream HTML should not appear',
          diagnostic: { event: 'upstream_error', bodySha256: 'abc123', raw: 'forbidden' },
        },
      });
  });
  try {
    const result = await runProbe({ root, fetchImpl, now: new Date('2026-09-07T00:00:00.000Z') });
    assert.equal(result.failed, true);
    assert.equal(result.report.target.statusCode, 403);
    assert.equal(result.report.target.messageCode, 'UPSTREAM_FORBIDDEN');
    assert.deepEqual(result.report.target.diagnostic, { event: 'upstream_error', bodySha256: 'abc123' });
    assert.equal('message' in result.report.target, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generate sends the bounded body and records one attempt with summary only', async () => {
  const calls = [];
  const { root, fetchImpl } = await fixture(async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? response(200, { ok: true, service: 'oneapi-codex-gateway-demo' })
      : response(200, { available: true, output_text: 'OK', usage: { total_tokens: 3 } });
  });
  try {
    const result = await runProbe({ root, mode: 'generate', fetchImpl, now: new Date('2026-09-07T00:00:00.000Z') });
    assert.equal(result.failed, false);
    assert.equal(calls[1].url, 'https://probe.example/admin/test/responses');
    assert.deepEqual(JSON.parse(calls[1].init.body), { model: 'gpt-5.5', input: 'Reply only OK', stream: false });
    assert.equal(calls[1].init.headers.Authorization, 'Bearer fixture-admin-key');
    assert.equal(calls[1].init.headers.reasoning, undefined);
    assert.equal(result.report.generationsAttempts, 1);
    assert.equal(result.report.target.responseChars, 2);
    assert.deepEqual(result.report.target.usage, { total_tokens: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
