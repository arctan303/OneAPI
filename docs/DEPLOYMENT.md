# OneAPI 部署说明

> v0.2.0-dev.3 修复 Access 登录返回、Spark 目录与常见客户端参数兼容；保留启动参数、配置向导与分区后台。网络配置与 Tunnel / 公网 HTTPS / 反代安装见 [网络配置教程](NETWORK.md)。

## 当前主路径：轻量单服务器

生产目标是一个 Node.js 24.x（至少 24.15） 进程、一个 bundle 发布包和一个业务 SQLite 文件。生产不依赖 Wrangler、Miniflare、workerd、Docker、Redis、D1 或 KV；运行时通过 `dist/server/oneapi.mjs` 启动，SQLite 的 WAL、SHM 和锁辅助文件按正常机制工作。本机真实账号迁移、模型/额度、两协议与日志验收已通过，证据见 [SERVER-001](verification/SERVER-001.md)。目标 Linux 服务器与真实 Access 策略仍需部署后验证。

## 构建与首次启动

在仓库根目录执行：

```powershell
npm ci
npm run build:server
npm run setup:server
npm start
```

根 `npm run build` 当前默认构建 server；`npm run build:server` 会生成 `dist/server/`，包括 `oneapi.mjs`、`migrate.mjs`、`public/`、`setup.mjs`、`.env.example` 和部署模板。新账号的 setup 默认生成 `.env`，使用独占创建，已有文件不覆盖、不打印 secret。不要把 `.env.example` 当真实配置。生产包可把完整 `dist/server` 目录归档为 release 的 `server/` 目录，详见 [deploy/README.md](../deploy/README.md)。

默认配置是 `HOST=127.0.0.1`、`PORT=8787`、`DATA_DIR=./data`。公网反代时必须设置准确的 HTTPS `PUBLIC_ORIGIN`。systemd 模板使用：

- `ExecStart=/usr/bin/node /opt/oneapi/releases/current/server/oneapi.mjs`
- `WorkingDirectory=/var/lib/oneapi`
- `EnvironmentFile=/etc/oneapi/oneapi.env`
- `User=oneapi`
- `ReadWritePaths=/var/lib/oneapi/data`

Caddy 示例保留 Host、清理客户端 X-Forwarded-*、设置 HTTPS scheme，并使用 `flush_interval -1`。此同机反代模板中 Node 只监听 loopback；私网模式另见网络配置教程，完整模板和官方 Caddy 依据见 [deploy/README.md](../deploy/README.md)。

## 旧账号迁移

已有旧 Wrangler/SQLite Durable Object 账号时，先停止旧的 `npm run dev` 或 `npm run dev:node` 进程；迁移工具会检查旧 Node runtime 锁并核对源文件指纹；直接运行的 Wrangler 不遵守该锁，必须手动停止。沿用原来的三个 secret：`ADMIN_API_KEY`、`GATEWAY_API_KEY`、`TOKEN_ENCRYPTION_KEY`。不要为已有账号运行 setup 生成新值；setup 虽不会覆盖已有文件，换密钥仍会使旧账号无法解密。

完成构建后，在目标不存在时执行：

```powershell
node --env-file=.dev.vars dist/server/migrate.mjs --legacy-root .wrangler/state/v3 --target data/oneapi.sqlite
```

`migrate.mjs` 从 `.dev.vars` 读取原加密密钥，旧源库 read-only、源库及其 WAL 不修改，目标 `data/oneapi.sqlite` 必须不存在。迁移完成后，把原三个 secret 安全放入新服务器的 `.env` 或 `/etc/oneapi/oneapi.env`，并补上 HOST、PORT、DATA_DIR、PUBLIC_ORIGIN；不要展示或提交文件内容。旧 `.wrangler/state/v3` 和 Cloudflare 实验状态保留，不删除源库。迁移中断或目标已存在时停止并按错误码处理，不覆盖任何数据库。

## 备份、恢复与换版

备份前正常停止 OneAPI，确认进程已经退出，然后一起备份 `data/oneapi.sqlite` 和对应的受保护环境文件。若退出后仍存在非空 `oneapi.sqlite-wal`，不要仅复制主文件：保留整个数据目录并排查未退出的写入进程。运行期间直接复制主 SQLite 文件不构成一致备份。锁文件不是业务备份，恢复时不复用活动进程的锁。

