# DEMO-001：403 运行时差异诊断

日期：2026-09-06；2026-09-07 恢复排查。状态：早期只读对照已完成，当前按用户授权进行真实链路诊断；根因尚未证实。承接 [DEMO-001 验证记录](DEMO-001.md)，不重置原有请求计数或验收状态。

## 目标与边界

解释官方 CLI 成功、Demo 目录返回 HTML 403 的差异，优先确定是否存在运行时兼容障碍。保留 Demo 进程、登录与业务代码；不读取 `.dev.vars`、`.wrangler` 或 Codex/OpenCode 凭据，不发起登录/刷新/真实目录或生成，不部署。

主会话负责环境、证据与收束；`gpt-5.6-sol` + `high` 只读核对协议；`gpt-5.6-luna` + `high` 实现独立 loopback 诊断脚本。诊断脚本不接入生产代码，也不构成业务修复。

## 已核实与推断

| 层次 | 证据 | 结论边界 |
| --- | --- | --- |
| 既有真实基线 | 官方 CLI 目录及 `gpt-5.5` 生成成功，Demo 目录为 `403 text/html` | 来自上一执行任务；凭据链和传输不同，不是严格单变量对照 |
| 本地依赖源码 | Miniflare `5.20260903.0-alpha` 的 outbound interceptor 设置 `CF-Worker`；默认值来自 Worker 名称 | 说明本项目本地模拟器具备注入行为，不能单凭源码证明这次真实 403 的因果关系 |
| 官方平台说明 | Workers 的 `fetch()` 子请求附带 `CF-Worker`，标识所属 zone | 云端有对应机制，但本项目尚未部署或验证云端请求 |
| 外部项目复现 | background-agents issue #1374 作者报告同 Node 进程、同凭据下，加入该头从 200 变为 HTML 403；本地 Wrangler 也失败 | 独立项目报告，路径为 `/responses`，不是本项目 `/models` 实测，也不是 OpenAI 对阻断策略的确认 |
| 当前判断 | Workers 来源标记及运行时传输是优先核查方向 | 不能断言 token 无误、特定 WAF 规则已查明，或全部纯 Worker 方案永久不可用 |

本地源码位置：`node_modules/miniflare/dist/src/index.js:68545` 取 `dev?.zone ?? workerName + ".example.com"`；`dist/src/workers/core/outbound.worker.js:101` 设置头。本项目 `wrangler.jsonc` 未配置自定义 outbound service/zone，Worker 名称为 `oneapi-codex-gateway-demo`。

来源：

