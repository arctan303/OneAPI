# AUTH-001 实施与验证记录

日期：2026-09-06  
状态：本地实现与针对性验证完成；R2 首审问题已修复，独立聚焦复核通过；未部署。

## 适用基线与范围

- 开发前非秘密文件基线：`C:\Users\30330\AppData\Local\Temp\oneapi-auth001-baseline-df34ac0e144e4b479a41bfbe2684263d`。
- 工作区没有 Git 仓库，因此以主会话保存的文件快照和当前文件哈希对账。
- 本实现修改 `src/account.ts`、`src/index.ts`、`src/security.ts`、`src/types.ts`、`public/app.js`、`public/index.html`、`public/styles.css`、`scripts/sdk-compat.mjs`、`vitest.config.ts`、`wrangler.mock.jsonc`，新增 `.dev.vars.test` 和 `test/auth.test.ts`。
- `.gitignore` 与产品/任务契约由主会话并行维护，不计为本实施者代码成果。
- 没有手工读取、修改或输出真实 `.dev.vars` 的内容，也没有手工读取或修改真实 `.wrangler`、Codex/OpenCode 凭据；早期测试插件曾自动加载真实 `.dev.vars`，具体边界和修正见“自动化证据”。没有停止或重启 8787 的真实 Demo；没有主动执行真实登录、刷新、模型、生成、部署或推送。

## 已实现行为

- `POST /admin/session` 使用现有 `ADMIN_API_KEY` 作为管理员口令，创建服务端随机 32 字节会话；Cookie 为 HttpOnly、SameSite=Strict、Path=/admin，HTTPS 带 Secure，HTTP 只允许 loopback；有效期 7 天。
- `GET /admin/session` 只返回 `authenticated` 与 `expiresAt`；`DELETE /admin/session` 在修改存储前读取并只接受空 JSON 对象，再撤销当前会话并清 Cookie，不清除 Codex OAuth 凭据或 API 密钥。会话跨 Durable Object 重建恢复；过期会话清理；最多保留 8 个有效会话。
- 失败登录按单个本地管理员实例限制为 15 分钟内 5 次；只保存失败时间戳，不保存提交口令。
- 管理 Cookie 的写操作必须提供精确同源 `Origin` 和 `application/json`；所有管理请求拒绝不同 scheme/host/port、`Origin: null`，并拒绝 `Sec-Fetch-Site: same-site/cross-site`。伪造 Cloudflare 身份头不会获得权限。无 Origin 的旧管理员 Bearer 自动化继续可用。
- `POST/GET /admin/api-keys` 和 `DELETE /admin/api-keys/:id` 支持命名 API 密钥创建、掩码列表和撤销；最多 32 个、名称唯一。密钥由服务端随机 32 字节生成，完整值只在 201 创建响应返回。
- 会话与 API 密钥只持久化 SHA-256 摘要和必要元数据；API 密钥列表和存储不含完整值。完整 key 不进入 URL、日志或浏览器持久化存储。
- `/v1/*` 同时接受原 `GATEWAY_API_KEY` 和未撤销的新 API 密钥；明确拒绝管理员 Bearer。API 密钥不能登录或访问管理接口；管理 Cookie 不作为 `/v1` 调用凭据。
- `/admin/test/models`、`/admin/test/responses`、`/admin/test/chat/completions` 使用管理员登录态完成内置测试，不要求创建 API 密钥。
- 页面改为登录页和单管理员控制台，提供 Codex 连接、模型测试、API 密钥与当前 `/v1` Base URL。退出后台与断开 Codex 分开。请求绑定发起时的 UI epoch：当前 epoch 的 401 才触发失效清理，旧 epoch 的成功或失败响应不能覆盖新登录；用户提交登录会先推进 epoch，未完成的恢复请求不能丢弃成功登录。退出或当前 401 会清除完整 key、对话、设备码和列表等临时 DOM 状态。

## 自动化证据

最终证据均在显式 Mock 环境中运行。Vitest 使用 `environment: test` 和固定的 `.dev.vars.test`；Wrangler 日志只显示加载该测试文件。

修正隔离前曾运行一次 `npm.cmd test -- --run test/gateway.test.ts`，Wrangler 插件日志明确显示自动加载了真实 `.dev.vars`；这构成一次非预期读取，不能写成“没有读取”。实施者没有手工打开该文件，测试日志也没有输出其中的值。当时 `vitest.config.ts` 的 Miniflare bindings 和 `wrangler.mock.jsonc` 都显式设置 `MOCK_UPSTREAM: "true"`；该次 15/15 通过包含 Mock 设备码、固定 Mock 模型/回复和 `mockUpstreamStats()` 计数断言，提供了实际执行仍走 Mock 上游的正面证据。没有观察到真实上游请求，也没有证据表明发生过真实上游请求。

