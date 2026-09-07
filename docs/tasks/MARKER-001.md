# MARKER-001：同 Node 进程的真实 CF-Worker 单变量诊断

状态：诊断完成；实现、无网络验证、fresh R2 聚焦复核、真实两次读取均完成。2026-09-07。结果与边界见 [验证记录](../verification/MARKER-001.md)：同 Node baseline200，仅增加 CF-Worker 后403，账号状态不变；纯 Worker 修复仍未完成，后续由 WS-001 承接。

目标：将第三方“Node仅加CF-Worker即403”报告变成本项目可核验的因果对照，而非直接套用到所有运行时。此实验是继续推进单 Worker 的诊断，不是生产 Node 中转方案。

依据与替代：用户在 PURE-WORKER-001 收尾后明确要求“继续排查呀 不要等我喊呀”。此授权允许在原项目范围继续合理有界排障，不再将等待支持反馈作为唯一恢复条件。PURE-WORKER-001 四路径数据和失败/清理事实不变；先前未做的真实标记对照由本任务承接。

范围：独立本地脚本复用 dev-local.createRuntime 与现有本项目账号存储、管理员接口和固定模型请求；不部署、不打开新公网relay、不改普通业务、云账号或其他应用凭据。主会话统筹，Sol/high实现，Luna定位本地Wrangler/Miniflare头注入差异。现有工作区未提交修改保留，不冒认旧成果。

具体假设：在同一Node进程、同一凭据快照与同一个请求中，CF-Worker请求头是否足以让模型目录从200变403。仅该头发生变化；网络路径仍可能有每请求变化，因此成功对照支持该字段影响但不是平台规则的官方证明。

预算：最多2次固定models GET（baseline→variant），baseline不为200则不发variant；0生成、0refresh、0自动重试、0账号导出。variant值固定为本项目workers.dev来源。仅向固定https://chatgpt.com/backend-api/codex/models?client_version=当前版本发送，其他上游一律拒绝。

账号边界：以port0启动临时本地服务，沿用原存储锁，不并发打开。只从.dev.vars读取管理员key触发正常/admin/status和/admin/test/models。预检token有效期大于6分钟；无expiry时最近刷新必须未接近8天边界；否则不发上游。若baseline401，记录摘要并给业务synthetic502防止正常模型逻辑触发刷新/失效，不能记为请求成功。前后对照连接、reauth、expiry、lastRefresh保持一致；finally释放进程和存储锁。

风险R2：诊断拦截器临时处理真实access token且发送额外读取，错误可能外带凭据/越过预算/损坏登录状态。故严格固定目标、只内存复制、不输出敏感头或原响应、共享abort/有限时间和2MiB响应上限，真实执行前完成fixture与fresh reviewer。此授权不要求用户重复确认；若工具审批确实拦截则按实际原因处理，不绕过。

验证：两请求header diff恰好CF-Worker，共享signal，nonmodels/重复触发拒绝，baseline失败停止且不触发账号刷新，摘要无正文/账号标识/令牌，超时取消与读上限；真实运行前后status一致。需要保存命令、脱敏结果与实际计数，区分本机工具失败和上游拒绝。

结果分支：baseline200+variant403支持来源头影响，再结合原本地运行时注入源码定位可恢复的本地路径；两者200则该头在此对照不充分，转向有证据的连接/网络差异；baseline失败或超时则本次不具备因果结论，不无限重试。任何真实修复需另外验收原Worker目录/额度/生成，不能拿本任务代替。