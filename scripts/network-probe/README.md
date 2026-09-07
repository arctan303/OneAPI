# OneAPI synthetic network probe

This isolated Worker compares synthetic requests reaching one collector from Node, local workerd, a deployed top-level Worker, and its own stateless ProbeDO. It never reads account credentials or `.dev.vars`, and every probe sends the same fixed JSON body and four fixed application headers, including `User-Agent: OneAPI-Network-Probe/1.0`.

Set `COLLECTOR_ORIGIN` to the exact deployed `https://oneapi-network-probe.<account-subdomain>.workers.dev` origin. The runtime rejects paths, queries, credentials, ports, other hosts, and caller-provided destinations. `global_fetch_strictly_public` is enabled only so the Worker can reach its own public collector path; it says nothing about cross-zone requests to `chatgpt.com`.

The collector returns presence plus SHA-256 for `CF-Worker`, `Via`, `Forwarded`, `X-Forwarded-For`, `CF-Connecting-IP`, `Accept-Encoding`, and `User-Agent`; it never returns the original header values. `CF-Connecting-IP` is an edge-provided header and is not proof of the collector's actual socket peer. `request.cf` TLS and protocol fields describe the connection arriving at this collector. On same-Worker self-fetch they may inherit or otherwise reflect Cloudflare's internal request handling, so they are not direct evidence of the TLS handshake that `chatgpt.com` observes.

Local verification:

```powershell
node --check scripts/network-probe/core.mjs
node --check scripts/network-probe/worker.mjs
node --check scripts/network-probe/run.mjs
node --test scripts/network-probe/test.mjs
node --test scripts/network-probe/test-runtime.mjs
npx wrangler deploy --dry-run --config scripts/network-probe/wrangler.jsonc --var COLLECTOR_ORIGIN:https://oneapi-network-probe.<account-subdomain>.workers.dev
```

The runtime fixture uses Miniflare v5's `workers` configuration through `convertV4MiniflareOptions`, bundles the Worker module graph before startup, and passes a URL plus a plain init object to `dispatchFetch`. Synthetic requests use `redirect: "manual"` because workerd does not accept `redirect: "error"`; every non-2xx response, including redirects, is rejected by the response validator. The fixture keeps `cf: false`, uses ephemeral storage, disposes each runtime in `finally`, and replaces outbound fetch with an in-process fixed response, so it makes no public request.

After deployment, run each mode once. The runner has no retry loop and disposes its in-memory Miniflare instance in `finally`:

```powershell
node scripts/network-probe/run.mjs node https://oneapi-network-probe.<account-subdomain>.workers.dev
node scripts/network-probe/run.mjs local-workerd https://oneapi-network-probe.<account-subdomain>.workers.dev
node scripts/network-probe/run.mjs worker-top https://oneapi-network-probe.<account-subdomain>.workers.dev
node scripts/network-probe/run.mjs worker-do https://oneapi-network-probe.<account-subdomain>.workers.dev
```

Each command produces one collector observation. Do not rerun a failed mode without recording why the tool itself failed and confirming the remaining budget.
