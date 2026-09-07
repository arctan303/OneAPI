# SERVER-001 轻量单服务器验收

日期：2026-09-07。契约：[Phase-03](../dev-plan/phase-03.md)、DEC-014/REQ-17/AC-17。当前状态：实现、隔离验证、独立 R2 复核、实际账号迁移与有限真实调用均完成。未部署新服务器，未修改现有 Cloudflare Worker、域名或云端账号。

## 实现与隔离证据

- `src/account-core.ts` 和 `src/gateway.ts` 复用业务，`src/account.ts`/`src/index.ts` 保留 Worker 兼容宿主。
- 新 `src/runtime/node/` 使用原生 SQLite、固定官方出站、静态资源和日志定时清理；`server/` 提供生产配置与原生 HTTP。生产没有 Wrangler/Miniflare/workerd，也没有外部 npm 运行依赖。
- `npm run test:server`：9/9 通过。覆盖设备 OAuth、密文持久化、key 模型权限和目录元数据、官方额度窗口、两协议/流式/思考程度/日志、重启、Access JWT/JWKS、Host、会话、取消与租约、日志清理、事务回滚与并发/独占锁。新增真实环回 HTTP + OpenAI SDK 7.10.0 的 mock 两协议测试，maxRetries=0、0真实出站。
- 原 Worker 全量 `npm test`：84/84；`npm run typecheck`、旧 Worker dry build 均通过（Sol 执行）。
- `npm run test:server:fixtures`：11/11 通过（root 执行）。迁移 3 项：密文/keys/Access/已结束日志保留，源指纹不变，错误密钥和源锁拒绝，非空目标拒绝；HTTP 5 项：配置白名单、Host/代理头/cookies、体积限制、单请求取消、SSE 取消；清理硬截止 2 项：正常返回/永不完成任务均有界结束；发布包 1 项：manifest 文件复制到独立临时目录，无 node_modules，直接 Node 启动，页面/健康 200、未认证管理 401。
- 当前构建主程序 253341 bytes，manifest 内容合计 342855 bytes，生产 npm 依赖 0。这些是未压缩文件大小，不包含 Node.js、数据库或运行内存；最终打包后以 manifest 为准。

## 迁移与真实验收门禁

`scripts/migrate-server.mjs` 只迁移本项目旧本地存储，旧库 read-only、持有旧 Node 专用锁并验证源指纹，目标必须不存在；密文原样保留，校验解密仅在内存中进行。旧 Wrangler 不遵守 Node 锁，必须先停旧进程。迁移不包含管理员会话、进行中的登录/调用、租约或缓存。

`scripts/verify-server-live.mjs` 使用最终 bundle 和原生 HTTP，出站包装强制上限：models 1、usage 1、Responses 生成 2（对外 Responses/Chat 各 1）；SDK 重试 0，OAuth 刷新 0。任意上游拒绝/异常后封闭后续出站。临时 key 到期且最终撤销，原日志捕获设置恢复。真实输出仅记录状态、模型能力、用量和文本长度，不输出凭据或请求/响应全文。

独立审查与一次聚焦复核均通过，见 [SERVER-001-review.md](SERVER-001-review.md)。其后才执行实际迁移和真实调用。

## 发布与适用范围

构建：`npm run build:server`。打包：`node scripts/package-server.mjs`，严格校验 manifest 与文件清单、拒绝额外文件/符号链接，内存检查本机已配置 secrets 是否出现在包内；输出 `dist/oneapi-server-0.2.0.tar.gz` 和 SHA-256。

部署说明：[DEPLOYMENT.md](../DEPLOYMENT.md)、[部署模板](../../deploy/README.md)。Linux systemd/Caddy 模板未在目标 Linux 主机实机部署。当前没有用户提供的服务器目标；本机成功不能证明任意服务器 IP/网络都能访问上游。

Cloudflare Access 保留应用端 JWT 验证与管理员口令兜底；未实际创建新的 Access 应用或验证用户真实 Access 策略。边缘门禁拦截需要在 Cloudflare 控制台关闭或收窄。

