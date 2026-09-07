# OneAPI 开发计划与历史交接

初始日期：2026-09-06；当前状态更新：2026-09-07。原路线：0→1；规模：单一可交付的本地 Demo 短任务，以下为内部执行顺序，不另建 Phase。

## 活跃计划

当前执行：[CONSOLE-NET-001](tasks/CONSOLE-NET-001.md)，命令行网络配置向导、显式私网访问和六区管理后台；本地实施、浏览器验收与网络边界独立复核均已完成，新版已在127.0.0.1:8787启动。已随 v0.2.0-dev.2 测试版推送发布，安装包回下载核对通过，见 [RELEASE-003](verification/RELEASE-003.md)。

最新发布：[v0.2.0-dev.2](https://github.com/arctan303/OneAPI/releases/tag/v0.2.0-dev.2) 测试版已推送并发布；安装包与校验和回下载一致，安装和网络教程随包提供。发布证据见 [RELEASE-003](verification/RELEASE-003.md)；上一版记录保留在 [RELEASE-002](verification/RELEASE-002.md)。

最新完成：[Phase-03轻量单服务器转型](dev-plan/phase-03.md)，有界参考项目研究、本地实现/独立复核/账号迁移/真实两协议验收与发布包均已完成。本地8787现运行 CONSOLE-NET-001 新版，账号配置与数据库保留，未执行新远端服务器部署。用户DEC-014已替代单Worker主交付方向；Phase-02和MARKER/WS失败证据保留，现有云端不自动改动。

历史交付顺序：[Phase-01](dev-plan/phase-01.md) → [Phase-02](dev-plan/phase-02.md)。Phase-01 本地实现、真实两协议/思考程度/官方额度与页面验收、fresh R2 独立复核均已完成；Phase-02已部署且管理端真实验证通过；用户新云端登录后模型目录/额度仍403，端到端验收受阻，见阶段文档。本轮用户已允许后续隔离Cloudflare测试，但不得影响已有资源；替代下文历史阶段仅本地的授权限制。范围与默认值见 [EXPLORE-001](tasks/EXPLORE-001.md)。

## 历史：DEMO-001 与 Phase-01/02 交接状态

有效契约：[Product-Spec.md](Product-Spec.md)；环境与用户分工：[README.md](README.md)；执行约定：[AGENTS.md](../AGENTS.md)。

| 项目 | 当前状态 |
| --- | --- |
| 需求与方案 | 已写入；本地实现已完成 |
| 实施 / 验证 / 独立审查 | LIVE-001 已完成并独立通过；Phase-01 本地完成：60/60、运行器/浏览器隔离回归、真实 SDK 与页面通过，fresh R2 复核通过，见当前阶段记录 |
| 账户登录 / 真实调用 / 云部署 | 原设备码登录保留 / LIVE-001 Node 真实目录、新 key gpt-5.5 普通生成及后台流式生成通过；原 Wrangler 出站仍 403 / oneapi/api.arcinks.com已部署且管理端通过；新云端授权后目录/额度仍403 |
| depends_on | 无既有代码；依赖可用 Node/npm、官方授权服务和用户在登录时操作 |
| 交付 | 受保护的本地 Demo、标准接口、针对性测试、真实证据与启动说明 |

R2 的具体理由：新增上游账户凭据存储、刷新和管理接口 → 可能泄漏账户访问能力或允许未授权者消耗订阅 → 登录前补鉴权、跨站、脱敏、刷新竞争行为测试和 fresh reviewer 独立核验。计划文档本身不代表 R2 代码已通过审查。

当前开发执行模型已按用户 2026-09-06 授权完成本地实现。开始时已确认目录无 Git 仓库、无业务代码，只有现有文档与工作流文件。详细实测与缺口见 [DEMO-001 验证记录](verification/DEMO-001.md)，不得把 Mock/本地通过扩写为真实账户或云端通过。

后续由主会话统筹，开发子代理采用 `gpt-5.6-sol` + `high`；简单任务可用 `gpt-5.6-luna`，思考程度按任务选择（DEC-006）。已按用户新要求完成 [AUTH-001](tasks/AUTH-001.md) 单管理员登录与 API 密钥管理；403 旧诊断检查点保留；用户 2026-09-07 已授权 [LIVE-001](tasks/LIVE-001.md) 真实链路排查，并接受本机 Node 先可用（DEC-009），替代旧任务不发新上游请求的限制。此前“暂不扩展接口”仅针对无依据的上游排障，不能阻止用户已明确授权的后台交互改进。诊断证据见 [403 运行时诊断](verification/403-runtime-diagnosis.md)。

## 1. 历史架构选择（当前已由 Phase-03 替代）

使用 TypeScript + Wrangler 本地 Workers 运行时 + SQLite-backed Durable Object。路由库可选轻量 Hono 或原生 Fetch Router；锁定实际安装版本并提交锁文件。前端采用静态 HTML/CSS/TypeScript，避免为三步登录测试页面引入完整管理框架。

```text
管理员页面 ── 登录会话 ──> Worker /admin/* ──> Account DO
第三方 SDK ── API key ──> Worker /v1/* ─────> Account DO
                                               │
                              会话 / API key 摘要 / OAuth 凭据
                                               │
                                   Codex 适配器 → 固定上游
```

账户 DO 按服务端固定名称 `primary` 定位，仅服务一个账户；不接受请求参数决定账户对象名。把凭据及其网络调用封装在该对象/适配器边界内，外部只返回脱敏状态、模型目录或转换后的响应流。SQLite-backed DO 自带存储，本版不额外接 PostgreSQL、Redis、D1、KV。

本地使用 Wrangler 的 local 模式与本地持久化目录，监听 `127.0.0.1:8787`，不使用 remote bindings。依据 DEC-009，新增本机 Node 出站运行器，业务代码仍运行于 Worker/DO，并复用原持久化数据和公开接口。本地出站的凭据目标、取消和资源上限单独验证；云端默认传输保持 Worker fetch，云端可用性另行验收。不得在业务代码中读取本地凭据文件或启动任意命令。

建议模块（可合理合并）：

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 路由、鉴权、Origin/Host 校验、请求限制、错误映射 |
| `src/account.ts` | Account DO、账户/登录状态、刷新与并发协调 |
| `src/codex/auth.ts` | 固定官方设备码、交换与刷新协议；只处理服务器数据 |
| `src/codex/upstream.ts` | 模型目录、Responses 上游请求、取消与超时 |
| `src/protocol/` | 请求验证、Chat↔Responses 转换、SSE 解析与输出 |
| `src/security.ts` | 密钥比较、Web Crypto 加解密、敏感字段过滤 |
| `public/` | 连接账户、选择模型、测试回复三个核心区域 |
| `test/`、`scripts/` | Mock 行为验证、SDK 测试、安全的初始化与启动脚本 |
| `wrangler.jsonc`、`package.json` | 本地配置、DO migration、脚本；无真实 Secret |

## 2. 已核实的设备码依据

2026-09-06 已读取 [Codex 官方认证说明](https://developers.openai.com/codex/auth) 和官方源码 [device_code_auth.rs](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/login/src/device_code_auth.rs)。本轮查询到 `openai/codex` main 的 SHA 为 `ac192cd7937b0d73edc6dffe009940ae53782dd4`；开发时复核固定版本文件与当前版本差异。

协议顺序：请求设备码 → 用户在官方页面输入代码 → 轮询获取授权码/PKCE verifier → 交换 token。不是拿到设备码就直接调用模型，也不是把设备码作为网关密钥。

| 环节 | 源码中的路径或字段 |
| --- | --- |
| 发起 | `POST https://auth.openai.com/api/accounts/deviceauth/usercode`；JSON 含 `client_id` |
| 返回 | `device_auth_id`、`user_code`（源码兼容 `usercode`）、轮询 `interval` |
| 用户操作 | `https://auth.openai.com/codex/device` |
| 轮询 | `POST https://auth.openai.com/api/accounts/deviceauth/token`；JSON 含设备内部 ID 与用户代码 |
| 换票 | 官方 `/oauth/token`，授权码 + PKCE verifier；设备流程的 redirect URI 为 `https://auth.openai.com/deviceauth/callback` |

官方 CLI 的等待上限是 15 分钟；设备轮询中的特定 403/404 被当作等待。**此语义只适用于设备轮询，不能把生成请求的 403/404 当作等待或重试。** client_id、token exchange、refresh、账户 ID 提取与请求头请从官方当前源码核对，不从示例猜测或虚构。

[OpenCode 历史搜索入口](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/codex.ts) 显示曾有 headless 设备码实现；本轮直接读取此路径返回 404，因此不作为当前实现可用性的依据。用户记忆与官方设备码流程相符，无需依赖 OpenCode 旧文件。

## 3. 登录与刷新如何实现

管理接口接受 AUTH-001 的管理员会话，登录后可执行全部后台操作；兼容脚本的 `ADMIN_API_KEY` Bearer。`GATEWAY_API_KEY` 与后台创建的 API key 只用于 `/v1` 外部调用，不是管理登录。管理会话与 Codex OAuth 登录相互独立。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /admin/status` | 脱敏账户与登录状态；不返回任何 token/内部设备 ID |
| `POST /admin/device/start` | 创建一次登录，返回不透明 login ID、官方 URL、用户代码、截止时间、建议查询间隔 |
| `POST /admin/device/poll` | 请求一次服务端轮询，受最早下次查询时间限制；完成时服务端交换并保存凭据 |
| `POST /admin/device/cancel` | 使指定登录本地失效，不把上游撤销行为说成已完成 |
| `POST /admin/disconnect` | 清除本地账户、登录和模型缓存，使在途旧登录/刷新不能回写 |

具体要求：

1. 页面由用户点击发起授权，不在加载时自动创建代码；服务端同一时间只保留一个有效登录尝试。重复 start 在有效期内返回当前尝试；显式取消后才能创建新尝试。
2. 每次 poll 只进行一次有超时的上游查询，由页面定时发起后续请求；不在 Worker 中写无限循环，不用 `waitUntil()` 保活整个登录过程。
3. 把 `nextPollAt`、截止时间、状态与 generation/version 存于 DO；页面刷新后仍可恢复。缺失/异常 interval 用保守默认值并记录诊断，实际不能短于上游要求；15 分钟是本地等待上限，不声称已测得上游实际有效期。
4. 合并并发 poll；交换授权码只能发生一次。取消、超时、断开后到达的响应检查 generation，禁止“复活”旧账户。
5. token 交换成功并加密持久化后才标记 connected。账户标识从可信上游结果解析，只用于路由/展示，不能把未经验证的 JWT 解码结果当作本地权限证明。
6. 不读取 `~/.codex/auth.json`、OpenCode 凭据目录或当前 Codex 应用密钥；独立授权与独立存储，不复用正在使用的 refresh token 链。
7. 以到期时间和安全余量触发刷新；同账户合并并发刷新，原子保存新 token 与版本。DO 单线程不等于 `await fetch()` 期间不会交错，须显式 single-flight 和版本检查。
8. 超时发生在一次性换票/刷新提交之后可能有不确定结果。不要无界重复同一 refresh token；保存可诊断状态，无法安全恢复时要求重新登录。`invalid_grant`/重复使用/明确失效必须终止重试。
9. 不提供任意上游 URL 输入。认证域名、生成域名及路径固定白名单，禁止带凭据跟随跨域重定向；测试替身只能通过测试依赖注入，不能成为公开代理入口。

## 4. 接口与流式适配

严格按 Product Spec 的接口子集。Codex 后端的 Responses 与 OpenAI Platform Responses 不保证完全同构，不能只替换 URL 就承诺兼容。

参考 CLIProxyAPI 的 [Codex 授权实现](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/codex/openai_auth.go) 与官方 Codex 的上游客户端，核实实际请求路径、账户请求头、无存储/流式要求与当前模型目录。官方默认 `originator: codex_cli_rs` 属于本 Codex 订阅客户端协议的一部分；使用时必须在 User-Agent 明示 OneAPI 集成后缀。不得为了绕过拒绝而轮换 Desktop/VS Code/浏览器身份、抓取 Cookie 或冒充未修改的官方二进制。

- 上游响应常为 SSE。Responses 流可保留有效事件，但仍须正确报告失败、截断和终止；Chat 流需要按事件语义转换。
- SSE parser 必须支持 UTF-8 字符跨网络块、CRLF/LF、多行 data、单块多事件、事件跨多块、注释、空事件；未知非关键事件可忽略，未知终态不能伪装成功。
- 保持 function call ID、名称、索引与参数增量对应；正确转换 assistant 工具调用与 tool 结果项，不丢弃历史 system/developer 指令。
- 非流式接口聚合到成功终态再返回；聚合有内存/大小上限，超限给错误，不能把半份文本当完整响应。
- 原生流转发遵守背压；转换流持续读取事件，不先缓冲整个回复。客户端取消、超时、解析失败都关闭上游并释放并发名额。
- 流开始后不重放生成请求，不自动切模型；开始前的重试也必须有明确可安全重试的依据和次数上限。
- 模型目录失败时标注“目录暂不可用”，保留手动模型诊断入口，不硬编码某个“最新模型”。默认选择目录中实际可用的文本模型。
- 先定义资源默认值并记录：建议最大请求体 1 MiB、并发 2、生成总时长上限 5 分钟、非流式聚合 8 MiB；这些是可调整 Demo 限制，不是上游或 Workers 官方限制。
- 并发配额覆盖整个响应流生命周期；取消/错误必须释放。持久化租约带截止时间，异常重启不能永久占满名额；无界等待队列不属于首版。

## 5. 密钥、页面与启动体验

初始化脚本首次生成彼此独立、足够随机的 `ADMIN_API_KEY`、`GATEWAY_API_KEY`、`TOKEN_ENCRYPTION_KEY`，写入 Git 忽略的 `.dev.vars`，重复运行不得覆盖已有值。示例文件只放占位符。为 token 使用 Web Crypto AES-GCM 等经审视的方案，随机 IV、版本与完整性校验齐备；严禁自制加密算法。

AUTH-001 将页面改为一次管理员口令登录、HttpOnly 会话保持；口令验证后清除输入，不持久化在前端。Phase-01 后台包含 Codex 连接与官方额度、模型测试、API 密钥、日志列表与设置区域，管理员测试无需另填调用密钥。API key 在创建时显示完整值一次，列表只留掩码/名称/时间并可撤销；程序日志不打印任何口令、会话或凭据。

保护层：严格 loopback 监听、允许的 Host/Origin、拒绝跨站管理请求、无通配 CORS、不使用 GET 修改状态、敏感响应 `Cache-Control: no-store`、禁止第三方脚本/统计、渲染上游文本用 textContent。网关调用接口允许无 Origin 的 SDK 请求，但始终验证密钥；Origin 限制仅是额外保护。

页面只需清楚展示“未连接 → 授权中 → 已连接/失败”，官方链接新窗口打开，显示倒计时、取消/重试、模型、提示词、发送/停止和响应。状态不得夸大：connected 只代表登录已保存；首次真实模型返回后才显示“调用验证通过”。不要显示未经验证的配额百分比。

实际脚本契约：

```text
npm install              首次安装并生成锁文件；此后使用 npm ci
npm run setup            生成本地密钥与必要配置，保持幂等
npm run dev              Wrangler local，仅 127.0.0.1:8787
npm run typecheck        TypeScript 静态检查
npm test                无真实凭据的自动化行为测试
npm run build           本地打包/部署 dry-run，不上传
npm run smoke:live      显式执行，读取本机网关密钥，少量真实 SDK 请求
```

若后台启动，Windows `Start-Process` 使用 `-WindowStyle Hidden`，记录进程 ID 和停服方法，不自动注册开机任务。不在示例/日志中输出实际密钥；smoke 从环境或忽略文件读取，避免命令行历史携带密钥。

## 6. 执行顺序与检查点

| 顺序 | 任务 | 完成证据 |
| --- | --- | --- |
| A | 核对工作区、源码依据、依赖版本；建立 Worker/DO、忽略规则与启动脚本 | 全新环境安装、启动、类型检查与打包成功；尚未连接账户 |
| B | 登录状态机、加密存储、管理/调用鉴权与刷新协调 | Mock 覆盖成功/等待/过期/取消/并发/旧响应；凭据不外泄 |
| C | 三个标准接口、SSE、工具调用、页面与异常处理 | 未修改 OpenAI SDK 对本地 Mock 网关通过接口矩阵 |
| D | fresh reviewer 独立核验 R2 范围；修复可执行发现后聚焦复核 | 真实审查结论和基线，不用实现者自评冒充通过 |
| E | 启动 Demo，邀请用户在官方页面登录；执行有限真实 smoke | 区分登录、模型目录、普通/流式调用结果；失败保留脱敏错误 |
| F | 更新当前现状与交接 | 启动/停止方法、测试证据、未完成项；保持云端“未部署” |

用户参与点只在 E：先确认本地页面与无凭据测试已准备好，再告诉用户本地 URL、点击“连接 Codex”、在官方页面输入此次代码；不要索取密码、token 或既有 auth.json。可以让用户直接在页面完成整个流程，无需把一次性代码贴进聊天。

如果设备码功能未启用，展示官方开启说明并等待用户操作；如果上游禁止/不支持此流程，保存证据后再与方案负责人讨论替代流程，不能擅自抓取 Cookie 或导入现有登录链。

## 7. 最低验证矩阵

| 类别 | 必须证明的行为 | 方式 |
| --- | --- | --- |
| 授权状态 | 等待、成功、过期、拒绝、取消；同一授权码只交换一次 | Mock 官方边界，推进可控时钟 |
| 状态竞争 | 双 poll、双 refresh、取消后回调、断开后刷新返回、重启恢复 | DO 真实本地运行时测试；断开不能被旧响应撤销 |
| 凭据保护 | 错密钥、角色混用、跨站/Host、日志/错误正文、重定向外带 | 负向请求与标记 token 检查；不以源码 grep 代替验证 |
| SDK 普通/流式 | Responses 与 Chat 均可消费；中文字符不损坏 | 官方 OpenAI JS SDK + 本地 Mock upstream |
| 多轮和工具 | 上下文保留、并行函数调用索引/ID、参数增量、工具结果回传 | 有明确预期的合成 Responses 事件与 SDK 客户端 |
| 故障 | 上游 401/403/429/5xx、异常终态、断流、乱码/无效 JSON、超时 | Mock 注入；无成功标记、无无限重放 |
| 资源释放 | 达并发上限、拒绝大体积、用户取消、超时、异常重启 | 观察上游 Abort 与租约/名额释放；不是只测返回状态 |
| 重启与存储 | 加密持久化、解密失败关闭访问、版本迁移/损坏提示 | 临时独立数据目录；不碰真实已有登录 |
| 真实订阅 | 用户授权后可列模型/发请求/接流 | 少量本地 smoke；测试内容不含敏感数据 |
| 云端 | 本轮不覆盖 | 必须明确列为未验证，后续授权再部署 |

真实 smoke 建议上限：一次目录读取，Responses 普通/流式、Chat 普通/流式各一条极短提示，共 4 次生成；函数往返可额外最多 2 次生成。失败不自动循环。真实刷新可在专用 Demo 凭据上有限验证一次并记录，不能伪造过期或为了测试耗尽用户额度；自然过期长期行为没测就保留缺口。

fresh reviewer 接收有效契约、实际新增文件清单/哈希或 git diff、验证输出、已知失败和本地授权边界；重点审查鉴权、敏感数据、刷新竞争、退出回写、SSRF/重定向与流生命周期。相同基线仅一个实例；修复后一次一个聚焦复核，禁止刷通过。

## 8. 暂停、证据与最终交接

记录到本文件状态表；详细输出过长时再建 `docs/verification/DEMO-001.md`，不要提前制造空报告。每项证据给出执行命令、日期、代码基线与 Mock/真实标识，日志脱敏。

遇到工具/网络/宿主故障，保留：已完成模块、文件与基线、最后有效命令/结果、未完成、恢复动作。不要自动重启长测试或重复生成登录代码。用户等待不等于取消任务，未登录也不能写成端到端通过。

最终交付至少包括可访问本地 URL、启动/停止命令、Base URL、密钥在本机的取得方式、接口兼容矩阵、通过与未通过的验证、审查结论及真实下一步。本文件保留初版设计与历史执行顺序；当前实施/验证/审查状态以顶部活跃计划和阶段证据为准，不能由设计文字推断云端可用。

## 参考资料

- [官方 Codex 认证](https://developers.openai.com/codex/auth)：账户登录与设备码流程。
- [官方 Codex 源码](https://github.com/openai/codex)：查询实际 client ID、换票、刷新、请求与模型目录；引用时记录所用 commit。
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)：协议兼容参考；复制代码需核对许可证与保留必要归属，不能复制账户池等无关模块。
- [Workers 时限](https://developers.cloudflare.com/workers/platform/limits/)：区分 HTTP duration、CPU 和后台生命周期。
- [DO 状态/并发 API](https://developers.cloudflare.com/durable-objects/api/state/)：异步交错与并发控制。
- [SQLite DO 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)：持久化边界。

以上平台资料为实施依据，开发时核对当前版本；仓库宣传、搜索摘要和代码注释不等于本项目的实测证据。

Phase-02同凭据诊断：[EGRESS-001](tasks/EGRESS-001.md)已完成，Node路径真实可用；临时链路已关闭，不替代纯Worker或生产API验收。
