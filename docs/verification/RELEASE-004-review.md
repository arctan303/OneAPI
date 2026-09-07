# RELEASE-004 独立审查：v0.2.0-dev.3

日期：2026-09-07。角色：fresh reviewer，未参与本轮实现。审查基线为 `66191e914072a377e1c7ded6b65395675bdf9fb7`（v0.2.0-dev.2），对象为该基线到冻结 dev.3 工作区候选的相关源码、页面、测试、发布文档与隔离归档证据；个人 `.codex/evolution/signals.md` 明确排除，未纳入候选和结论。

## 风险与结论

风险为 R2：本轮允许 Cloudflare Access 登录返回从 cross-site / same-site 导航穿过原管理入口 Fetch Metadata 门禁；若条件过宽或后续认证可被替代，会让未授权请求到达管理数据。相邻产品变更还公开了两个静态管理页面外壳，并为请求日志增加持久化摘要列；需排除页面外壳泄露数据、管理数据鉴权放宽、旧库升级失败或兼容忽略扩大到未知关键参数。

**结论：通过。** 未发现仍可执行的生产代码、权限、数据迁移或协议兼容问题。审查中发现 `docs/DEV-PLAN.md` 顶部仍把已冻结的登录路由写成“实施中”；主会话已原位更新为四批均实施、验证并冻结，聚焦读回后关闭。该问题是状态文档滞后，未影响运行安全。

## 契约与实现核对

- `src/gateway.ts` 的例外只匹配无 query 的精确 `GET /admin/access/login`，且 `Sec-Fetch-Site` 仅为 `cross-site` / `same-site`、Mode 为 `navigate`、Dest 为 `document`；随后 Origin 检查仍执行。请求继续进入 `AccountService` 的管理员认证和 `accessAuthentication` 完整 JWT 校验，管理员 Bearer 不能代替 Access 身份。成功响应固定 303 到当前 origin 根路径，无会话写入或 `Set-Cookie`；其他管理路径、写请求、跨站 fetch 和带 query 导航仍拒绝。
- 根 `GET` / `HEAD` 固定 302 到 `/admin/login`，忽略外部 redirect/query 值。仅无 query 的 `GET /admin/login` 与 `GET /admin/` 作为静态外壳绕过管理数据处理；页面使用 `no-store` 安全响应头，`/admin/session`、状态、配置、key、日志及其他数据接口仍进入原鉴权和同源门禁。前端登录、失效和退出统一切换固定路径，合法 hash 才保留；退出清空账号、模型、key、日志详情、Access 配置、设备码和生成文本等已呈现内容。
- OAuth 目录解析只移除 `supported_in_api === false` 过滤，仍要求字符串 slug、保留 `visibility === "hide"` 过滤，并在目录返回和生成入口继续执行 key 模型白名单。不硬编码 Spark，也不扩大 reasoning 或 key 权限。
- 参数归一化仅新增 Chat 的 `max_completion_tokens` / `max_tokens`、Responses 的 `max_output_tokens`，以及两协议 `temperature` / `top_p`。非 null 值分别要求正安全整数、0..2 有限数、0..1 有限数；null 无操作。字段不会进入上游 body；其他未知字段、错误协议字段、工具/结构化输出/存储及模型权限仍沿用明确拒绝。
- 实际忽略的字段名在 API-key 调用归一化后写入 `ignored_parameters`，不含值、正文或凭据；JSON 和 SSE 仅在成功响应增加 `X-OneAPI-Ignored-Parameters`，不改标准响应体。模型权限等日志已开始后的失败仍保留字段名。正文过期只清空 request/response body，不清除该摘要。
- Worker/Node 建表均以 `TEXT NOT NULL DEFAULT '[]'` 幂等补列；Node 构造器启动旧表时补列，旧迁移记录缺字段时写入 `[]`。列表与详情对缺失、非法或旧值安全回落为空列表，未重建或清空现有数据。

## 验收证据

独立审查运行：

```text
npx.cmd vitest run test/access.test.ts test/auth.test.ts test/extensions.test.ts -t "allows only the exact Access callback|serves only the fixed login and admin shells|keeps subscription-listed models|validates and reports compatibility-only generation parameters"
3 files passed；4 tests passed；28 skipped；无真实上游。
```

冻结候选复用的完整证据仍适用于当前生产/测试代码：Worker `87/87`、Node `16/16`、HTTP `5/5`，typecheck、JS 语法和 diff check 通过。鉴权矩阵覆盖回跳条件、无效/过期/错误 issuer/audience/伪造 JWT、管理员 Bearer 不替代 Access、固定 303、无 Cookie，以及其他管理路径不放宽。参数矩阵覆盖两协议 JSON/SSE、null/非法值/未知字段、一次上游调用、上游 body 不含忽略字段、成功响应头、基础列表/详情、失败日志与正文到期后摘要保留。

候选包证据：server bundle `265940 B`、payload `404689 B`、零外部 npm 运行依赖；最终归档 `103347 B`、15 files，SHA-256 为 `76a499e9b2d210fb69da759b7e021bf0f4a41228f033670e9db680fdfefff169`，9 项真实配置值仅内存比对且零命中。补充原生 Node dev.1/dev.2 升级说明后已重建归档，生产代码未变；实际归档新装和独立 manifest 安装各 `1/1`，dev.2→dev.3 隔离升级再次通过。经 SHA-256 核对的 dev.2 归档创建合成 session、key 和旧 schema 日志后停止，dev.3 以同一外置 `DATA_DIR` 启动，旧 session/key/log/usage 与配置保持，旧日志返回 `ignoredParameters=[]`。审查只读检查了该合成升级脚本；首次非 UUID 合成日志 ID 导致详情路由 405，改为合法 UUID 后通过，未修改生产代码。

隔离 Chromium 既有证据覆盖登录页、后台、登录/退出、合法与非法 hash、390 px 布局，以及基础日志在未开启正文时显示 `max_output_tokens`；截图使用合成账号，不构成远端实机证明。

## 剩余边界与发布步骤

本结论只批准上述冻结补丁及候选归档，不表示已发布或已部署。审查完成后仍需按 RELEASE-004 执行一次最短真实 `gpt-5.6-luna` 调用、提交推送、草稿附件回下载校验并发布 prerelease；这些结果应回写发布记录。用户远端 Node 尚未更新，真实 Cloudflare `/admin/*` 策略也未实机验收，因此不能声称远端问题已经修复。若生产/测试代码、鉴权条件、日志 schema 或候选归档在此后变化，本结论对受影响部分失效并需聚焦复核。
