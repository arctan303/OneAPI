# OneAPI 使用说明

更新时间：2026-09-08。当前产品主路径是轻量单服务器：Node.js 24.x（至少 24.15）、一个生产 bundle、一个 Node 进程和一个业务 SQLite 文件。dev.4 已在本机用真实账号跑通 Codex 0.153.4 模型目录、文本、只读工具续轮与未知字段兼容，并完成桌面/390px 后台验收、fresh R2 审查和 GitHub prerelease/附件回下载校验；发布状态见 [RELEASE-005](verification/RELEASE-005.md)。用户已有远端 Node 安装，本次不会自动升级或部署。

## 新服务器流程

新账号在项目根目录运行：

```powershell
npm ci
npm run build:server
npm run setup:server
npm start
```

根 `npm run build` 已默认构建 server，`npm run build:server` 是同一构建入口。构建产物位于 `dist/server/`，包括 `oneapi.mjs`、`migrate.mjs`、`public/`、`setup.mjs`、`.env.example` 和部署模板。生产运行时使用 `dist/server/oneapi.mjs`，不需要加载 Wrangler 或 Miniflare。

setup 默认生成项目根 `.env`，使用独占创建；已有文件只报告 unchanged，不覆盖、不打印 secret。默认值为 `HOST=127.0.0.1`、`PORT=8787`、`DATA_DIR=./data`。公网反代部署时，`PUBLIC_ORIGIN` 必须是准确的 HTTPS origin。生产安装、systemd、Caddy 和文件权限见 [部署说明](DEPLOYMENT.md) 及 [部署模板](../deploy/README.md)。

后台默认地址是 [http://127.0.0.1:8787/](http://127.0.0.1:8787/)，外部 API Base URL 是 `http://127.0.0.1:8787/v1`。管理员使用 `ADMIN_API_KEY` 登录，第三方使用后台创建的 API key。连接自己的 Codex 账号时，在官方网页完成设备码授权；已有有效账号可以直接加载模型。已验证官方模型、七天额度和 Responses/Chat 两种协议；五小时窗口本次官方未返回，显示未知。函数工具的兼容范围见 API.md。

## 已有账号迁移

有旧 Wrangler/SQLite Durable Object 账号时，先停止旧的 `npm run dev` 或 `npm run dev:node` 进程。旧账号必须沿用原有三个 secret：`ADMIN_API_KEY`、`GATEWAY_API_KEY`、`TOKEN_ENCRYPTION_KEY`。不要对已有账号运行 setup 产生新值；setup 不覆盖已有文件，但换密钥会导致旧账号凭据无法解密。

完成 `npm run build:server` 后，在目标不存在时运行固定迁移命令：

```powershell
node --env-file=.dev.vars dist/server/migrate.mjs --legacy-root .wrangler/state/v3 --target data/oneapi.sqlite
```

迁移从 `.dev.vars` 读取原加密密钥，旧源以 read-only 打开，源数据库及 WAL 不修改；目标 `data/oneapi.sqlite` 必须不存在，旧 Node runtime 活跃时会因锁检查失败；直接运行的 Wrangler 不遵守该锁，必须手动停止。目标发布后，把原三 secret 安全安装到新服务器 `.env`/EnvironmentFile，并补充 HOST、PORT、DATA_DIR、PUBLIC_ORIGIN，不展示或提交文件内容。SQLite 的 WAL、SHM、锁辅助文件属于正常运行状态。旧 `.wrangler/state/v3` 和 Cloudflare 实验状态保留，迁移不删除源库。

## 管理员登录与 API

Cloudflare Access 的两个应用参数是 Team Domain 和 Application AUD。OneAPI 只校验 Access 身份，不创建 Cloudflare 应用或策略。dev.4 根路径跳转到 `/admin/login`，登录后进入 `/admin/`；Access 保护 `/admin/*` 即可让浏览器先完成 CF 登录。Access 应只保护管理路径；`/v1` 必须保持 API 访问，不要让它触发交互式登录跳转。

管理员 API key 是应用层兜底。若 Access/WAF 在 Cloudflare 边缘卡住，请在 Cloudflare 控制台关闭或收窄门禁，使请求到达应用；仅关闭 OneAPI 内的 Access 配置无法恢复边缘已拦截的请求。管理员会话、API key 和 Codex 账号是不同边界；不要把管理员 key 给第三方客户端。

## 启停、数据与检查

- 新服务器：`npm start`；停止运行的终端按 Ctrl+C，生产环境按 systemd 管理。
- 旧 Worker 本地入口仍是 `npm run dev`；旧 Node 开发入口仍是 `npm run dev:node`。两种旧 runtime 不得与新服务器并发打开同一个账号存储。
- 新服务器业务文件是 `data/oneapi.sqlite`；不要删除、复制覆盖或并发打开。换版只切换 release，不删除数据目录。
- `npm run setup` 是旧 Worker 配置初始化；`npm run build:legacy` 保留旧 Worker dry-run，根 `npm run build` 已改为 server。
- `npm test`、`npm run typecheck`、`npm run test:dev-node`、`npm run test:extensions` 是隔离检查入口。它们的历史结果不等于新服务器生产验收。
- `npm run smoke:live` 和 `npm run smoke:extensions` 会触发账号/订阅调用，必须在单独诊断预算内运行；不属于默认启动流程。
- 新服务器隔离验证：`npm run test:server`、构建后 `npm run test:server:fixtures`。真实模型、额度、两协议及重启已通过，完整证据见 SERVER-001。

## 旧命令、Worker 实验与历史资料

`npm run build:worker`、`npm run deploy:worker`、`npm run worker:domain`、`npm run worker:secrets:prepare`、`npm run worker:secrets:upload` 和 `npm run worker:import` 均保留作旧 Worker 实验复核，不是新服务器部署路径。完整旧流程与 Access 记录见 [DEPLOYMENT.md](DEPLOYMENT.md) 的历史章节。

以下链接保持原有 Git 归档、诊断和证据入口；它们的结论只适用于各自记录的时间、运行时和范围：

- [Phase-01](verification/PHASE-01.md)、[LIVE-001](tasks/LIVE-001.md)、[LIVE-001 独立复核](verification/LIVE-001-review.md)
- [MARKER-001](verification/MARKER-001.md)、[WS-001](verification/WS-001.md)、[无令牌四路径观测](verification/PURE-WORKER-001.md)
- [WORKER-403](maintenance/WORKER-403.md)、[403 运行时诊断](verification/403-runtime-diagnosis.md)
- [EGRESS-001](tasks/EGRESS-001.md)、[WS-001 任务](tasks/WS-001.md)
- [AUTH-001](tasks/AUTH-001.md)、[接口与限制](API.md)、[产品契约](Product-Spec.md)、[开发计划](DEV-PLAN.md)
- [归档记录](verification/ARCHIVE-001.md)、[历史 Worker 部署](DEPLOYMENT.md)

Git 归档目标仍为 arctan303/OneAPI，第一版为 v0.1.0；归档细节见 [ARCHIVE-001](verification/ARCHIVE-001.md)。

历史文档可能包含旧的 api.arcinks.com、Worker 版本、临时诊断和本地环境信息。它们不表示当前新服务器已部署或上游已通过；不要据此推导性能、稳定性或纯 Worker 可用性。
