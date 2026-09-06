# AUTH-001 R2 fresh 独立审查

日期：2026-09-06  
阶段：首轮独立审查与同实例聚焦复核完成  
结论：**通过**（首轮 1 个 P2 代码问题与 1 个 P2 文档同步问题均关闭；未发现剩余 P0/P1/P2）

## 范围与基线

- 审查者未参与 AUTH-001 实现。本轮只审查单管理员 Cookie 会话、命名 API key、管理页、Mock/SDK 兼容与对应文档；没有扩张为全仓安全审计。
- 有效产品契约：`docs/Product-Spec.md` 的 DEC-007/008、AUTH-001、REQ-05/08，以及 `docs/tasks/AUTH-001.md`。已替代的“页面反复填写管理员/调用密钥”不是有效要求。
- 开发前源码快照：`C:\Users\30330\AppData\Local\Temp\oneapi-auth001-baseline-df34ac0e144e4b479a41bfbe2684263d`；工作区无 `.git`。
- 初审关键哈希：`public/app.js BDBDB6D8D39242AD9C634860E6834C0017099A54B4B7ECED335DDA0CA46A3093`、`src/account.ts D777415C9036BB023BB6C1E9E8A3015C8BAC12E867B8FEB1D55D9A5BAFD31551`、`test/auth.test.ts 16C42E436002A4C86BC12E1D695C711EC8113D2D04DECB9F5DD53FBC92974D02`。
- 聚焦复核固定修后输入：`public/app.js BEAE18AFF1A93D53F1787084C3688684DEDC401030A8C25CE2590006B6B857D4`、`src/account.ts D01B5D23C4690469833650F7A76C753B11C2245F1EDB31E844D5CE64681E842D`、`test/auth.test.ts 532BD268C9926CD2861AABCFBCDBD65D4AACA64434C0F375E52D31710C241BEC`。其余初审代码证据未因聚焦修复失效。

## 风险及依据

R2：新增 Cookie 管理授权与可创建的外部调用凭据，错误的同源判断、权限分流、持久化或撤销可能控制 Codex 连接、暴露调用能力或消耗订阅。审查重点固定为浏览器请求语义、会话/API key 隔离与生命周期、退出竞态、测试环境隔离、OAuth 与流式调用回归。

## 问题与关闭证据

### P2-01（已关闭）：旧会话的迟到 401 可以清掉重新登录后的有效后台界面

首审证据：旧版 `public/app.js` 的 `adminCall()` 没有保存请求发起时的 epoch，任何 401 都会先无条件执行 `showLogin()`；调用方只在成功响应后检查 epoch。因此，旧 Cookie 请求若在重新登录后才返回 401，会覆盖当前新会话 UI，并可能清掉刚显示且无法再次取得明文的一次性 API key。修前浏览器尝试因 Mock 500 中断，不能写成成功复现；源代码控制流足以确认缺陷。

修复：修后 `public/app.js:60-93` 为 restore 与 login 绑定 epoch，登录入口先递增 epoch；`public/app.js:96-115` 让 `adminCall()` 只在请求发起 epoch 仍为当前值时处理 401；其余相关异步 catch/DOM 回写也检查所属 epoch。

关闭证据：主会话在独立 8791 Mock（nonce `auth001-ui-final2`）持住旧 `GET /admin/status`，随后真实退出 204、重新登录 200、创建新 key 201，再放行旧 401；`currentSessionVisible`、`loginHidden`、`newKeyPreserved`、`newKeyPanelVisible` 均为 true。当前 epoch 的 401 仍使 `loginVisible`、`consoleHidden`、`keyEmpty`、`keyPanelHidden` 全为 true。迟到空 restore 被忽略；退出后的迟到成功响应仍不回填。四个竞态脚本均退出码 0。

### P2-02（已关闭）：两处文档保留已替代状态

首审证据：`docs/DEV-PLAN.md:28-29` 的旧架构图仍写页面使用管理员密钥，`docs/Product-Spec.md:17-18` 的 DEC-007/008 状态仍写实施中。

关闭证据：`docs/DEV-PLAN.md:28-29` 已原位更新为“管理员页面 ── 登录会话 ──> `/admin/*`”和“第三方 SDK ── API key ──> `/v1/*`”；`docs/Product-Spec.md:17-18` 已同步为“实现与验证完成、审查中”。聚焦复核只读确认后，两处均未再复活页面双 key 规则。

## 验收覆盖与文档核对

