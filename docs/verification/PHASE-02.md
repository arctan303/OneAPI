# Phase-02 验证与部署记录

基线：`7ec814e`；日期：2026-09-07。目标 Worker `oneapi` / `api.arcinks.com`。本轮授权包括新 Worker 部署、指定域名绑定、安全迁移本 Demo 的账号；禁止覆盖其他资源。管理员 Access 配置待真实参数填写，不能把本地签名测试写成真实 SSO 登录通过。

## 部署前证据

- Sol/high 后端：`npm run typecheck` 通过；`npm test` 全量 6 files / 68 tests 通过。覆盖 Access RS256、issuer/audience/time、过期/伪造/配置变更、JWKS 轮换/合并/限长、CSRF、严格部署 origin、API key 隔离、仅空账号安全导入。
- 主会话：`npm run test:dev-node` 通过，含新增固定 JWKS 出站白名单与拒绝矩阵，既有存储恢复和取消隔离继续通过。
- Luna/high UI：`node output/playwright/phase02-access-ui.mjs` Edge 隔离测试通过，实际请求路由/参数与后端一致；未登录只读公开 enabled，配置保存及 400 错误、登出晚到请求防回填、Access 同源登出、390px 无横溢出，pageerror 0。修复保存请求晚到登出后按钮未恢复。
- 主会话：`node scripts/verify-worker-smoke-cleanup.mjs` 6 场景通过：清理请求异常、非 2xx、报告落盘失败、错误目标服务、不安全 HTTP origin、官方额度 HTTP 200 但 available=false。验证原始错误保留、key/session 清理分别执行、失败退出状态真实，错误目标不发送管理员凭据。所有场景为隔离假 HTTP，非真实模型调用。
- 最终 `npm run build:worker` dry-run 通过：195.60 KiB / gzip 42.87 KiB，仅 ACCOUNT DO、ASSETS、明确两个 HTTPS origin，无 MOCK/测试 Host/本地出站绑定。
- 实际本地/云 Secrets 扫描：118 个可提交文件与 Worker bundle 命中 0，.dev.vars 与 .dev.vars.worker 均 Git 忽略。OAuth 只在内存解密检查，没有明文导出/打印。

## 云端资源边界

部署前：账号现有 Worker 为 arcinks-com、blog、mail、music-arctan-top，无 oneapi；Custom Domains 无 api.arcinks.com；zone Worker routes 为空。DNS 查询权限不足 403，故绑定脚本先 changeset 再以 override_existing_origin / override_existing_dns_record / override_scope 均 false 写入。Wrangler 非 TTY 默认覆盖行为未采用。

Access 应用清单为空，identity providers 空，organization 读取 403。不会推断 Team Domain/AUD 或创建过宽 Allow 规则。应用 Access 默认关闭，管理员 key 登录保留；用户可按 DEPLOYMENT 文档配置自己的 Access 应用和身份策略。

## 部署与真实结果

用户补充“允许”后，前次宿主敏感出站授权阻碍已解除。2026-09-07 部署代码基线为 4294b99：

- Worker：oneapi。代码部署版本 64934e7e-ffe1-4200-a98f-180f3fb9eff2；关闭临时导入 Secret 后版本 e1ae6b4b-b72e-4d03-9f59-a8f8ecbdc911。
- 域名：https://api.arcinks.com/；workers.dev：https://oneapi.12213443th.workers.dev。两入口实际 /health 为200并返回正确service。
- 域名 changeset：added1、updated0、conflicting0；三个 override 为false。新增 Custom Domain ID 0ba68b1a462fc2f0c9f4c9435cd3e4064a2d2ec9。原4个Worker、5个域名绑定清单仍在，zone Worker routes仍为空；未对其执行写操作。DNS读取权限仍不足，不宣称完成全DNS差异审计。
- 真实 admin-only smoke 通过：管理员口令登录/会话、CSRF拒绝、创建临时允许gpt-5.5的key、普通key拒绝管理、清理key与退出测试会话。生成次数0。首次自定义域名请求出现一次连接错误，随后两个健康入口通过才重跑管理检查。
- 受控迁移：只发一次官方模型目录验证，HTTP403 / upstream_http_403；导入未写入账号，未生成。随后删除 ACCOUNT_IMPORT_SECRET，secret list仅余三项长期Secret，导入端点404/account_import_disabled；本机忽略文件中的临时Secret也移除。云端保留原环境兼容key，临时key已删除。
- 本地存储/账号未修改或主动刷新；旧进程不再监听时已重新启动相同Node运行器。后续只读本地状态检查曾被主机工具权限错误中断，不能把旧PID当作当前运行证据。

## 用户重新登录后的对照（2026-09-07）

用户在云端完成新的设备授权后截图显示 connected 和账号信息，额度请求仍403。主会话在 2026-09-07T03:34:52Z 回读 /admin/status：HTTP200、connected=true、reauthenticationRequired=false；随后仅一次 /admin/test/models 返回403/upstream_http_403，生成0次。

这排除了“只要重新授权即可恢复当前两个资源接口”的猜测。connected证明网关保存了凭据，并不保证模型或额度授权可用。当前证据支持云端登录路径可用、模型目录/额度资源请求仍被上游拒绝；没有可确认业务错误码，不能把WAF、出口IP、TLS或某个请求头写成已证实根因。未在本轮导出新云端凭据到本地作同令牌对照。

## 恢复入口与阻碍

部署已完成、后台管理可用；纯Worker的模型与额度访问受403阻碍，不能宣称端到端可用。保留用户新云端登录，不重登、不反复重试、不返回伪造模型列表。Access仍未配置真实TeamDomain/AUD，默认关闭，管理员key可用。

后续若有明确请求契约修复证据可做有限对照；需要改变架构或新增本地/外部转发服务时先确定新的范围。部署操作见 [DEPLOYMENT.md](../DEPLOYMENT.md)。已审查的临时导入默认关闭；不为排障重新开启凭据导出入口。
