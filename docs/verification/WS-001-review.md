# WS-001 独立 R2 审查

范围与基线：

fresh reviewer 未参与 WS-001 实施，仅审查 `src/codex/websocket-probe.ts`、`src/account.ts`/`src/types.ts` 的 WS 增量、`test/websocket-probe.test.ts`、`test/gateway.test.ts`、`scripts/probe-worker-websocket.mjs`、`scripts/test-probe-worker-websocket.mjs` 与 `docs/tasks/WS-001.md`。审查只读，未读取 Secret、未访问真实 Worker 或真实上游；MARKER-001 不在本轮范围。

风险及依据：

该诊断新增管理员真实凭据握手入口。契约要求严格管理员/default-off、固定 `https://chatgpt.com/backend-api/codex/responses` WebSocket GET、无 body/模型/frame、无 refresh/重试、5 秒握手限时、升级后最多观察 300ms 并 finally 关闭、非 101 使用有界脱敏诊断，且账号状态保持不变。runner 还需保存调用计数、脱敏结果和前后状态，不把本地 fixture 当作线上证据。

结论：通过

首轮问题与关闭证据：

1. **runner 前后状态比较过于粗粒度。** 修复后在内存中精确比较真实 schema 的 `account.id`、`tokenExpiresAt` 和 `lastRefreshAt`，公开报告仍只保留 stable 和粗窗口字段，不泄露账号标识。新增同窗口账号/时间变化回归确认 `stable:false`，同时保留 target 错误码和报告文件。

2. **helper 迟到 101 可绕过握手超时。** 修复后使用 Promise.race 硬 deadline，并在 race 返回及 fetcher 延迟返回时检查 aborted signal。迟到 101 只关闭 socket，不 accept、不 send；迟到普通响应取消 body。新增 5ms deadline/25ms迟到 101 回归确认抛出 timeout、`accepted:false`、`sent:0` 且只 close 一次。

验收覆盖与文档核对：

- `node --check scripts/probe-worker-websocket.mjs` 通过。
- `node --check scripts/test-probe-worker-websocket.mjs` 通过。
- `node --test scripts/test-probe-worker-websocket.mjs`：5/5 通过、无 skip。
- `npm.cmd exec -- vitest run test/websocket-probe.test.ts test/gateway.test.ts`：2 个文件、27/27 测试通过。
- `npm.cmd run typecheck` 通过。
- helper 测试覆盖固定 URL/headers、GET 无 body、101 accept、零 frame、事件 payload/close reason 不输出、非101诊断、101 缺 websocket、error/close/无事件观察、fetch/响应体 timeout、64KiB+1诊断体、finally close、迟到 101 清理；gateway 覆盖普通 key/未鉴权拒绝及默认关闭。
- runner fixture 覆盖 health、前后 status、一次 target、probe 成功字段脱敏、disabled 503、target 错误码保存、同窗口精确账号状态变化、断开账号时不发 target；静态核对确认每个请求有 `redirect:error` 和 15 秒 signal，报告写入项目 `output/ws-probe`。
- `docs/API.md` 与 `docs/DEPLOYMENT.md` 已补充端点、临时开关、一次握手预算和关闭步骤；未把本地测试写成线上成功。

本轮关闭/剩余问题、新增证据：

首轮两项问题均已由实质修复和新增回归关闭。本轮没有新的可执行问题；WS-001 可进入真实执行前的授权门禁阶段。

残余缺口和恢复条件：

没有真实 Worker/上游握手证据，也没有启用临时 Secret；这符合本轮限制。真实执行仍需严格遵守任务中的一次握手预算、无 frame、前后 status 稳定和完成后删除临时开关；真实结果不能由本地 fixture 推断。WS 不应因此改变普通 `/v1` 路径。