恢复时保持服务停止，把备份恢复到一个新的数据目录，并配置 `DATA_DIR` 指向它；同时使用该备份对应的原始 `TOKEN_ENCRYPTION_KEY`。启动后先检查管理员登录和账号状态，再按需要进行模型调用。保留旧目录到验证成功，不覆盖正在使用的数据库。曾复制到其他实例的 OAuth 刷新令牌可能轮换，备份并不保证登录永久有效；不要让两套服务同时刷新同一授权。

代码换版只替换发布目录，数据和环境文件放在发布目录之外。回滚切回上一份发布包与兼容的数据备份。本次从旧 Worker 存储迁移不会修改源库，因此仍可停止新服务后用旧入口恢复；新库中迁移后产生的 key/日志不会自动同步回旧库。

## Access、管理员与 API 边界

后台的 Cloudflare Access 配置只有 Team Domain 和 Application AUD 两个参数。它们用于验证 Access 身份，不创建 Cloudflare 应用或策略。dev.3 根路径整页跳转 `/admin/login`，认证后进入 `/admin/`；Access 保护 `/admin/*`，让浏览器在加载页面前完成 CF 登录。普通口令表单不再有额外 CF 按钮；`/v1` 必须保持 API 访问，不得触发交互式浏览器登录跳转。

管理员 `ADMIN_API_KEY` 始终保留作为应用层兜底。若 Cloudflare Access/WAF 在边缘拦截，请在 Cloudflare 控制台关闭或收窄门禁，使请求到达应用；仅关闭 OneAPI 内开关不能恢复已经被边缘阻断的请求。API key、管理员会话和 Codex OAuth 账号属于不同边界，不要混用或交给第三方。

## 验证与当前状态

原生隔离测试 9/9、HTTP/迁移/产物/硬超时 11/11，真实 key 模型目录、官方额度、Responses 与 Chat SSE、日志和重启通过。首轮运行器目录预算问题已修正并保留证据，详见 SERVER-001。隔离检查可使用 `npm test`、`npm run typecheck`、`npm run test:dev-node`、`npm run test:extensions`；账号或订阅调用的 `npm run smoke:live`、`npm run smoke:extensions` 不属于默认启动流程，运行需有明确预算。

下方完整保留旧 Cloudflare Worker 部署、Access 配置和出站诊断记录，仅用于历史复核；旧命令仍可查到，但不是新服务器部署路径。

## 历史：Cloudflare Worker 部署与实验（完整记录）

部署目标：Worker `oneapi`，后台 `https://api.arcinks.com/`，API Base URL `https://api.arcinks.com/v1`。本地使用 `wrangler.jsonc`，云端使用独立的 `wrangler.worker.jsonc`，不改变本地账号存储。实际部署/上游可用性以 [Phase-02](dev-plan/phase-02.md) 及验证记录为准，部署成功本身不等于 Codex 上游可用。

## 首次部署

需要 Node.js、仓库锁定的 npm 依赖及拥有 Workers/域名绑定权限的 Cloudflare 登录。首次执行 `npm ci`、`npx wrangler login`；已有有效 Wrangler 登录可跳过 login。本项目用 SQLite Durable Object，不需要额外建 D1 或 KV。

1. 检查 `wrangler.worker.jsonc` 的 account_id、name、PUBLIC_ORIGIN、WORKER_ORIGIN；换账号时四处一起更新。保持 MOCK_UPSTREAM/ALLOW_TEST_HOSTS/本地出站绑定不在线上启用。
2. 只读核对账号现有 Worker、自定义域名和 DNS；名称已被其他服务占用时停止，不覆盖。仓库脚本 `node scripts/cf-inventory.mjs` 用于本次账号清单（不输出 token）。
3. `npm run worker:secrets:prepare`：创建被 Git 忽略的 `.dev.vars.worker`，复用本地 ADMIN_API_KEY 作为云端管理员口令，随机生成新的 GATEWAY_API_KEY、TOKEN_ENCRYPTION_KEY、ACCOUNT_IMPORT_SECRET；文件已存在则拒绝覆盖。保存加密密钥，后续随意重建会使已存账号无法解密。
4. `npm run worker:secrets:upload -- --enable-import`：通过 Wrangler stdin 上传 Secrets，只有计划迁移账号时才加 `--enable-import`。首次 secret bulk 可能创建新 Worker 草稿；先确认 name 未被占用。脚本不会上传 OAuth 凭据。
5. `npm run typecheck`、`npm test`、`npm run build:worker` 通过后运行 `npm run deploy:worker`。配置 routes 为空，自定义域名单独绑定，避免 Wrangler 在非交互环境覆盖冲突记录。
6. `npm run worker:domain` 只预检；确认无冲突后 `npm run worker:domain -- --apply`，始终以覆盖标志 false 写入。自动创建目标域名所需 DNS/证书，等待 HTTPS 可访问。后续部署继续用相同云配置；域名脚本可重复预检。
7. 打开 `/health` 应为 200。后台用管理员口令登录，创建的 API key 供第三方调用。不要把管理员 key 填给第三方客户端。

