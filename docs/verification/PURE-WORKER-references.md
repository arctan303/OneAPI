# PURE-WORKER references

Research date: 2026-09-07. Scope: public GitHub material only. No account credentials, real upstream requests, deployments, or production traffic were used.

## Finding

I found no public GitHub project that proves a successful direct call from a Cloudflare Worker to the ChatGPT Codex subscription endpoint. The strongest direct Worker evidence is a controlled failure report: in one Node process, one credential, and two back-to-back requests, the request without `CF-Worker` returned HTTP 200 while the same process's request with a manually added `CF-Worker` returned HTTP 403 with an HTML Cloudflare block. Projects that claim Worker support generally provide source or README deployment instructions, but I found no independently reproducible Worker success log or issue that rules out a Node, a WASM host, a Vercel proxy, or another egress service.

The relevant subscription paths seen in the material are:

- `POST https://chatgpt.com/backend-api/codex/responses`
- `GET https://chatgpt.com/backend-api/codex/models?client_version=...`
- `GET https://chatgpt.com/backend-api/wham/usage`

These are ChatGPT/Codex backend routes. They are distinct from the public OpenAI API-key surface at `https://api.openai.com/v1`.

## Candidate review

### 1. ColeMurray/background-agents — direct Worker attempt, failed

Sources:

- [Issue #1374](https://github.com/ColeMurray/background-agents/issues/1374)
- [Revert PR #1375](https://github.com/ColeMurray/background-agents/pull/1375), including the stated causal comparison and rollback commits

The control plane called `https://chatgpt.com/backend-api/codex/responses` directly from a Cloudflare Worker. The report's key single-variable comparison is within one Node process: no `CF-Worker` header produced `200 api-response`; manually adding `CF-Worker: anything.workers.dev` produced `403 HTML block`. It reports four suppression attempts (omit, empty, spoofed, and `Headers.delete()`) still arriving with the real platform value. It also reports that local `wrangler dev` without `--remote` remained blocked while plain Node on the same machine succeeded.

Assessment: **high evidence for a direct Worker failure report; no evidence for success**. This is a third-party report, not a diagnosis of this project and not an OpenAI guarantee; its runtime/upstream state can change.

OAuth/API-key distinction: the report describes a ChatGPT subscription credential and separately rules out stale credentials, user-agent choice, path spelling, and IP reputation. It does not use an OpenAI Platform API key as the causal variable.

### 2. ljoukov/llm — Worker OAuth token provider, optional proxy

Sources:

- [Repository README](https://github.com/ljoukov/llm)
- [Cloudflare Worker token provider](https://github.com/ljoukov/llm/tree/main/workers/chatgpt-auth)
- [Responses endpoint configuration in the README](https://github.com/ljoukov/llm#chatgpt-subscription-models)

The repository supports `chatgpt-*` models and defaults the direct endpoint to `chatgpt.com/backend-api/codex/responses`. Its Cloudflare Worker under `workers/chatgpt-auth/` is a D1-backed OAuth account/token provider: it stores and refreshes subscription accounts and exposes short-lived tokens to callers. The README separately documents an optional Vercel `codex-proxy`; when that setting is used, the request goes through that proxy.

Assessment: **medium evidence for a useful Worker OAuth control plane; no evidence that the Worker itself successfully reaches Codex directly**. The README is a moving branch reference in the current crawl; it is not treated as a pinned deployment result. The token provider and the optional Vercel proxy are hidden infrastructure differences that prevent this from being proof of pure Worker egress.

OAuth/API-key distinction: `chatgpt-*` uses Codex/ChatGPT OAuth state; `OPENAI_API_KEY` belongs to the public OpenAI provider. The Worker admin/caller secret is also separate from the subscription access token.

### 3. dvcrn/codex-oauth-proxy — Go/WASM Worker target, no live success proof

Sources pinned to commit `c43ed9143c56dd968f82cb345f58da0c8b05729d`:

- [README](https://github.com/dvcrn/codex-oauth-proxy/blob/c43ed9143c56dd968f82cb345f58da0c8b05729d/README.md)
- [Worker/runtime design notes](https://github.com/dvcrn/codex-oauth-proxy/blob/c43ed9143c56dd968f82cb345f58da0c8b05729d/CLAUDE.md)
- [Native request client](https://github.com/dvcrn/codex-oauth-proxy/blob/c43ed9143c56dd968f82cb345f58da0c8b05729d/internal/server/client.go)
- [Workers request client](https://github.com/dvcrn/codex-oauth-proxy/blob/c43ed9143c56dd968f82cb345f58da0c8b05729d/internal/server/client_workers.go)

The project is a Go proxy using Codex CLI OAuth credentials and forwarding to `chatgpt.com/backend-api/codex/responses`. The pinned request sources show a native `net/http` transport with a `net.Dialer` in `client.go`, versus `fetch.NewRequest` and `fetch.Client` in the `js && wasm` build in `client_workers.go`. The notes describe a Cloudflare Workers build using `github.com/syumai/workers` and WebAssembly build tags. WASM inside Workers is an in-runtime build target, not an external host or proxy.

Assessment: **medium source-level evidence for an intended Worker build; no deployment transcript, live response, or issue demonstrating direct Worker success**. The presence of a Worker target does not establish that the ChatGPT edge accepts the resulting request or that a hidden host/proxy is absent.

OAuth/API-key distinction: upstream auth is Codex CLI OAuth; the downstream proxy's `ADMIN_API_KEY` is an independent client-auth secret.

### 4. GewoonJaap/codex-openai-wrapper — Worker deployment recipe, mixed auth surfaces

Sources pinned to commit `5fc929e01943634b5688e376f5225f2ffac0d327`:

- [README](https://github.com/GewoonJaap/codex-openai-wrapper/blob/5fc929e01943634b5688e376f5225f2ffac0d327/README.md)
- [Latest commit page](https://github.com/GewoonJaap/codex-openai-wrapper/commit/5fc929e01943634b5688e376f5225f2ffac0d327)
- [Pinned upstream request source](https://github.com/GewoonJaap/codex-openai-wrapper/blob/5fc929e01943634b5688e376f5225f2ffac0d327/src/upstream.ts)

The README advertises Cloudflare Workers, OAuth2 credentials from Codex CLI, automatic refresh/KV storage, and `CHATGPT_RESPONSES_URL=https://chatgpt.com/backend-api/codex/responses`. The pinned `src/upstream.ts` source constructs the Codex request and calls the global `fetch(requestUrl, ...)` with the OAuth access token and account header; it retries once after a 401 refresh. The same source allows the configured URL to point elsewhere for other modes, so this does not prove every deployment used the subscription endpoint. The deployment recipe is `npm run deploy`, but the material contains no successful Worker response capture, reproducible CI deployment artifact, or issue validating the direct subscription path.

Assessment: **low-to-medium evidence for an intended implementation; not evidence of pure Worker success**. The downstream API key, OAuth JSON, and upstream endpoint are separate concerns. A successful wrapper request would need to show which bearer reaches ChatGPT and from which runtime; README examples alone cannot establish that.

OAuth/API-key distinction: `OPENAI_API_KEY` protects the wrapper's client-facing endpoint; `OPENAI_CODEX_AUTH` is the Codex OAuth credential used upstream. Confusing the two would make a Worker smoke test prove only wrapper authentication. A downstream key that happens to look like `sk-...` cannot establish upstream billing or the upstream bearer.

### 5. openai/codex — official native baseline, not a Worker candidate

Sources pinned to commit `121f91fd5d9dc66017866ce9bdc49f1e182721df`:

- [App-server README](https://github.com/openai/codex/blob/121f91fd5d9dc66017866ce9bdc49f1e182721df/codex-rs/app-server/README.md)
- [Pinned commit](https://github.com/openai/codex/commit/121f91fd5d9dc66017866ce9bdc49f1e182721df)

The official app-server documentation distinguishes ChatGPT-managed authentication (browser/device login, refresh tokens, and local persistence) from API-key authentication. The repository is a native Rust/Node-oriented Codex implementation; it is not a Cloudflare Worker deployment and therefore cannot prove pure-Worker egress.

Assessment: **high evidence for the OAuth/runtime baseline; not evidence for Worker behavior**. It is useful as the control case when comparing a successful native request with a Worker request.

## Runtime and protocol observations

- A README claim that a project is “on Cloudflare” is deployment intent, not proof that a ChatGPT subscription request succeeded from a Worker.
- A Worker OAuth token provider can be fully successful while a separate Worker direct fetch to `chatgpt.com` is blocked. Token issuance and upstream egress must be tested independently.
- A Vercel proxy, local Node process, or Go native binary changes the egress/runtime question. A WASM module running inside Workers does not by itself add an external host. Such a project can still be useful, but it is not a pure-Worker result unless the actual Worker request is evidenced.
- ChatGPT/Codex OAuth and OpenAI Platform API keys are different billing/authentication surfaces. A downstream wrapper key that happens to look like `sk-...` cannot establish which bearer reached ChatGPT or which service accounts the upstream request.

## Next useful check for this project

PURE-WORKER-001 compares four fixed synthetic requests to our own collector: Node, local workerd, deployed Worker, and its ProbeDO. This records platform marker presence and available transport metadata without account credentials. It can test whether our environment exhibits relevant differences; it cannot reproduce ChatGPT rejection at a receiver with different rules.

Manually adding a header and observing that an echo server returns it would not establish causality for this 403. Repeating published header-suppression attempts is not included in the current budget. EGRESS-001 already fixed the credential and business request, so another payload comparison is not a new pure-Worker hypothesis. No source-backed change that is presently shown to make direct Worker requests succeed was identified in this bounded search.
## Evidence boundary

As of the research date, the evidence supports: native Codex/Node OAuth paths exist; Worker OAuth token services exist; at least one direct Worker-to-Codex attempt was blocked by a platform-stamped header; and Worker-targeted proxy source exists without independent success proof. It does not support promising a pure Cloudflare Worker direct path or claiming that `nodejs_compat` changes that boundary.
