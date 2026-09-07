# ACCESS-RETURN-001：Cloudflare Access 登录返回被同源校验误拒绝

日期：2026-09-07。路线：维护修复；规模：短任务。基线：66191e9（v0.2.0-dev.2 发布回执）；保留个人 .codex/evolution/signals.md 修改。

## 目标与依据

用户报告 permission_error / site_not_allowed，并确认 api.arcinks.com 现在是单服务器 Node。用户提供的登录地址明确在 Cloudflare 团队域完成登录后回到受保护域的 /admin/access/login；不保存其中的 query、metadata token 或身份信息。预期依据为 AUTH-001 / DEC-013 / DEC-014：有效 Access JWT 可进入管理员后台，同时保持管理员key兜底和普通管理接口同源边界。

现代码 gateway 对全部 /admin/* 拒绝 Sec-Fetch-Site=same-site/cross-site，先于 AccountService 的完整 JWT 验证。GET /admin/access/login 已有实现验证 Access 配置和令牌后仅303重定向当前origin根路径，不创建会话、不修改账号、不读取敏感业务数据。正常跨站登录返回与统一同源检查冲突。最终请求头未从用户浏览器抓取；其给出的返回路径、相同错误以及隔离失败回归用于定位，不声称已经验证远端修复。

## 范围与风险

R2：缩窄登录返回入口的Fetch Metadata例外可能误放开管理入口，需证明仅确切GET导航路径允许继续JWT验证；其他管理GET/写操作和Origin校验不得放宽。异常或缺失JWT仍拒绝；管理员key不能代替该入口的Access身份；重定向固定根路径，不采信query重定向参数。

修复既定Access登录兼容，不新增角色或认证协议。非目标：不改变CF策略、DNS、Worker、账号/密钥/数据库、普通/v1接口，不使用或记录用户提供的登录metadata token，不消费真实模型配额，不覆盖已发布dev.2附件或标签。

## 执行、验证与状态

按用户要求分批：Sol high 补失败回归与最小修复；主会话核对契约和官方依据；冻结后fresh reviewer独立核验此次R2补丁。复用既有签名JWT/JWKS fixtures；覆盖Worker gateway及实际Node HTTP adapter导航返回，303固定根、无cookie、无效/缺失令牌拒绝、跨站其他管理操作拒绝及管理员key兜底原路径。

实施：用户已明确回复“可以”，批准上述精确GET导航例外，Sol恢复实施。验证：本地只读/admin/session矩阵中same-origin/none/无header均200，same-site/cross-site返回用户所报403；针对callback的原失败与修复回归由实施代理补齐。第一条临时诊断脚本因CommonJS顶层await语法失败，改用ES module后通过，无业务代码受影响。审查：RELEASE-004 fresh reviewer已通过（见独立审查记录）。远端：用户已明确Node，但本会话未连接目标服务器，不声明已部署修复。

## 官方依据

- [W3C Fetch Metadata 的重定向规则](https://www.w3.org/TR/fetch-metadata/#redirects)：判断会考虑重定向URL链，跨站返回不能简单假设same-origin。
- [Cloudflare Access authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)：团队域与受保护应用域使用各自cookie，认证涉及跨域重定向。

恢复入口：本文件、src/gateway.ts、src/account-core.ts 的 /admin/access/login、test/access.test.ts、test/auth.test.ts、test/server-runtime.node.spec.ts。完成后构建可交付修复产物并明确本地验证与远端部署状态。

恢复与新增证据：宿主中断后原实施代理消失，保留其test/access.test.ts未完成回归（48行diff）；核对生产未改后恢复一名Sol high继续，未盲目重跑长测试。用户随后反馈手动打开根页面已能进入。Edge浏览器工具重试仍helper_unknown_error，未能独立读取用户页面。主会话用隔离Chromium真实导航观测（localhost到127.0.0.1，非用户站点）：回跳/admin/access/login为Sec-Fetch-Site=cross-site、Mode=navigate、Dest=document且无Origin；303到根之后前端/admin/session为same-origin/cors/empty。证据output/playwright/access-return-metadata.json，不含令牌或个人信息。

历史检查点（已被下方授权与实施结果替代）：Sol重跑 npx.cmd vitest run test/access.test.ts，9项中新增callback回归1失败（expected303、actual403），其余8通过。拟补丁仅GET /admin/access/login、无query、Sec-Fetch-Mode=navigate、Sec-Fetch-Dest=document时让same-site/cross-site继续完整JWT验证，保留Origin规则和其他管理路径。apply_patch先因宿主helper_unknown_error失败；后续严格锚点本地编辑被自动审批明确拒绝，理由为持久变更认证网关跨站边界尚未取得用户对具体例外及影响的明确批准。不得换工具或变形实现绕过；需用户明确同意后恢复。当前只有测试与文档修改，生产文件未变，远端Node未更新。

授权更新：用户在审批解释后明确回复“可以”，授权确切GET /admin/access/login顶层导航例外，完整Access JWT及其他管理接口规则保持；此前自动审批待决已解除。用户补充Spark缺失和CF保护/admin/*导致key登录被边缘拦截，由SPARK-CATALOG-001和首页交互澄清分别承接。

实施冻结：精确回跳导航例外已完成。Worker Access/auth 针对性测试16/16、实际Node HTTP adapter测试9/9、typecheck通过；覆盖无效JWT、错误issuer/audience、管理员Bearer不能代替Access身份、其他管理跨站请求保持拒绝，以及固定303根跳转且无Set-Cookie。最终独立审查与新登录路由合并进行；远端尚未更新。
