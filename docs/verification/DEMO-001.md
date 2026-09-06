# DEMO-001 验证与运行记录

日期：2026-09-06。风险：R2。当前结论：本地实现、Mock、SDK 兼容和独立审查通过；真实设备码登录成功；同机官方 Codex CLI 的目录与最短生成成功，但 Demo 模型目录仍返回 `403 text/html`，所以 Demo 真实端到端未通过；Cloudflare 云端未验证、未部署。

## 实现与固定依据

- 运行栈：TypeScript 7.0.2、Wrangler 4.129.0、SQLite-backed Durable Object、Vitest 4.1.0、Cloudflare Vitest plugin 1.1.4。
- SDK 验证：官方 `openai` Node SDK 7.10.0。
- Workers types：`@cloudflare/workers-types` 5.20260906.1。
- Codex 协议源码基线：`openai/codex` commit `ac192cd7937b0d73edc6dffe009940ae53782dd4`；固定认证域名、设备码路径、client ID、token exchange/refresh、Codex Responses 和模型目录均据此实现。
- Codex 传输身份：固定提交中的官方默认值 `originator: codex_cli_rs`；客户端版本锁定为本机官方 `codex-cli 0.153.4`。`User-Agent` 保留 `OneAPI/0.1.0` 集成后缀，不伪装为未修改的官方二进制，也不轮换 Desktop/VS Code/浏览器身份试探上游。
- 官方说明：[Codex authentication](https://learn.chatgpt.com/docs/auth)、[Workers Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)、[Durable Objects testing](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)、[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。

业务代码不会读取 Codex/OpenCode 现有登录文件。Demo 只保存此次设备码流程取得的自身凭据；凭据和设备内部 ID 使用 AES-256-GCM、随机 12 字节 IV、AAD 和认证标签加密后写入 DO storage。上游 URL 固定，所有携带凭据的 3xx 响应均以 `manual` 模式接收并显式拒绝。

## 运行与密钥

在 `C:\git\OneAPI`：

```powershell
npm install
npm run setup
npm run dev
```

页面：`http://127.0.0.1:8787/`。接口 Base URL：`http://127.0.0.1:8787/v1`。前台停止方式：启动终端按 `Ctrl+C`。

本轮交付时 Demo 正在后台运行，健康检查为 `true`，进程 ID 为 `25116`；停止命令：

```powershell
taskkill.exe /PID 25116 /T /F
```

`npm run setup` 首次生成 `.dev.vars`；重复执行不覆盖。管理员密钥、调用密钥和 AES 密钥互不相同，实际值只在本机查看：

```powershell
Get-Content -Path C:\git\OneAPI\.dev.vars
```

页面的“管理员密钥”和“调用密钥”输入只存浏览器内存，刷新即清除；前端资产不含密钥。不要把 `.dev.vars`、密码、token、一次性代码或 `auth.json` 发到聊天或提交到版本库。

OpenAI Node SDK 示例：

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.GATEWAY_API_KEY,
  baseURL: "http://127.0.0.1:8787/v1"
});