- 鉴权与 CSRF：管理 Cookie 为 32 字节随机值，仅存 SHA-256 摘要；`HttpOnly`、`SameSite=Strict`、`Path=/admin`，HTTPS 增加 `Secure`，HTTP 仅允许 loopback。管理变更要求精确同源 `Origin` 与 JSON，拒绝 `Sec-Fetch-Site: same-site/cross-site`；无 Origin 的旧管理员 Bearer 自动化保留。
- 权限分流：管理员会话和旧管理 Bearer 只进入 `/admin/*`；新命名 key 与旧 `GATEWAY_API_KEY` 只进入 `/v1/*`；管理员 Bearer、管理 Cookie 和 API key 不能相互提权。
- 生命周期：会话最多 8 个、7 天到期；API key 最多 32 个、32 字节随机熵、仅创建响应返回完整值、列表与存储无明文；撤销后的新请求返回 401。退出只删当前会话摘要，不触碰 OAuth 与 API key storage；已鉴权在途 API 请求继续符合契约。
- 初审独立运行 `npm.cmd test`：3 文件、23/23 通过，日志三次明确只加载 `.dev.vars.test`。当前 Vitest 将 Wrangler environment 固定为 `test`，Miniflare 另有显式 Mock bindings，未使用真实 Demo storage。
- 初审独立运行 `npm.cmd run typecheck` 与 `node --check public/app.js`：退出码均为 0。
- 初审独立运行 `npm.cmd run test:sdk`：第一次在 Wrangler 启动阶段以 Windows 进程码 `3221226505` 退出，未启动服务或发 SDK 请求；确认 8790 未占用后一次有界重试通过，覆盖新 key 的 models/Responses 普通与 SSE/撤销后 401，以及旧 key 的 models、Responses 普通/流式/多轮/工具、Chat 普通/流式、并发与取消。
- 聚焦修复后独立运行 `npm.cmd test -- --run test/auth.test.ts`：1 文件、7/7 通过，日志只加载 `.dev.vars.test`。新增断言证明 DELETE session 对非空/畸形 JSON 返回 400 且不撤销会话，`{}` 返回 204；独立再次运行 `node --check public/app.js` 通过。父会话的修后 typecheck 通过。
- 聚焦期间发现 `deleteAdminSession` 未消费 `{}` 请求体。修后它在任何 storage 修改前调用 `readJsonBody()` 并只接受空对象。独立 8791 Mock 无拦截连续 3 轮 POST session 200、DELETE session 204 均通过，`final2.err.log` 为空。
- 复用实现者 dry-run build、SDK 与父会话完整浏览器流程证据；截图不含明文 key。没有调用真实上游。
- `docs/verification/AUTH-001-implementation.md` 已如实记录：早期一次测试插件曾自动加载真实 `.dev.vars`，但显式 Mock flag、Mock 行为断言与隔离 DO 表明该次仍走 Mock；修正后所有最终证据均只加载 `.dev.vars.test`。这不是“从未读取”，也没有观察到真实上游请求。

## 本轮关闭、剩余问题与新增证据

- P2-01 已由 epoch 归属修复及真实浏览器回归关闭；P2-02 已按有效决定原位修正文档。
- 聚焦期间的 DELETE session 请求体消费问题已由最小后端修复、AUTH 7/7 与连续三轮浏览器登录/退出关闭。
- 没有剩余 P0/P1/P2。未发现鉴权绕过、跨站管理、明文 key/session 持久化、撤销失效、OAuth 被 logout 清除、旧 `GATEWAY_API_KEY` 或 SSE 回归。
- 新增证据：初审哈希上的独立 23/23、typecheck、app.js 语法及 SDK 有界重试通过；聚焦哈希上的 AUTH 7/7、app.js 语法、父会话 typecheck 与五组浏览器竞态/循环证据通过。

## 残余缺口和恢复条件

- 未验证真实 Codex 上游、自然 token 刷新、Cloudflare Access、云端生产 Cookie/路由或部署；这些未获本轮授权。既有 ChatGPT Codex 上游 403 未解决，且不是 AUTH-001 鉴权变更缺陷。
- 修前一次 old-401 浏览器尝试因 8791 Mock 返回 500 并退出，workerd 报告 `Can't read from request stream after response has been sent`。修后 DELETE session 会先消费并验证请求体，同场景与连续三轮登录/退出均未再出现 500，但缺少原生堆栈，不能把间歇性 500 的完整根因写成已证明；这不影响当前聚焦行为验收通过。
- 审查者为生成快照统计曾误用一次从基线目录比较整个工作区的 `git diff --no-index --stat`。该命令为计算差异实际读取并遍历到 `.dev.vars` 与 `.wrangler`；输出仅出现路径和换行警告，没有显示任何 secret 或状态内容，命令没有修改文件、访问网络或触碰运行实例。此操作违反本轮“不读取/不遍历这些路径”的限制，之后已停止并改用显式白名单文件。该事实是审查执行边界缺口，不能写成完全遵守了隔离限制；已与早期测试插件自动读取事件合并登记为 `.codex/evolution/signals.md` 的 `EVO-001`。
