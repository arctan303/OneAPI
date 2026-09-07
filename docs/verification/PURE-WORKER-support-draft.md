# Worker 直连 Codex 的 403：支持工单草稿（未发送）

希望确认一个出站兼容问题，而非申请变更账号权限：同一份个人 Codex OAuth 凭据与业务请求，经本机 Node 成功，Cloudflare Worker 直接出站持续收到 HTML 403。账号可正常完成官方设备授权。

已完成对照：2026-09-07 04:56:48 UTC，GET /backend-api/codex/models，Worker 403（CF-Ray a37321050d09266d-SIN），同凭据经 Node 200；04:57:11 UTC，GET /backend-api/wham/usage，Worker 403（CF-Ray a37321984f5c266d-SIN），同凭据 Node 200。两组均无令牌刷新、无自动重试。仅调整 GET Content-Type 或诚实 User-Agent 的有限实验也未改善。

进一步完成了严格的单变量来源头对照：2026-09-07 06:33:11 UTC，在同一 Node 进程中，使用同一凭据快照和同一份 `GET /backend-api/codex/models?client_version=0.153.4` 请求头，baseline 返回 200（CF-Ray `a373ae301b58fa7e-SJC`）；第二次只增加 `CF-Worker: oneapi.12213443th.workers.dev`，返回 HTML 403（CF-Ray `a373ae37ce28fa7e-SJC`）。实际共 2 次资源 GET、0 生成、0 refresh、0 retry；前后 `connected`、`reauthenticationRequired`、`tokenExpiresAt` 和 `lastRefreshAt` 保持一致。完整脱敏记录见 [MARKER-001](MARKER-001.md)。

[Cloudflare 的 CF-Worker 文档](https://developers.cloudflare.com/fundamentals/reference/http-request-headers/#cf-worker)说明，该头会自动添加到所有 Worker `fetch()` 子请求，用于让接收方识别、过滤或路由特定 zone 的 Worker 流量；WAF 自定义规则应读取 `cf.worker.upstream_zone`，而不是直接匹配该请求头。

另于 UTC 2026-09-07T06:47:44.097Z，使用官方 Codex Responses WebSocket 握手路径（不发送生成消息）从云端同账号发出一次 upgrade 请求，仍返回 HTTP403 / text/html，CF-Ray a373c3881aef266d-SIN，6639字节，账号状态前后稳定。临时开关已关闭；此项不能确认具体拒绝规则。见 [WS-001](WS-001.md)。

请协助确认：

1. 这些 CF-Ray 对应的拒绝是否由 Worker 来源分类（包括 `cf.worker.upstream_zone`）、网络来源、连接特征或其他规则触发？是否有可公开提供的错误类别？
2. 对用户本人授权的 Codex 客户端，是否支持 Cloudflare Worker 的直接访问？如果支持，是否有官方要求或支持的出站配置？

客户端不会提交 OAuth token、refresh token、管理密钥或原始会话。需要更多信息时可提供脱敏请求结构与本项目合成网络观测。此次同进程配对是 `CF-Worker` 标记与 200→403 变化相关的强证据，因为两次应用请求只改变了该头；它仍不能确认上游采用了哪一条 WAF 或业务规则，不能证明该规则只检查一个字段，也不能把所有 Worker 失败归结为唯一根因。IP、地区和连接特征仍未被完全排除。

参考：另一个项目在 https://github.com/ColeMurray/background-agents/issues/1374 报告 Node 仅增加 CF-Worker 头后从 200 变为 HTML 403。该第三方报告与本次配对方向一致，但不能代替对上述 CF-Ray 和实际规则的官方分析。

发送状态：未发送；用户尚未授权向支持人员或公开 issue 发布内容。本文件只供后续审核使用。