以上只操作专用 oneapi Worker 及其绑定；不得覆盖其他 Worker/路由/DNS。首次部署前仍需具体鉴权和凭据改动的 R2 独立审查，普通后续文案部署不自动升级风险。

## 复用本地已登录账号

只迁移本 Demo 自己的登录，不读取 Codex CLI/OpenCode 登录。脚本要求默认本地 `.wrangler/state/v3` 中只有一个账号 DO，读取 SQLite 为 readOnly，AES-GCM 解密仅在内存中完成；不导出明文文件、不打印 token，不复制日志、管理会话或自建 API key。

在确认 PUBLIC_ORIGIN 是自己部署的 HTTPS 域名后执行 `npm run worker:import`。目标健康及管理员身份须有效、目标账号须为空。导入请求仅携带 idToken/accessToken/refreshToken；后端同时要求管理员 Bearer 与临时 ACCOUNT_IMPORT_SECRET，验证固定官方模型接口成功才加密保存。错误/已有账号不会覆盖存储，不会自动重试。

完成导入后执行：

```powershell
npx wrangler secret delete ACCOUNT_IMPORT_SECRET --config wrangler.worker.jsonc
```

删除 `.dev.vars.worker` 中 ACCOUNT_IMPORT_SECRET 那一行并保留其他三项，之后上传 Secrets 不加 `--enable-import`。读回接口禁用状态；不删除 TOKEN_ENCRYPTION_KEY。迁移中断也关闭临时导入 secret，后续要恢复时重新生成并明确启用。

现有访问令牌有效时通常无需用户在线。若令牌失效、上游要求重新授权或 Worker 上游请求被拒绝，停止并保留部署；用户回到后台点“连接 Codex”，通过官方页面授权。新登录不保证能解决 Worker 出站 403。两端复制的刷新令牌不是两个独立授权，后续轮换可能让另一端需要重新登录；本次迁移不主动刷新/撤销本地登录。

## Cloudflare Access 两参数登录

后台“Cloudflare Access”配置 Team Domain（如 `team.cloudflareaccess.com`）、Application AUD 和启用开关。程序仅验证登录，不通过这两个参数创建 Cloudflare 应用或身份策略。

在 Cloudflare Zero Trust → Access → Applications 创建专用 Self-hosted 应用，保护 `api.arcinks.com/admin/*`，只允许自己的身份（例如自己的邮箱）。如果需要通过 workers.dev 登录，也须在同一 Access 应用覆盖对应 Worker 的 `/admin/*`；或者不对外使用该测试域名。历史Worker版本的根页面只有静态登录框；dev.3改为根跳转/admin/login。账号、key、日志和设置数据均走受保护管理接口，页面外壳本身不包含数据。

**不要给整个域名或 `/v1/*` 套交互式 Access 门禁**，否则普通 OpenAI SDK 的 Bearer API key 会收到 HTML 登录跳转。若已经设置全域门禁，收窄应用范围；不是在 OneAPI 内忽略身份校验。

从 Cloudflare 应用复制 AUD，并将 Team Domain/AUD 填入后台后启用。允许通过该应用的人就是唯一管理员，因此 Allow 策略不能设置为 Everyone。OneAPI 校验 RS256 签名、issuer、audience 和有效期，不信任未验签的邮箱 header。访问凭证每次管理请求校验，关闭或换配置使旧凭证失效。

管理员 key 登录和管理员 Bearer 始终保留。Access 卡住时在 Cloudflare 控制台关闭/移除该应用的门禁，使请求能到达 Worker，然后以管理员 key 登录修改配置。仅关闭 OneAPI 开关不能取消 Cloudflare 边缘拦截。退出 Access 登录会访问 Cloudflare 自身 logout，退出后台不等于断开 Codex。

## 测试与回滚

