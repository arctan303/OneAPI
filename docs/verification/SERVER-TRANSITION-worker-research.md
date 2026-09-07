# SERVER-TRANSITION: New Codex OAuth / Cloudflare research

Research date: 2026-09-07. Scope: public GitHub repositories, pinned commit source, and public issues only. No account credentials were read, no candidate was run, no Codex upstream request was made, and no Worker was deployed. Existing candidates in PURE-WORKER-references.md (ljoukov/llm, dvcrn/codex-oauth-proxy, GewoonJaap/codex-openai-wrapper, and ColeMurray/background-agents #1374) are not repeated.

## Conclusion

This bounded search found no new, reproducible proof of a pure Cloudflare Worker directly calling the ChatGPT/Codex subscription endpoint with OAuth and receiving a successful model response.

The new material falls into three groups:

- A browser-extension author records a same-process comparison where a request without CF-Worker reaches the authentication layer, while the manually marked request receives 403; the product routes Codex through Google Cloud Functions, not a Cloudflare Worker.
- Several newer proxies use Codex OAuth but run as local Go/Python/native HTTP services. One explicitly uses curl_cffi Chrome TLS impersonation.
- New OpenClaw issues separate OAuth login validity, request-shape validation, local/native transport, and Cloudflare challenges. One issue reports a same-host curl 200 SSE after correcting the Codex body shape; it is not Worker evidence.

The evidence supports continued no-token marker and payload-shape observations. It does not justify upgrading a README or a local success report into pure Worker success, and it does not prove that every single-Worker route is impossible.

## New candidates and evidence

### 1. mlava/chief-of-staff

Pinned commit: 8d876f420c8d182b4c3d41dbcb9d72d7f9ffcd54 (2026-09-02).

Sources:

- [Codex OAuth client](https://github.com/mlava/chief-of-staff/blob/8d876f420c8d182b4c3d41dbcb9d72d7f9ffcd54/src/oauth-client.js)
- [CORS and transport diagnostic source](https://github.com/mlava/chief-of-staff/blob/8d876f420c8d182b4c3d41dbcb9d72d7f9ffcd54/src/cors-proxy.js)
- [Pinned commit](https://github.com/mlava/chief-of-staff/commit/8d876f420c8d182b4c3d41dbcb9d72d7f9ffcd54)

The source and README distinguish ChatGPT subscription device OAuth from API-key providers. The pinned src/cors-proxy.js records the author's comparison: the same curl request without CF-Worker returned 401 (reached authentication), while adding CF-Worker returned 403. It also says the actual product uses Roam's shared Google Cloud Functions proxy, and that a user's own Cloudflare Worker was tried and failed.

Assessment: high-value new failure lead, medium evidence; not pure Worker success. It is a third-party author report, without a complete archived request/response set or independent reproduction.

Runtime/proxy: browser extension plus Google Cloud Functions. GitHub API reported no SPDX license. Reuse only the diagnostic split, not the external proxy as a pure-Worker fix.

### 2. MortalImmortality/CodexProxy

Pinned commit: 8dfcb89356f63d6aa38d33c2db4935f7ac6e85b4.

Sources:

- [OAuth and token HTTP/curl path](https://github.com/MortalImmortality/CodexProxy/blob/8dfcb89356f63d6aa38d33c2db4935f7ac6e85b4/auth/auth.go)
- [Go upstream HTTP client](https://github.com/MortalImmortality/CodexProxy/blob/8dfcb89356f63d6aa38d33c2db4935f7ac6e85b4/proxy/proxy.go)
- [Pinned commit](https://github.com/MortalImmortality/CodexProxy/commit/8dfcb89356f63d6aa38d33c2db4935f7ac6e85b4)

auth.go fixes auth.openai.com/oauth, the Codex public client ID, and chatgpt.com/backend-api/codex; token form requests use the system curl. proxy.go uses Go net/http for Responses/WHAM. The README presents a local OpenAI-compatible proxy. No Worker target or reproducible Worker success capture is present.

Assessment: clear OAuth and native egress implementation; evidence is local Go only. GitHub API reported no SPDX and no standard LICENSE file.

### 3. wowyuarm/codex-proxy

Pinned commit: 0930fe6243cf97c6221e8588a9135161eaf27b24.

Sources:

- [Upstream request/session implementation](https://github.com/wowyuarm/codex-proxy/blob/0930fe6243cf97c6221e8588a9135161eaf27b24/codex_proxy/server.py)
- [Pinned commit](https://github.com/wowyuarm/codex-proxy/commit/0930fe6243cf97c6221e8588a9135161eaf27b24)

server.py creates a curl_cffi.requests.AsyncSession with impersonate="chrome", HTTP/1, optional HTTPS proxy, and up to two upstream attempts. OAuth is supplied by local credential storage; the configured target is the Codex Responses backend. The README claims Plus/Pro support but provides no Worker deployment or independently reproducible Worker response.

Assessment: explicit native TLS/browser-fingerprint difference; not pure Worker. GitHub API reported no SPDX and no standard LICENSE. curl_cffi/Chrome impersonation cannot be treated as a Workers code repair.

### 4. BhanuTabeti/oauth-proxies

Pinned commit: 98607548fdad59af38225fd36d61c6e2c78a88c6.

Sources:

- [Codex OAuth PKCE/token store](https://github.com/BhanuTabeti/oauth-proxies/blob/98607548fdad59af38225fd36d61c6e2c78a88c6/oauth_proxy/codex_auth.py)
- [Codex HTTP/SSE client](https://github.com/BhanuTabeti/oauth-proxies/blob/98607548fdad59af38225fd36d61c6e2c78a88c6/oauth_proxy/codex_client.py)
- [Pinned commit](https://github.com/BhanuTabeti/oauth-proxies/commit/98607548fdad59af38225fd36d61c6e2c78a88c6)

The source fixes auth.openai.com PKCE, chatgpt.com/backend-api/codex/responses, Accept: text/event-stream, originator, and session_id, then uses Python httpx and SSE parsing. The README calls it a local single-user HTTP server. No Worker target, deployment result, or direct Worker success evidence is supplied.

Assessment: useful OAuth/header/payload reference; not pure Worker. The repository includes a LICENSE, but GitHub API returned NOASSERTION; do not assume a copyable license without reading that file.

### 5. anxkhn/codex-openai-proxy

Pinned commit: b489b01132f215377fc212e6b38c7ff86094253e.

Sources:

- [Codex HTTP client](https://github.com/anxkhn/codex-openai-proxy/blob/b489b01132f215377fc212e6b38c7ff86094253e/src/codex_openai_proxy/codex/client.py)
- [OAuth implementation](https://github.com/anxkhn/codex-openai-proxy/blob/b489b01132f215377fc212e6b38c7ff86094253e/src/codex_openai_proxy/auth/oauth.py)
- [Pinned commit](https://github.com/anxkhn/codex-openai-proxy/commit/b489b01132f215377fc212e6b38c7ff86094253e)

The client uses Python httpx.AsyncClient, follows redirects, and refreshes/retries after 401/403. The project describes a local Codex OAuth proxy. No Worker runtime or direct Worker response is shown.

Assessment: local OAuth proxy only; its retry/redirect behavior is not the project's one-shot diagnostic contract. GitHub API reported no SPDX and no standard LICENSE.

### 6. 7shi/codex-oauth

Pinned commit: dd156ea57f618d1382e8f091c04e00cccf3cacdc.

Sources:

- [OAuth and WHAM client](https://github.com/7shi/codex-oauth/blob/dd156ea57f618d1382e8f091c04e00cccf3cacdc/codex_oauth.py)
- [Pinned commit](https://github.com/7shi/codex-oauth/commit/dd156ea57f618d1382e8f091c04e00cccf3cacdc)

This sample uses Python httpx and Authlib PKCE against https://chatgpt.com/backend-api/wham; its test/list commands run locally. It has no Worker config, Worker source, or Worker deployment result.

Assessment: OAuth/WHAM sample, no pure Worker evidence. The pinned project metadata identifies CC0-1.0. Only the public flow shape is reusable, subject to fresh upstream validation.

### 7. openclaw issue #68033

Source: [Issue #68033](https://github.com/openclaw/openclaw/issues/68033)

This local Docker/macOS report uses Codex CLI OAuth. The author records progressive 400 responses for missing/nonconforming instructions, array input, store:false, and stream:true; after the final body shape, same-host curl returned HTTP 200 with a valid SSE stream. This is an issue-author host report, not a pinned source/CI artifact, and not Worker evidence. The same issue also reports Cloudflare challenge failures on a native route.

Assessment: strong payload-shape comparison; no pure Worker result. It separates ChatGPT OAuth from the api.openai.com/v1 API-key path and supports keeping payload validation separate from source-marker analysis.

### 8. openclaw issue #94432

Source: [Issue #94432](https://github.com/openclaw/openclaw/issues/94432)

This report says browser OAuth completes and auth profiles exist, but a local app-server calling chatgpt.com/backend-api receives an HTML 403 challenge. It explicitly separates the direct API-key provider at api.openai.com/v1. This is new negative evidence that OAuth validity does not imply programmatic upstream success; it is local gateway/app-server evidence, not Worker evidence, and has no pinned source commit or deployment artifact.

Assessment: medium local failure evidence; it cannot prove pure Worker impossibility or invalid OAuth.

## Reusable material and limits

1. Diagnostic layering: the chief-of-staff pinned source separates authentication-layer 401, manually added CF-Worker 403, the actual Cloudflare Worker path, and the Google Cloud Functions path. This is suitable for the project's no-token marker collector, not an official platform rule.
2. Payload baseline: #68033 supports the independent Codex Responses constraints input as an item array, store:false, stream:true, and valid instructions. These constraints can inform memory fixtures; they do not remove a platform-added source marker and do not imply that nodejs_compat changes transport.

The candidates consistently distinguish ChatGPT/Codex OAuth from OpenAI Platform API keys. Go/WASM, Python curl_cffi, system curl, ordinary httpx, and Google Cloud Functions introduce non-Worker transport or host variables. WASM running inside a Worker remains in-runtime code, but none of these candidates provides a direct Worker success capture.

This is not a proof that every single Worker route is impossible. It is a bounded result: the new public material contains no reproducible pure-Worker Codex OAuth success sample. The project should continue to rely on its own marker/payload observations and on explicit upstream acceptance evidence.
