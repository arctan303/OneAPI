# Cloudflare Worker 部署说明

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

在 Cloudflare Zero Trust → Access → Applications 创建专用 Self-hosted 应用，保护 `api.arcinks.com/admin/*`，只允许自己的身份（例如自己的邮箱）。如果需要通过 workers.dev 登录，也须在同一 Access 应用覆盖对应 Worker 的 `/admin/*`；或者不对外使用该测试域名。根页面只含静态登录框，账号、key、日志和设置数据都走受保护的 `/admin/*`。

**不要给整个域名或 `/v1/*` 套交互式 Access 门禁**，否则普通 OpenAI SDK 的 Bearer API key 会收到 HTML 登录跳转。若已经设置全域门禁，收窄应用范围；不是在 OneAPI 内忽略身份校验。

从 Cloudflare 应用复制 AUD，并将 Team Domain/AUD 填入后台后启用。允许通过该应用的人就是唯一管理员，因此 Allow 策略不能设置为 Everyone。OneAPI 校验 RS256 签名、issuer、audience 和有效期，不信任未验签的邮箱 header。访问凭证每次管理请求校验，关闭或换配置使旧凭证失效。

管理员 key 登录和管理员 Bearer 始终保留。Access 卡住时在 Cloudflare 控制台关闭/移除该应用的门禁，使请求能到达 Worker，然后以管理员 key 登录修改配置。仅关闭 OneAPI 开关不能取消 Cloudflare 边缘拦截。退出 Access 登录会访问 Cloudflare 自身 logout，退出后台不等于断开 Codex。

## 测试与回滚

先验证健康、未登录管理拒绝、管理员登录、模型目录及官方额度，再创建仅允许 gpt-5.5 的临时 key。验证 `/v1/models` 过滤和 `reasoning` 元数据，最后用 `reasoning.effort` 或 `reasoning_effort` 发最短请求。模型目录失败时停止生成测试并保留 HTTP/code 证据，不循环消耗请求。

- 代码回滚：`npx wrangler deployments list --config wrangler.worker.jsonc` 查看版本，再按 Wrangler rollback 帮助指定本 Worker 已知正常版本。首次版本没有更早版本可回退。
- Access 恢复：Cloudflare 控制台关闭门禁，再使用管理员口令。
- 数据：重新部署不会自动清除 DO；不要删除 namespace 或替换加密 Secret。恢复本地不依赖云端，可以继续 `npm run dev:node`。
- 若需撤销测试资源，只按阶段记录删除本次创建的 oneapi 及其 api.arcinks.com 绑定；删除 DO 会永久丢失云端账号/keys/logs，未获得删除授权时保留。

官方参考：[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
