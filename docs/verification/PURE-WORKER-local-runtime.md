# PURE-WORKER local runtime

Research date: 2026-09-07. Scope: local source inspection and an in-memory Miniflare fixture only. No account credentials, external network, deployment, or upstream request was used.

## Determination

The local Node launcher and the deployed Worker do not exercise the same outbound path.

In `scripts/dev-local.mjs`, `createRuntime()` sets `useLocalOutbound = !useMock || Boolean(localOutboundFetch)`, injects the `ONEAPI_LOCAL_OUTBOUND` service binding, and installs an `outboundService` that throws if the Worker tries to bypass that private binding. The app's `src/local-outbound.ts` uses the binding when it exists and falls back to the Worker global `fetch(request)` only when the binding is undefined. Therefore:

- Normal non-mock `scripts/dev-local.mjs` requests go through the Node `createNodeOutbound()` allowlist, not through the default global outbound service.
- `wrangler.worker.jsonc` declares no `ONEAPI_LOCAL_OUTBOUND` binding, so a deployed Worker falls back to its normal global `fetch()` path.
- Mock Vitest uses `wrangler.mock.jsonc` and `MOCK_UPSTREAM`; it is not evidence about production outbound headers.

The comment in `scripts/dev-local.mjs` that Miniflare normally adds `CF-Worker` before a custom outbound service is accurate only when the Miniflare outbound interceptor is configured to add it. This launcher explicitly sets `stripCfConnectingIp: false`.

## Miniflare source evidence

Installed Miniflare version: `5.20260903.0-alpha`.

Its bundled `dist/src/workers/core/outbound.worker.js` implements the relevant branch:

- If `STRIP_CF_CONNECTING_IP` is false, it forwards the request headers unchanged.
- Otherwise it deletes `CF-Connecting-IP` and sets `CF-Worker` to `CF_WORKER_ZONE`.
- The default `CF_WORKER_ZONE` is derived from the Worker name and is `worker.example.com` in the fixture below.
- Miniflare's `DevConfigSchema` defaults `stripCfConnectingIp` to true. `cf: false` is a separate option that disables fetching the `Request#cf` object; it does not disable the outbound header branch.

The same bundled source documents the global outbound default as the `internet` service, while `outboundService` overrides that service. A service binding is a separate in-process handler and should not be treated as proof of global-fetch behavior.

## In-memory verification

A temporary Miniflare fixture used a custom in-memory `outboundService` that returned only the received `cf-worker` and `cf-connecting-ip` values. The Worker called `fetch("https://example.com/")`; no network connection was enabled.

With `cf: false) in both runs:

- `stripCfConnectingIp: false` produced `{"cfWorker":null,"cfConnectingIp":null}`.
- `stripCfConnectingIp: true` produced `{"cfWorker":"worker.example.com","cfConnectingIp":null}`.

This isolates the cause: `cf:false` does not explain the marker difference; `stripCfConnectingIp` controls it in this local interceptor.

## Wrangler and Cloudflare documentation

The project configs support the source distinction:

- [wrangler.jsonc](../../wrangler.jsonc) has no outbound service or local Node binding.
- [wrangler.worker.jsonc](../../wrangler.worker.jsonc) has no `ONEAPI_LOCAL_OUTBOUND` binding.
- [wrangler.mock.jsonc](../../wrangler.mock.jsonc) supplies mock upstream variables.
- [vitest.config.ts](../../vitest.config.ts) selects `wrangler.mock.jsonc` and `MOCK_UPSTREAM`.

Cloudflare's primary Miniflare documentation confirms that Miniflare can dispatch Workers and simulate local connections without making actual HTTP requests, and that custom service binding functions can be implemented entirely in process: [Miniflare Get Started](https://developers.cloudflare.com/workers/testing/miniflare/get-started/). Its outbound mocking guide supports custom responses and disabling network connections with `MockAgent`: [Mocking outbound fetch requests](https://developers.cloudflare.com/workers/testing/miniflare/core/standards/). The Fetch Events guide says test callers are responsible for supplying `CF-*` headers on dispatched incoming requests, which is separate from the outbound interceptor's `CF-Worker` behavior: [Fetch Events](https://developers.cloudflare.com/workers/testing/miniflare/core/fetch/).

## Verified boundary and remaining evidence gap

The in-memory header-echo check above has already verified the local Miniflare branch; repeating it is not a repair proposal. It proves only that stripCfConnectingIp controls the marker in this configured local interceptor, while cf: false controls the separate Request#cf data path.

The remaining gap is the original wrangler dev default path as a whole: this source review did not run a default Wrangler process against an echo destination, and no external or upstream request was made. Therefore the local launcher evidence cannot be promoted to a claim about deployed Worker egress or a platform-supported way to remove CF-Worker.