该次运行使用 `@cloudflare/vitest-plugin` 的本地 Miniflare `SELF` 和测试隔离 Durable Object，不连接 8787 Demo；测试按预期写入并清理隔离的 Mock DO storage，没有写入真实 Demo DO 状态的证据。发现自动加载后，配置改为显式 `environment: test` 和 `.dev.vars.test`，并重新取得下表全部最终证据；没有为了复现问题再次运行早期配置，也没有读取真实 `.dev.vars` 内容。

| 命令 | 结果 | 证明范围 |
| --- | --- | --- |
| `node --check public/app.js` | 通过 | 管理页脚本语法，包括退出清理与 epoch 防迟到逻辑 |
| `npm.cmd run typecheck` | P2 修复后通过 | Worker、Durable Object 与测试 TypeScript 类型 |
| `npm.cmd test` | P2 修复前全量基线：3 个文件、23 项全部通过 | 旧网关/OAuth/SSE 回归；会话正确/错误/过期/退出/重建；当前会话撤销；失败限流；会话/key 上限；精确同源、Origin null、Sec-Fetch-Site、伪造 CF 头、缺 Origin、非 JSON；内置普通/流式测试；key 一次明文、掩码列表、摘要存储、重建、撤销和权限隔离。P2 修复后未冒充重新运行全量套件 |
| `npm.cmd test -- --run test/auth.test.ts` | P2 修复后 1 个文件、7 项全部通过 | AUTH-001 针对性回归；新增证明退出 `{}` 成功、非空对象与非法 JSON 均为 400 且不会撤销当前会话 |
| `npm.cmd run test:sdk` | 通过 | OpenAI Node SDK 7.10.0 使用新命名 key 完成 models、Responses 普通与 SSE，撤销后 401；旧调用密钥的 models、Responses 普通/流式/多轮/工具、Chat 普通/流式、并发与取消继续通过 |
| `npm.cmd run build` | 通过 | Wrangler 4.129.0 dry-run；Worker、Durable Object 绑定和 3 个静态资源完成打包 |

主会话在独立 8791 Mock 中完成普通流程验收，覆盖登录、Codex Mock 连接、无需 API key 的模型目录与流式回复、刷新恢复会话、key 一次显示/复制/隐藏/列表保留/撤销、退出后重新登录保留 Codex 和 key，并已视觉检查 `output/playwright/auth001-admin.png`。最终修复后的以下脚本在 nonce `auth001-ui-final2` 的独立 8791 Mock 实例均退出码 0，运行时 stderr 为空：

- `output/playwright/auth001-late401.js`：挂起旧 epoch 401，完成重新登录并展示新 key 后放行，控制台、新会话、新 key 和 key 面板四项断言均保持。
- `output/playwright/auth001-current401.js`：当前 epoch 401 后登录页显示、控制台隐藏、完整 key 清空、key 面板隐藏四项断言均为 true。
- `output/playwright/auth001-restore-race.js`：迟到的空会话恢复结果不会覆盖用户主动成功登录。
- `output/playwright/auth001-race.js`：正常退出后的迟到 key 成功响应不会重新填入；五项清理断言均为 true。
- `output/playwright/auth001-login-cycles.js`：无拦截连续三轮登录/退出均为 POST 200、DELETE 204。

聚焦浏览器准备阶段曾出现 POST `/admin/session` 500，并由 workerd 原生报错 `Can't read from request stream after response has been sent` 后使独立 Mock 退出；该次没有完成 P2 复现。只读对账发现当时 `DELETE /admin/session` 是唯一接收 `{}` 却未消费请求体的管理删除路径，修复为响应前读取并验证空 JSON 后，同路径在最终实例通过。但没有原生堆栈，因此只能记录关联和修复后的通过证据，不能宣称已完全证明该运行时错误的唯一因果。

## 未证明与后续

- 没有验证真实 Codex 上游、自然 token 刷新、Cloudflare Access、云端部署或生产 Cookie 行为；现有 Demo 上游 403 没有处理，也没有改变模型或上游协议。
- Cloudflare Access 是未来线上门禁，本实现不信任或解析任何 Access 身份头。
- R2 首审已经完成并提出一个代码 P2；实现已修复并取得针对性证据，同实例独立聚焦复核通过，无剩余 P0/P1/P2。