- [Cloudflare 官方 HTTP headers / CF-Worker](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-worker)。该文档还说明 WAF custom rules 的处理早于平台注入，匹配 Worker 来源应使用 `cf.worker.upstream_zone`；不能把关联现象简化成已经找到了某条 WAF header 规则。
- [background-agents issue #1374](https://github.com/ColeMurray/background-agents/issues/1374)，2026-08-12 创建；[关闭它的回退 PR #1375](https://github.com/ColeMurray/background-agents/pull/1375)。这里仅采纳作者报告的对照现象，不采用其规避尝试或直接继承全部根因断言。

## 本地回环实验

命令：`node scripts/diagnose-runtime-headers.mjs`。脚本只启动临时 loopback HTTP echo server 和独立 Miniflare；各发一次 Node/Worker 请求到该 echo server，无凭据、无 DO、无持久化，禁用遥测与外部 CF 信息获取。不使用原 Demo 的 8787 端口。

最终脚本已通过 `node --check scripts/diagnose-runtime-headers.mjs` 和实验运行，退出码均为 0。执行代理报告：Node 收到的 `cf-worker` 为 null；Worker 收到 `diagnose-runtime-headers.example.com`；两组请求的 Authorization / Cookie 存在标记均为 false。脚本没有设置 `CF-Worker` 或显式配置 zone，故该字段来自运行时默认注入。

主会话核对最终脚本配置为 `compatibilityDate: 2026-09-06`、`cf:false`、禁用 telemetry、临时 loopback 地址；没有加载 Wrangler 业务配置或账户存储。实验结束后的进程清单只有原 Demo 两个 workerd（PID `12268`、`27192`，父 PID `12272`），没有新增 workerd 遗留。脚本 SHA-256：`684B50A6505508DBF50E62ACF201A42819CDA515D37B5DAEC0E2463352A56543`。

最终运行白名单输出：

```json
{"node":{"cf-worker":null,"user-agent":"node","accept-encoding":"gzip, deflate","has-authorization":false,"has-cookie":false},"worker":{"cf-worker":"diagnose-runtime-headers.example.com","user-agent":null,"accept-encoding":null,"has-authorization":false,"has-cookie":false}}
```

实际执行三次本地实验，每次各一条 Node 和 Worker echo 请求；真实上游请求为 0。第一次使用显式 zone 与旧兼容日期，成功后因未清理的 timer 延迟退出约 31.9 秒；第二次改为本项目兼容日期、去掉 zone 并清理顶层 timer，约 2.59 秒，输出被 `Measure-Command` 吞掉；第三次修正清理 timer 后用最终脚本直接运行，得到上述输出、退出码 0，工具观察耗时 5.7 秒（包含 shell/tool 开销）。前两次不能代替最终配置的证据。

这只证明本机该版本 Miniflare 的请求头行为。没有发送 ChatGPT 请求，不证明 `CF-Worker` 是本账户目录 403 的充分原因；Node 与 Worker 还存在其他传输差异。

## 协议只读对照

`sol high` 对照官方固定提交 `ac192cd7937b0d73edc6dffe009940ae53782dd4` 后，未发现可直接修复的目录路径、`client_version`、Bearer access token 类型、`ChatGPT-Account-ID` claim 语义或 `version` / `originator` 缺失。源码一致只证明请求构造符合该基线，不证明实际保存的凭据内容正确。

官方目录走普通 Bearer 认证，不要求 run-scoped Agent Identity；没有依据为目录 403 添加 attestation。Demo GET 额外发送 `Content-Type: application/json`，User-Agent 如实带 Workers/JS 和 OneAPI 标识；官方客户端用 Reqwest 传输，Demo 用平台 fetch。这些是差异，不是已经证实的错误。

依据：[官方模型目录实现](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/model-provider/src/models_endpoint.rs)、[models endpoint](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/codex-api/src/endpoint/models.rs)、[Bearer auth](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/model-provider/src/bearer_auth_provider.rs)、[default client](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/login/src/auth/default_client.rs)。

[CLIProxyAPI 当前传输实现](https://github.com/router-for-me/CLIProxyAPI/blob/c76dfd4e0edabab9000628b1560ab8ab379eadb8/internal/runtime/executor/helps/utls_client.go) 使用 uTLS，说明它与 Worker fetch 并非同一种传输；本轮没有运行该网关，不采用更换传输指纹作为修复方案。官方源码中的进程级 Cloudflare cookie jar 默认空，不能由其存在推断现场成功请求带有 Cookie，更不能据此读取或复制 Cookie。

## 2026-09-06 保留基线（历史）

本轮核验 PID `25116` 仍存在；本地 `/health` 返回 `{"ok":true,"service":"oneapi-codex-gateway-demo"}`。没有读取账户状态，`connected:true` / `reauthenticationRequired:false` 仍引用用户交接时证据，不冒充本轮重新验证。

以下 SHA-256 在本轮开始与收尾检查一致：

| 文件 | SHA-256 |
| --- | --- |
| `src/codex/upstream.ts` | `703BFAFF6DA300C986CCD35EDED5DFA2D72B1933836C1D78B74B9139F0625401` |
| `src/codex/constants.ts` | `272EF19566C72BEBF6D28DDE5F86BEF752828F498C47BBBB659EFD58CD3A5D6D` |
| `src/codex/auth.ts` | `FF211903FBDB269948DD73EF7ED2B1019972F3227835C8EAA835C475D45E526D` |
| `src/account.ts` | `D0ADA4991CCE8FC007854F9E9239F35BCDA131AB51ADDF40B28A06A5840C1231` |
| `wrangler.jsonc` | `52762FDC1038B077EE120B197F40C218E6D969992C5FB4E37BA987F1F25D6EFE` |
| `package-lock.json` | `E1CA55516AF78713EFF1318ABAFE3E568D3C4A8990AA3EE09727F14DDA71D99C` |

## 2026-09-06 恢复建议（范围已被 LIVE-001 替代）

协议只读对照已完成，回环结果见上。后续若建立真实对照，应限定同一凭据、同一目录 URL 和请求参数，Node / Wrangler 各一次、无重试，仅输出脱敏响应元数据。此对照需要调整目前不读取 Demo 凭据的诊断边界，未执行。它只能检验整体运行时差异，不能单独证明 CF-Worker 这个头的因果关系。

在直连可行性未验证前，不继续扩展接口、反复换模型、重登或批量请求。任何只在 Node 中成功的实验或现成网关都不能证明纯 Worker 已可用；改用额外 Node 服务/其他托管运行时或 Platform API Key 会改变用户原有约束，不能静默当成既定方案。
## 2026-09-07 恢复任务（本地真实验证通过）

用户明确授权目标：管理员登录 → 使用自己的 Codex 账户 → 读取真实模型目录 → 创建 API key → 用指定模型成功测试。优先 gpt-5.5；gpt-5.6-luna 仅真实目录列出后考虑，不按 UI 名称猜 ID。

这次授权替代上一次只读诊断“不发真实请求”的任务范围。允许本机验证程序使用现有配置/持久化登录态，不把密码、API key、OAuth token 输出到聊天或日志，不读取其他应用账户文件、不重置数据库。维持现有公开 API/登录契约；Cloudflare 部署仍未授权，用户已明确接受先用本机 Node 跑通同一套后台和 API（DEC-009）。

规模：LIVE-001 短产品/修复任务，携带凭据的本地传输边界按 R2 验证与独立审查。

当前证据：原 8787 已退出，首次连接 ECONNREFUSED，无上游请求；随后依原 wrangler.jsonc 和原持久化位置启动 PID 10832。脚本管理员登录 200，账户 connected true / reauthenticationRequired false；一次管理员模型目录请求返回 403/upstream_http_403，脚本会话退出 204。截至此检查点真实目录请求 1 次，真实生成 0 次，禁用自动重试。现有旧模型/生成/登录计数不重置。

结果：同一项目原 OAuth 在 Node 出站下成功读取真实目录；修复普通响应聚合丢正文后，新建 API key 的 gpt-5.5 SDK 普通生成与管理员页面流式生成均通过。新增本地 HTTP 入口/私有绑定补齐取消传递；不采用重登、重置、TLS 豁免或指纹伪装。

本轮累计：Worker 目录 1 次 403；已确认 Node 目录 5 次 200、生成 5 次 200（其中前 2 次聚合无正文失败，之后 SSE 诊断、最终 SDK 与页面均收到正文）；另有 1 次早期脱离终端 Node 目录尝试因本地连接断开而无法确认是否到上游。未观察到这批稳定请求中的 OAuth 刷新，未新发设备授权；不重置旧任务的历史调用计数。完整记录、真实基线与审查见 [LIVE-001](LIVE-001.md)。Node 成功仅证明该本地运行方式，纯 Cloudflare Worker 尚未验收。
