# LIVE-001：本地真实模型目录与 API key 调用

日期：2026-09-07。产品变更，短任务；依据用户本轮明确目标和 DEC-009。实施完成，本地真实 SDK 和页面验证通过；R2 独立复核通过，未部署。

目标：管理员登录 → 保留/连接自己的 Codex 账户 → 读取真实模型目录 → 创建命名 API key → 指定 gpt-5.5 成功生成。gpt-5.6-luna 仅在真实目录提供时可选，不自动换模型。管理员页面流式测试与第三方 key 调用都要有真实证据。

范围：本机 Node 出站运行器，复用已有 Worker、DO、页面和标准 API；保留原存储与原 Wrangler 运行方式。用户已接受本地先可用，Cloudflare 云端另外验收。非目标：部署、多账号、指纹模拟、任意转发代理、取消鉴权、用 Platform API Key 替换订阅、重建OAuth数据库。

R2：新增本机出站路径会经手上游凭据 → 任意目标/重定向/日志错误可泄漏访问能力 → 白名单官方 HTTPS 目标和方法、拒绝重定向、脱敏错误、流中止、资源上限必须验证并接受 fresh reviewer 独立审查。不得通过替换业务代码伪造目录或响应。

依赖与迁移：沿用原 worker name / DO namespace / 持久化位置；先用隔离 Mock 验证旧方式写入后新方式读取，不并发打开同一存储。不改 schema、账号或现有 API key。回滚为停止新本地运行器后使用原 Wrangler；不得删除存储目录。

验证：诊断先复用已有真实 Worker 目录 403，一次 Node 同凭据目录检验运行时差异；成功后用新 key 普通生成和管理员页面流式生成（gpt-5.5）验收，测试 key 仅本次内存保存并最后撤销。每次真实调用显式计数，SDK/fetch 无自动重试；未知401需停止诊断并记录，不无限重登/刷新。运行器在 Mock 下覆盖路径/主机/重定向/取消与重启数据兼容；取消须通过实际 Worker/DO → 私有 binding → Node 出站组合验证，不能只用 handler 的直接 signal 测试代替；原业务回归按受影响范围复用或补跑。

当前证据：Node 真实目录返回 6 个模型，包含 gpt-5.5 和 gpt-5.6-luna。新建 key 经官方 SDK 调用 gpt-5.5 得到 completed 与 LIVE_OK；Edge 后台流式调用得到 UI_OK 和“测试通过”。最后健康 200、connected true / reauthenticationRequired false，临时 key 已撤销，API key 数量恢复原基线 0。全量 Mock 26/26、Node 运行器隔离和取消验证、typecheck 通过。真实调用与最终响应头小修的精确基线、请求计数、截图和残余缺口见 [LIVE-001 验证](../verification/LIVE-001.md)。

运行：npm run dev:node；http://127.0.0.1:8787/。原存储和账户保留；当前本地使用，Cloudflare 云端未部署。后续从此任务和验证记录恢复，不再重复旧 403 对照或重置账号。
