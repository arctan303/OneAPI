# OneAPI

> v0.2.0-dev.4 完整接通 Codex 0.153.4 自定义 Responses provider，并合入分区后台、额度卡片、模型/key/日志交互优化。网络配置与 Tunnel / 公网 HTTPS / 反代安装见 [网络配置教程](docs/NETWORK.md)。

当前预发布：[v0.2.0-dev.4](https://github.com/arctan303/OneAPI/releases/tag/v0.2.0-dev.4)。首次安装请下载 Release 的 `oneapi-server-*.tar.gz` 附件。

个人 Codex 订阅网关。当前主路径是轻量单服务器：一个 Node.js 进程、一个业务 SQLite 数据库和原有静态管理后台/API。生产运行不依赖 Wrangler、Miniflare、workerd、Docker、Redis、D1 或 KV；Cloudflare Access 管理登录和管理员 API key 兜底继续保留。

首次安装预发布包请先阅读 [安装教程](docs/INSTALL.md)；已安装环境的 HTTPS、systemd 和升级边界见 [部署说明](docs/DEPLOYMENT.md)。

原生服务器已在本机通过真实账号、Codex 0.153.4 原生模型目录/文本/工具续轮、Responses/Chat SDK、官方额度与后台浏览器验收。预发布包体积以 [v0.2.0-dev.4 Release](https://github.com/arctan303/OneAPI/releases/tag/v0.2.0-dev.4) 附件为准；Node.js 本身另行安装。远端服务器和真实 Access 策略不会自动更新。

## 单服务器快速开始

需要 Node.js 24.x（至少 24.15，低于 25）。新账号在仓库根目录执行：

```powershell
npm ci
npm run build:server
npm run setup:server
npm start
```

`npm run build` 当前也指向 server 构建；`npm run start` 会运行 `dist/server/oneapi.mjs`，并从项目根目录的 `.env` 读取配置。setup 默认生成 `.env`，已有文件只报告 unchanged，不覆盖，也不打印凭据。生产环境可把同一脚本复制到发布包后用 `--env-path` 写入受保护的环境文件，详见 [部署说明](docs/DEPLOYMENT.md) 和 [部署模板](deploy/README.md)。

默认后台地址是 http://127.0.0.1:8787/，API Base URL 是 `http://127.0.0.1:8787/v1`。管理员使用 `ADMIN_API_KEY` 登录；第三方客户端使用后台创建的 API key。首次连接账号时，在官方网页完成设备码授权；已有账号可直接加载模型。本地迁移的账号已验证可直接使用；迁往其他服务器后应验证该服务器的上游出口。

## Codex 原生接入

先把后台创建的 OneAPI 调用 key 保存到本机环境变量 `ONEAPI_API_KEY`，再在 Codex `config.toml` 中加入：

```toml
model = "gpt-5.6-sol"
model_provider = "oneapi"

[model_providers.oneapi]
name = "OneAPI"
base_url = "http://127.0.0.1:8787/v1"
env_key = "ONEAPI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
```

dev.4 已按 Codex 0.153.4 验证模型目录、原生 Responses 输入、流式文本和工具续轮。未来客户端新增的未知顶层参数会被记录并忽略，不会转发上游；状态存储、后台任务和托管工具等未实现语义仍明确拒绝。详细边界见 [API 兼容矩阵](docs/API.md)。

## 已有账号先迁移

已有旧 Wrangler/SQLite Durable Object 账号时，先停止 `npm run dev` 或 `npm run dev:node` 对应的旧进程，再保留原来的三个 secret：`ADMIN_API_KEY`、`GATEWAY_API_KEY`、`TOKEN_ENCRYPTION_KEY`。不要为已有账号运行 setup 生成新值；setup 本身不会覆盖已有文件，但新 secret 会使原账号数据无法按原密钥解密。

在目标文件不存在的前提下，从仓库根目录执行迁移命令：

```powershell
node --env-file=.dev.vars dist/server/migrate.mjs --legacy-root .wrangler/state/v3 --target data/oneapi.sqlite
```

迁移读取旧库为只读、源库不改，目标必须不存在；旧 Node 开发运行时仍在运行时会被锁检查拒绝；直接运行的 Wrangler 不遵守该锁，必须手动停止，迁移期间源文件变化会使发布失败。迁移完成后，把原三个 secret 安全放入新服务器的 `.env` 或主机环境文件，并补上 `HOST=127.0.0.1`、`PORT=8787`、`DATA_DIR=./data` 及准确的 `PUBLIC_ORIGIN`。SQLite 以 `oneapi.sqlite` 为业务文件，WAL、SHM 和锁辅助文件由 SQLite 正常管理。Cloudflare Worker 实验状态留在旧的 `.wrangler/state/v3`，不会被迁移删除。

迁移目标和旧源不应并发打开；切换前检查真实进程与命令，不用固定 PID 猜测停止对象。迁移的失败码、密钥边界和回滚条件见 [部署说明](docs/DEPLOYMENT.md)。

## Cloudflare Access

后台配置中的两个参数是 Team Domain 和 Application AUD。它们只用于验证 Cloudflare Access 登录，不会替 Cloudflare 创建应用或策略。Access 应用只保护管理页面和 `/admin/*`；不要把交互式 Access 登录套到 `/v1`，否则 OpenAI SDK 会收到浏览器登录跳转。

管理员 API key 始终保留作为应用层兜底。若 Cloudflare Access/WAF 在边缘拦截，请在 Cloudflare 控制台关闭或收窄门禁，让请求先到达应用；OneAPI 内关闭 Access 开关无法绕过边缘拦截。具体边界和配置步骤见 [部署说明](docs/DEPLOYMENT.md)。

## 原有命令与检查入口

以下命令保留给兼容和历史复核使用：

- `npm run setup`：旧 Worker 本地配置初始化。
- `npm run dev:node`：旧本地 Node 开发入口；新服务器启动使用 `npm start`。
- `npm run dev`：旧 Wrangler 本地入口，属于 Worker 实验路径。
- `npm run build:legacy`：旧 Worker dry-run 构建；根 `npm run build` 已改为 server 构建。
- `npm run build:worker`、`npm run deploy:worker`、`npm run worker:domain`：旧 Worker 实验部署命令，详见 [部署说明中的历史章节](docs/DEPLOYMENT.md)。
- `npm test`、`npm run typecheck`、`npm run test:dev-node`、`npm run test:extensions`：隔离检查入口；新版本的行为结果见 SERVER-001 验收。
- `npm run smoke:live`、`npm run smoke:extensions`：会使用账号或订阅调用，运行前需按各自任务预算确认；不属于默认启动流程。

## 验收与历史资料

以下链接保留原有 Git 归档、诊断和验证入口。它们描述各自当时的证据范围，不替代当前单服务器生产验收：

- [Phase-01 证据](docs/verification/PHASE-01.md)、[LIVE-001](docs/verification/LIVE-001.md)、[LIVE-001 独立复核](docs/verification/LIVE-001-review.md)
- [MARKER-001](docs/verification/MARKER-001.md)、[WS-001](docs/verification/WS-001.md)、[无令牌四路径观测](docs/verification/PURE-WORKER-001.md)
- [WORKER-403](docs/maintenance/WORKER-403.md)、[403 运行时诊断](docs/verification/403-runtime-diagnosis.md)
- [EGRESS-001](docs/tasks/EGRESS-001.md)、[WS-001 任务契约](docs/tasks/WS-001.md)
- [接口与限制](docs/API.md)、[产品契约](docs/Product-Spec.md)、[开发计划](docs/DEV-PLAN.md)、[归档记录](docs/verification/ARCHIVE-001.md)
- [Worker 部署与历史实验](docs/DEPLOYMENT.md)

旧记录包含 arctan303/OneAPI 的 v0.1.0 归档目标和过去的环境信息；这些信息仅用于 Git 追溯。Cloudflare Worker 出站 403、Node/Worker 对照和临时诊断均保留在上述历史文档中，不作为新服务器已通过的证明。