参考项目研究见 [SERVER-TRANSITION-worker-research.md](SERVER-TRANSITION-worker-research.md)：8 个新增候选未找到可复现的纯 Worker 订阅直连成功证据，不能推出所有纯 Worker 实现绝对不可行。

## 实际迁移与调用结果

迁移 `migrated:true, accountMigrated:true`，保留 4 个持久键和 9 条已完成日志，0 条活动日志，未迁移管理员会话。`.env` 独占创建，沿用旧三项 secret，未打印值。

- 旧主库迁移前及最终 SHA-256 均为 `E02E1566507F5D2C4CFD5AEDD470C442DAC8A6FCBD9A248D0ACFAD2FDCFB91CE`。
- 新主库迁移后、首次启动前 SHA-256：`BCF22ACDBF7D02E6505C79F5D5C801260F106775FA1AEEFB5486995295EE3E36`。运行后有正常会话/cache/log 写入，不要求继续等于该值。
- 初次 runner 已真实 models 200；随后 root 误把 `/admin/test/models` 主动刷新当作缓存读取，第二次出站被本地预算拒绝，0 usage/0 generation。删除多余管理调用后重新执行一次修正验收；未修改生产协议。初次证据保留 `output/server-live/acceptance-initial.jsonl`。
- 修正轮 `/v1/models` 200，仅允许 `gpt-5.5` 的临时 key 只得到该模型。官方思考程度为 `low, medium, high, xhigh`，实测选择 `low`。
- 官方 usage 200：七天剩余 87%，重置 `2026-09-14 10:33:36 +08:00`；五小时窗口为 null，未从其他窗口或本地 token 统计推算。这是本次官方响应未提供的数据，不是 403。
- OpenAI SDK Responses 普通调用与 Chat SSE 各 1 次，均返回完成文本（各 2 字符），上游 HTTP 200；各 input 9/output 17/total 26 tokens。基础日志不保存 body，完整日志保存请求/响应并匹配思考程度及 token 用量。
- 全阶段实际上游合计 models 2、usage 1、generation 2，0 自动重试、0 OAuth 刷新。初次本地预算拦截不算真实上游请求。
- 两轮临时 key 均撤销，原 key 集合保持，日志捕获设置恢复，测试会话关闭，运行器退出 0（修正轮）。原账号无需重新授权。

证据文件位于被 Git 忽略的 `output/server-live/`：migration.jsonl、acceptance-initial.jsonl、acceptance.jsonl、restart.jsonl。只记录安全摘要；完整日志保留在新 SQLite，未打入发布包。

## 当前可用入口与发布产物

实际生产入口已启动：`http://127.0.0.1:8787/`，API `http://127.0.0.1:8787/v1`，Node v24.15.0，当前 PID 23240（停止前必须核对命令和进程，不把固定 PID 当永久入口）。重启后 health 200，管理员登录及账号 connected:true/reauthenticationRequired:false 验证通过，检查没有发送上游请求。

Windows 本机启动空闲时的单次样本：WorkingSet 53272576 bytes（约 50.8 MiB），PrivateMemory 64462848 bytes。不是 Linux/VPS 压测或稳定性承诺，不包括 Node 安装、反向代理和未来日志数据。

最终产物 `dist/oneapi-server-0.2.0.tar.gz`：82208 bytes；SHA-256 `7237710ef38dc4cbb6eeb2eb746fe69c860f84e4e8f533d70d7f8b6861ecf638`。12 个文件（含 manifest），0 外部 npm 运行依赖。配置秘密扫描 9 个值、产物命中 0；未打包 `.env`、`.dev.vars*`、SQLite、日志或输出目录。源代码构建需要锁文件中的开发依赖，不能把生产零依赖写成构建无需 npm。

未执行 Git 推送或真实远端服务器部署；原 `api.arcinks.com` Worker 不变，仍不能据本地结果宣称该域名的纯 Worker 生成已修复。后续拿到目标服务器再验证其出口、HTTPS、systemd 与真实 Access 策略。