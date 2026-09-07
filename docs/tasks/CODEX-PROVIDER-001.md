# CODEX-PROVIDER-001：Codex 原生 provider 兼容

日期：2026-09-08。产品变更，短任务。R2：请求兼容会把 Codex 安装、会话、窗口和工作区相关元数据转交给既有 OpenAI Codex 上游；不改变调用 key、模型权限、正文记录开关或账户凭据边界。完成前需 fresh reviewer 独立审查。

## 用户决定与依据

用户实际将 Arcinks 配置为 Codex 自定义 provider 后发现：基础 `/v1/responses` 可用，但 OneAPI 拒绝 `include`、`prompt_cache_key`、`text`、`client_metadata` 和 Codex 结构化 `input`，`/v1/models` 也不是 Codex 模型目录格式。用户明确要求完整跑通 Codex 调用，并替代 PARAM-COMPAT-001 中“未知参数明确 400”的旧决定：下游未知参数应兼容忽略，不得因非关键新增字段阻断调用。

本机 Codex Desktop/CLI 0.153.4 对 loopback 假端点的无凭据捕获确认：客户端先发 `GET /v1/models?client_version=0.153.4`，再发 Responses 流式请求；首轮包含 `additional_tools` 输入项、`reasoning.context`、`include:["reasoning.encrypted_content"]`、`prompt_cache_key`、`text.verbosity`、`client_metadata`，并携带 Codex feature/session/turn 元数据头。捕获使用假 key、ephemeral 模式，不调用 OpenAI/Arcinks，不修改用户配置，端点已停止。

## 目标行为

- OneAPI 可作为当前 Codex 0.153.4 的自定义 `responses` provider，完成模型目录刷新、首轮文本、流式事件、多轮上下文及本地工具调用闭环。
- `/v1/models` 同时保留 OpenAI SDK 的 `object/data` 和 Codex 的原生 `models`；两者使用同一账号目录、隐藏规则和 key 模型范围，不能把被过滤模型从另一字段泄漏。
- 已知 Codex 功能字段与结构化 input 在有界校验后转给既有固定 OpenAI Codex 上游；`additional_tools` 仅允许客户端执行的 `function`、`custom` 及当前 Codex 0.153.4 必需的 `namespace` 声明，顶层工具仍只允许 `function/custom`；只转发必要的 Codex 元数据头，不转发客户端 Authorization、Cookie、User-Agent、Host 或任意未知头。
- 未知顶层生成字段按用户决定兼容忽略：不转发值、不返回 400；字段名进入现有 `ignoredParameters` 基础日志和 `X-OneAPI-Ignored-Parameters` 成功响应头。无须开启正文记录。
- 已知但会改变产品状态/数据边界的语义仍不是“未知”：`store:true`、`background:true`、`previous_response_id`、服务端托管工具等在没有对应实现时明确拒绝，不能以忽略伪装支持。
- 不改变请求体 1 MiB、非流响应 8 MiB、超时、取消、并发/RPM、模型权限、凭据刷新和错误脱敏边界。

## 非目标

- 不承诺所有未来 Codex 版本或完整 OpenAI Platform Responses API；以当前本机 Codex 0.153.4 的可观察协议为本版验收基线。
- 不新增服务端会话存储、后台任务、任意 URL 代理、托管工具执行或远端生产部署。
- 不修改用户长期 Codex provider 配置；端到端测试临时切换后必须恢复。

## 验收与证据

1. 失败先行/回归测试覆盖：未知字段忽略且不进上游 body；已知 native 字段、结构化 input 和必要头保留；非法已知字段仍 400。
2. `/v1/models` 的 `data` 与 `models` 同源且 key 过滤一致，旧 OpenAI SDK models.list 行为不变。
3. Worker/Node 针对性测试、typecheck、构建和发布包冒烟通过；无 secret 进入 diff/产物。
4. 本地服务复用已有登录账号；用临时 Codex 配置完成至少一轮真实模型响应，并完成一次本地工具调用后继续生成。控制调用次数，不自动重试扩大消耗。
5. fresh reviewer 对元数据转发、未知字段降级、目录隔离、日志隐私和回归证据给出结论。
6. 通过后随现有前端提交打包为 `v0.2.0-dev.4` prerelease；提交、tag、GitHub Release 与附件回下载校验留证，远端生产不自动更新。

状态：实施、自动化/真实 Codex/浏览器/候选安装包验证和 fresh R2 reviewer 均已完成并通过；未发布。
