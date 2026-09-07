# SERVER-001 R2 独立审查

范围与基线：

- 审查者为未参与 SERVER-001 实施的 fresh reviewer。范围为 `src/account-core.ts`、`src/account.ts`、`src/gateway.ts`、`src/index.ts`、`src/runtime/**`、`src/types.ts`、`server/**`、`scripts/build-server.mjs`、`scripts/migrate-server.mjs`、`scripts/setup-server.mjs`、`scripts/verify-server-live.mjs`、`scripts/package-server.mjs`、`deploy/**` 及相关隔离测试。
- 契约依据为 `docs/dev-plan/phase-03.md`、`docs/Product-Spec.md` 的 DEC-014 与 SERVER-001/REQ-17/AC-17。
- Git `HEAD` 基线：`efd57b9d96c394c944574fb0cf39daf17e0d3c36`。工作树含其他任务的未提交修改；本报告不冒认这些修改为本审查产物。关键当前文件 hash 已记录于本报告末尾。
- 未读取真实 `.env`、`.dev.vars`、账号库或 Secret，未访问真实上游/云端；仅使用隔离 mock 和静态检查。

风险及依据：

SERVER-001 属于 R2：替换 Worker 宿主与持久化实现，影响管理员鉴权、Access JWT、OAuth 加密状态、并发事务、请求取消及迁移数据完整性。审查重点是可观察的权限边界、源库不变、SQLite 原子性/锁/重启告警、取消和无生产 Worker 依赖。

结论：通过

代码与隔离行为未发现新的可执行鉴权绕过、任意 Host/Origin 信任、OAuth 密文/Secret 输出、SQLite 事务/独占锁回归、请求取消泄漏或生产构建引入外部 runtime 的 blocker。迁移和有限真实验收前需处理下列两个可执行门禁问题，并同步文档状态。

问题：

- 上一轮 P2（verify-server-live.mjs cleanup 无 hard deadline）已关闭。当前 finally 通过 cleanupWithDeadline(..., 15000) 设置 15 秒总上限；cleanup 首先 abort 全部 runner 保存的上游 controllers，然后分别尝试恢复日志设置、撤销临时 key 并核对原 key 集合、关闭管理员会话，最后关闭 HTTP/runtime。每个阶段发出脱敏成功/失败事件；超时事件只包含阶段和毫秒数并以退出码 1 结束。
- 上一轮 P2（deploy/README.md:31 的 pm run typo）已关闭。当前行 31 为 npm run build:server，会生成 dist/server/...，与前置命令和 docs/DEPLOYMENT.md 一致。
- 当前未发现新的可执行问题。

验收覆盖与文档核对：

- `node --test scripts/test-server-http.mjs`：5/5；覆盖 HTTPS/public listener 配置、Host 与 forwarded header 边界、独立 Cookie、请求大小、断连只取消对应请求及流响应取消。
- `node --test scripts/test-migrate-server.mjs`：3/3；覆盖加密凭据/API key/Access/已完成日志迁移、源文件 hash 不变、目标已存在、错误密钥无目标、源运行锁拒绝。
- `npm run test:server`：9/9（parent 最新）；覆盖 SQLite 并发 KV 事务和 rollback、独占锁/重开、runtime 重启持久化、alarm 清理、OAuth/key/model/reasoning/usage/Responses/Chat SSE/logs、Access JWT/JWKS、Host/session、禁用诊断、取消与 lease 回收、固定出站目标和 header/redirect/signal。
- `node --check` 已通过 `scripts/verify-server-live.mjs`、`scripts/package-server.mjs`、`scripts/migrate-server.mjs`、`server/config.mjs`、`server/http.mjs`、`server/main.mjs`。
- Parent 提供的当前证据：Worker 相关回归 84/84、typecheck、server build、迁移+HTTP 合成 8/8、最终产物测试 1/1；package runner 已通过本地构建/清单/哈希/零 runtime package 检查。该报告未执行 package runner，以遵守不读取真实环境文件的限制。
- 静态核对确认 Node 生产入口只从四个生产配置字段构造 `AccountService`；`MOCK_UPSTREAM`、诊断、导入和 Worker-only 配置不会从 server config 进入生产 runtime。出站固定 ChatGPT 目标、禁止重定向并删除 Node fetch 已解码的 wire encoding/length header。HTTP 只信任精确 Host/public origin 或 loopback peer，忽略客户端 forwarded identity；Gateway 对 admin mutation 实施同源/CSRF 和 JSON 边界；Access JWT 验 issuer/audience/exp/nbf/RS256 JWKS。
- `docs/Product-Spec.md:141 已更新为 SERVER-001“实现完成，待真实验收”；docs/dev-plan/phase-03.md:3 已更新为实现与隔离测试完成、R2 审查进行中。文档不把当前隔离验证写成已在真实服务器部署。

本轮关闭/剩余问题、新增证据：

- 已关闭：live cleanup 无界等待；node --test scripts/test-cleanup-deadline.mjs 2/2（正常清理与永不完成 cleanup 均在测试预算内结束），node --check scripts/verify-server-live.mjs 通过。Parent 补充的最终隔离 fixture 汇总为 11/11。
- 已关闭：deploy/README.md 构建命令 typo；逐行核对确认修复。
- 已关闭：Product-Spec 与 Phase-03 的实施/验证状态已同步；Product-Spec 当前标为“实现完成，待真实验收”。
- 无真实迁移、真实账号/上游或远端服务器证据，因此不能把隔离通过写成真实生产通过。
- 当前关键修复 hash：verify-server-live.mjs 98d4400ebd663c9255afcde147a9909d7d2e2286；cleanup-deadline.mjs cb32087461730cd8148d50ecbbf70f6d4df88072；test-cleanup-deadline.mjs 00b1c928076b8db55a9f04c72cd90240c64742c3；deploy/README.md fbd0cfbb78ac3d1537718cbb5545db0f45a2cc00；Product-Spec.md 380aea7f20745448e25f7173e04f44de58d0c5ad。

批量复查时：覆盖 SERVER-001/REQ-17/AC-17、DEC-014；上一轮问题 1 和 2 已满足修复与聚焦回归证据，可移入已关闭项；当前无剩余代码门禁。Product-Spec 状态已同步，本轮无剩余 R2 门禁。

残余缺口和恢复条件：

- 已完成：cleanup 修复后的 2/2 deadline 回归、runner syntax 和部署文案检查均通过；无代码门禁剩余。
- 之后才可按 Phase-03 的有限预算执行独立目标目录迁移；保留源库并记录源 hash、目标 hash、迁移码和清理结果。真实两协议验收必须沿用 runner 的固定次数、0 自动重试和失败封闭规则；不宣称未实测服务器出口可用。