先验证健康、未登录管理拒绝、管理员登录、模型目录及官方额度，再创建仅允许 gpt-5.5 的临时 key。验证 `/v1/models` 过滤和 `reasoning` 元数据，最后用 `reasoning.effort` 或 `reasoning_effort` 发最短请求。模型目录失败时停止常规SDK验收并保留 HTTP/code 证据，不循环消耗请求。独立排障可先在维护任务记录假设和次数上限，再发送不依赖目录的普通生成对照；WORKER-403已执行1次，不默认重复。

- 代码回滚：`npx wrangler deployments list --config wrangler.worker.jsonc` 查看版本，再按 Wrangler rollback 帮助指定本 Worker 已知正常版本。首次版本没有更早版本可回退。
- Access 恢复：Cloudflare 控制台关闭门禁，再使用管理员口令。
- 数据：重新部署不会自动清除 DO；不要删除 namespace 或替换加密 Secret。恢复本地不依赖云端，可以继续 `npm run dev:node`。
- 若需撤销测试资源，只按阶段记录删除本次创建的 oneapi 及其 api.arcinks.com 绑定；删除 DO 会永久丢失云端账号/keys/logs，未获得删除授权时保留。

官方参考：[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

## 上游403诊断

运行 `node scripts/probe-worker-upstream.mjs models` 或 `usage`，脚本先匿名核对健康与固定服务标识，再以忽略文件中的管理员口令请求一次；失败退出非零，只保存白名单摘要到output/phase02。`generate`会实际提交一次gpt-5.5普通生成，须计入当前诊断预算。`node scripts/test-probe-worker-upstream.mjs`是隔离fixture验证，不访问上游。

管理员错误可附带`error.diagnostic`，额度失败仍以`available:false`判断，不能只看外层HTTP200。普通API key没有诊断元数据；原始HTML和凭据不会返回。现有账号显示已连接不等于资源请求可用。当前真实对照、版本和恢复入口见[WORKER-403](maintenance/WORKER-403.md)。

## 临时Node出站诊断（EGRESS-001）

此模式用于已授权的受控对照，不是生产配置：运行独立scripts/egress-relay.mjs，默认127.0.0.1:8791，仅暴露该诊断端口；不要将8787管理员后台指向公网隧道。服务从Git忽略文件.dev.vars.relay读取独立32字节base64 ONEAPI_RELAY_KEY，云端使用同一Secret与exact HTTPS ONEAPI_RELAY_ORIGIN。请求和有界响应均以AES-GCM加密，Node固定官方目标、不保存OAuth，不需要第二次账号登录。

源代码与隔离fixture及R2审查通过后才开启隧道/注入配置。运行node scripts/probe-egress.mjs ping验证身份，再按任务预算运行models、usage或generate；不要自动重试。完成删除两个临时云Secret、停止本次进程，运行node scripts/probe-egress.mjs disabled确认关闭。普通/v1路径未切换，即使诊断成功也不能宣称用户API已修复。[实验契约与最新证据](tasks/EGRESS-001.md)。

## WS-001 有限诊断

此功能用于定位纯 Worker 上游拒绝，默认关闭，不能作为已跑通生产传输的证据。执行前需遵守 [WS-001](tasks/WS-001.md) 的一次握手预算和账号边界，完成对应代码验证及独立审查；不要循环运行探测。

诊断代码与正常 Worker 同时构建部署，但配置文件没有启用开关。只对 `oneapi` 临时设置服务端 Secret `ONEAPI_WS_DIAGNOSTIC` 为 `true`，保留原三个 Secret 和原 Account DO 身份。运行 `node scripts/probe-worker-websocket.mjs probe` 会先检查本项目健康和账号状态，再发一次管理诊断，并核验后置状态；输出为 `output/ws-probe/` 中的脱敏 JSON。

不论结果如何，都删除临时 `ONEAPI_WS_DIAGNOSTIC`，再运行 `node scripts/probe-worker-websocket.mjs disabled`，应得到 503 / `websocket_diagnostic_disabled`，此检查不会访问上游。最后回读原 Secret 名称、DO 和其他 Worker 的状态。不要删除账号或为 403 重新授权。

如果需要撤回诊断代码，使用本次部署前记录的版本回滚；临时开关删除已经能够关闭入口。管理 API 凭据来自忽略文件 `.dev.vars.worker`，账号令牌只保留在云端 DO 加密存储中，不进入脚本输出或部署产物。