const models = await client.models.list();
const result = await client.responses.create({
  model: models.data[0].id,
  input: "只回复：连接正常"
});
console.log(result.output_text);
```

## 实际兼容矩阵

统一调用鉴权为 `Authorization: Bearer <GATEWAY_API_KEY>`；管理接口使用独立 `ADMIN_API_KEY`。未知字段返回带 `param` 的 400，不做模型替换或参数静默丢弃。

| 接口 | 已实现的输入与输出 | 明确边界 |
| --- | --- | --- |
| `GET /v1/models` | 当前账户真实 Codex 模型目录转 OpenAI `object:list/data[]`；缓存模型 reasoning 能力用于校验 | 未登录 503；不硬编码或伪造模型 |
| `POST /v1/responses` | `model`；字符串或显式消息/`function_call`/`function_call_output` 数组；`instructions`、`stream`、函数 `tools`、`tool_choice` 字符串 `auto/none/required`、`parallel_tool_calls`、`reasoning.effort`、`store:false`、`background:false`；普通完整 Response 或 Responses SSE | `store:true`、`background:true`、`previous_response_id`、托管工具、结构化/多模态输入及其他未知字段 400；`temperature`、`top_p`、`max_tokens`、`max_completion_tokens`、`max_output_tokens` 均 400 |
| `POST /v1/chat/completions` | `model`、`messages`、`stream`、函数 `tools`、字符串 `tool_choice`、`parallel_tool_calls`、`reasoning_effort`、`stream_options.include_usage`；system/developer/user/assistant/tool 文本消息、assistant tool calls 和 tool results；普通 Chat 或 Chat SSE + `[DONE]` | `message.name` 明确 400；对象式 tool choice、`n`、采样/token 限制、response format、音视频/图片和其他未知字段 400 |
| 客户端取消 | AbortController/连接停止消费会中止上游；直接 cancel 桥之外有 1.5 秒背压空闲保护并释放租约 | 不是持久后台任务；无 `/cancel` 业务接口 |

资源边界：请求体 1 MiB；认证/模型控制面响应体 1 MiB；非流式聚合 8 MiB；并发生成 2；生成总时限 5 分钟；不排队、不无界重试。刷新 single-flight；refresh 结果不确定或刷新后 token 再次 401 时原子停用凭据并要求重新登录。

## 验证证据

| 类型 | 命令 / 结果 | 能证明什么 |
| --- | --- | --- |
| Mock 静态与运行时 | `npm run typecheck`：通过 | TypeScript 与 Workers 类型闭合 |
| Mock Worker/DO | `npm test`：2 files，16/16 passed | SSE 分块 UTF-8；鉴权隔离；加密存储；设备 pending/cancel/expiry/double-poll；start/poll/credential/refresh 最终提交窗口竞态；refresh single-flight、不确定态、invalid_grant、二次 401；断开后不回写；DO 重建/租约清理/密文损坏；Models/Responses/Chat 普通与流式；多轮/工具；参数拒绝；HTTP 错误、重定向、异常终态、截断、无效 UTF-8、头/体超时；并发与大小限制；官方 Codex 请求头、Cloudflare challenge 分类，以及错误体 64 KiB 上限/取消/detail 不入日志 |
| Mock SDK | `npm run test:sdk`：通过 | 在真实 Wrangler HTTP 进程和已有 `.dev.vars` 条件下，用运行 nonce 防误连；OpenAI SDK 7.10.0 验证 Models、Responses 普通/流式/多轮/函数工具、Chat 普通/流式、并发限制与 AbortController 双槽恢复 |
| 本地打包 | `npm run build`：Wrangler 4.129.0 dry-run 通过 | Worker、DO migration 和 3 个静态资产可打包；没有部署 |
| 脚本语法与密钥边界 | `node --check public/app.js scripts/sdk-compat.mjs scripts/live-smoke.mjs`：通过；远端 URL、伪 localhost 与带路径 URL 负例均在读取/发送密钥前非零退出 | 浏览器与验证脚本语法有效；`smoke:live` 只允许本地 HTTP loopback Base URL |
| 初始化 | `npm run setup`：首次生成，密钥未输出；再次执行应保持不覆盖 | 本项目独立本地密钥，不导入既有凭据 |

## 2026-09-06 有限 403 对照诊断

本轮暂停功能扩展，保留既有 Demo 登录和后台进程。新增诊断仅对白名单字段留痕：实际 hostname/path、HTTP 状态、Content-Type、Server、`cf-ray`、`cf-mitigated` 和上游请求 ID；HTML 最多读取 64 KiB，只输出规范化标题或 `[redacted]` 以及明确类别，不记录正文；JSON 只记录是否存在结构化错误包络，不记录上游 `error.code` 原值。没有结构化上游业务码的 403 映射为本地 `upstream_http_403` / `server_error`，不再使用 `upstream_permission_denied`。只有 `cf-mitigated: challenge` 才归为明确 challenge；`Attention Required` 或 `Just a moment` 标题本身只归为页面类别。

| 对照 | 条件与次数 | 结果 | 能说明什么 / 不能说明什么 |
| --- | --- | --- | --- |
| 官方 Codex CLI 模型目录 | 同机、同网络、当前已登录 CLI；`codex debug models` 远端目录 1 次 | 成功；9 个目录项、6 个可选项；后续按用户决定使用 `gpt-5.5` | 证明官方客户端可取得本账户目录；没有读取或导出 CLI 凭据 |
| 官方 Codex CLI 最短生成 | 官方 `codex-cli 0.153.4`；临时 provider 别名只为把 request/stream retries 明确设为 0；`gpt-5.5` 1 次 | 成功，约 8.83 秒；未见 403 或重试文本 | 建立同机账户、网络和服务端的成功基线；临时 provider 配置意味着它不是“完全默认配置”的单变量实验 |
| 官方 CLI 提前发生的一次对照 | 在用户把模型改为 `gpt-5.5` 的消息到达前，`gpt-6-astra` 1 次；重试为 0 | 成功，约 9.87 秒 | 如实计数；收到模型决定后不再使用该模型 |
| Demo 模型目录 | 保留当前 DO 登录；`GET /v1/models` 1 次；网关与上游均无自动重试 | 本地响应 403，`upstream_http_403` / `server_error`，约 0.87 秒 | 目录失败后按约束停止，没有继续发 Demo 生成；因此 `gpt-5.5` 尚未成为 Demo 上游生成请求的变量 |
| CLIProxyAPI / 其他成熟网关 | 0 次 | 本轮未建立可用的独立对照 | 不把“未测试”写成失败或成功；若以后独立登录，对照会同时包含凭据链差异，不能称严格单变量实验 |

Demo 这一次目录拒绝的白名单诊断：hostname `chatgpt.com`；path `/backend-api/codex/models`；status `403`；Content-Type `text/html; charset=UTF-8`；Server `cloudflare`；`cf-ray` `a36ce1b37dedeb20-SJC`；`cf-mitigated` 缺失；上游请求 ID 缺失；结构化业务错误码缺失；没有提取到可用 HTML 标题；正文未超过诊断上限；类别 `cloudflare_html_error`。这个类别只表示 Cloudflare 返回 HTML 错误页，不能据此断言具体 WAF 规则、challenge 或账户权限。

另有一次官方 CLI 生成尝试在发网前因内置 OpenAI provider 不允许覆盖 retry 配置而退出；它是配置失败，不计真实请求。随后才使用上述临时 provider 别名完成各一次、重试为 0 的对照。

本轮新增真实上游请求合计 4 次：官方目录 1、官方 `gpt-6-astra` 生成 1、官方 `gpt-5.5` 生成 1、Demo 目录 1；Demo 生成 0。均无自动重试，不轮换身份，不抓取 Cookie，不部署云端。

当前下一步（由后续诊断更新）：官方目录路径、查询参数、Bearer 类型与账户 claim 语义已完成只读对照，未发现直接可修的错配。Miniflare 自动注入 Worker 来源头是新的优先线索；依据、loopback 实验与因果边界见 [403 运行时诊断](403-runtime-diagnosis.md)。不继续换模型或批量生成，不把 Node/Go 网关的可能成功当成纯 Worker 可用证据。
本轮 R2 聚焦独立复核：首轮发现仅凭 `Attention Required` 标题误判 challenge，以及任意 JSON `error.code` 可能把账户标识写入日志；修复为仅以 `cf-mitigated: challenge` 确认 challenge，模糊标题只保留页面类别，JSON 只记录结构化错误包络。修复后 reviewer 独立执行 `npm run typecheck` 与 `npm test`（2 files，16/16）均通过，最终结论为通过、无剩余 P0/P1/P2；reviewer 未重放任何真实请求，也未读取凭据。实施方随后复跑 `npm run test:sdk` 与 `npm run build` 通过。

独立审查：fresh reviewer 首轮结论不通过，发现 Mock 环境污染、refresh token 不确定态、超时范围、Mock 覆盖及字段静默丢弃；修复后又发现二次 401 和加密/解密最终提交窗口竞态。真实 403 后的协议增量复核继续发现错误响应体无界读取/未释放和 `smoke:live` 可向环境变量指定的远端地址外送本地密钥；均已修复并加入回归或可执行负例。最终聚焦 R2 复核结论为通过，未发现剩余 P0/P1/P2；保留的真实上游 403 与云端未验证是已披露缺口，不是审查通过的端到端证明。

## 真实账户与云端状态

- **设备码登录：已验证。** 页面生成官方授权网址和一次性代码，用户完成官方页面登录后，轮询成功；`/admin/status` 返回 `connected: true`、脱敏账户尾号 `…df5440`、`reauthenticationRequired: false`。没有读取或导入任何既有 Codex/OpenCode 凭据。
- **真实模型目录：Demo 失败，官方 CLI 成功。** Demo 旧的自定义 originator 下两次只读请求返回 403；依据固定官方源码改为 `codex_cli_rs`、`codex-cli 0.153.4` 和带 OneAPI 后缀的结构化 User-Agent 后，先前两次和本轮一次目录读取仍为 403。当前脱敏诊断见上表，错误码已改为 `upstream_http_403`，不再冒充上游业务权限错误。官方 CLI 同机目录则成功。
- **真实生成：官方 CLI 成功，Demo 本轮未继续。** 先前 Demo 手动指定 `gpt-5.6-sol` 的一条非流式请求为 403、无重试。本轮官方 CLI 的 `gpt-5.5` 最短请求成功；但 Demo 目录先失败，故遵守停止条件，没有把 `gpt-5.5` 发到 Demo 生成端。Demo 的真实流式 Responses、Chat 普通/流式、函数工具往返和自然到期 refresh 仍未验证。
- **真实调用总量。** 本执行模型累计明确记录 Demo 模型目录 GET 5 次、Demo 非流式 Responses POST 1 次；全部无自动重试。页面如由用户点击“读取模型”会产生额外只读 GET，因此服务访问日志中的 GET 数可能更高。本轮另有官方 CLI 目录 1 次、成功生成 2 次，详见对照表；发网前配置失败不计入真实请求。
- `npm run smoke:live` 仍是恢复入口：它先确认 connected 并读模型目录；只有目录成功才发送 Responses 普通/流式和 Chat 普通/流式各一条短请求。失败设置非零退出码且不自动重试。
- **恢复条件。** 协议只读对照已完成，后续按 [403 运行时诊断](403-runtime-diagnosis.md) 核验运行时差异。真实上游对照尚未执行，若实施须固定条件、限定次数、禁止重试及凭据输出。产品目标仍为纯 Worker；独立网关对照或变更运行平台不能冒充已经完成本目标。
- **Cloudflare 云端：未验证且未部署。** dry-run 不证明 Cloudflare 出口、Secret、DO migration、费用或上游策略在云端可用；云端部署需另行授权和验收。
