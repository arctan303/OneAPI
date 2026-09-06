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

部署前 fresh R2 审查已通过，见 [审查回执](PHASE-02-review.md)。随后 Secrets 上传命令被宿主自动审批在执行前拒绝，理由为需要明确授权所列具体凭据向 oneapi/api.arcinks.com 的敏感出站。已向用户提问等待授权；没有创建 Worker/DO/域名，没有上传或迁移任何凭据，没有真实上游请求。

本地已加载最终版本，PID 24424（仅本次诊断记录，停止前需重新核对），health200、connected=true、reauthenticationRequired=false、原 keyCount1，Access默认关闭；原账号和存储保留。

## 恢复入口

部署指令见 [DEPLOYMENT.md](../DEPLOYMENT.md)。迁移若无法通过官方验证，保留新 Worker，关闭临时导入 secret并等待用户；本地不撤销、不清空、不主动刷新复制令牌。不得以部署成功替代上游成功，不无限重试。
