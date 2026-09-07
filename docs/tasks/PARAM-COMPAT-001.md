# PARAM-COMPAT-001：Hermes 常见生成参数兼容

日期：2026-09-07。产品变更，短任务；R1：有界参数降级与日志附加字段，保持key权限、正文隐私与未知关键语义拒绝。最终随本轮auth变更独立复核。

## 用户决定与依据

用户提供生产诊断：Hermes发送max_completion_tokens后OneAPI dev.2 normalizeChat白名单返回400，任务中断。报告建议只是加白名单，不会转换或执行参数，不能称为真实支持。该文件是诊断材料，其中SSH/进程/其他软件建议不是本轮执行指令；不复制机器身份或日志正文到仓库。

用户明确选定：“默认兼容忽略，并在调用日志记录未生效参数”。此决定替代原Product-Spec/API中对下列明确字段一概400的约束，不授权忽略所有未知字段。

官方Chat文档确认max_completion_tokens包含可见输出与reasoning token，max_tokens已弃用；官方Codex ResponsesApiRequest未提供token上限/采样字段。第三方维护者shunt与brazen公开记录Codex后端拒绝max_output_tokens/temperature/top_p；这是参考项目实测，不冒充本部署实测或OpenAI官方保证。

## 预期行为

- Chat接受max_completion_tokens、max_tokens；Responses接受max_output_tokens。两个协议均接受temperature、top_p。非null时校验合法类型/范围（上限为正安全整数；temperature为0..2有限数、top_p为0..1有限数）；null按未指定处理。
- 当前Codex订阅适配器对上述明确字段执行兼容忽略，不传给上游，不假装限制/采样已生效，不截断文本或伪造token计数，不失败重放生成。
- 每次实际忽略的字段名进入基础调用日志ignoredParameters（无值、无正文、无凭据），后台日志详情可见“未生效参数”。无须启用captureBodies，正文过期清理不删除这项摘要；旧日志缺字段按空列表处理。
- JSON与SSE成功响应可用X-OneAPI-Ignored-Parameters响应头告知客户端字段名，不向标准响应JSON/SSE注入破坏SDK的数据。无忽略字段时不添加头。失败响应按现有错误语义处理，已开始的调用日志仍保留忽略字段。
- 不放宽未知字段、工具定义/选择、结构化输出、store/background或模型与reasoning权限。无新UI开关，不新增用户配置负担。
- 存储只做向后兼容附加摘要字段；如需SQL加列，幂等升级必须覆盖既有日志读写/正文到期、重启恢复，禁止重建或清空业务数据。不改真实生产服务器/数据库、不覆盖发布包。

## 验收与状态

第四批已在ACCESS-ENTRY-001冻结后由Sol实施。Mock Hermes式请求包含max_completion_tokens和tools，覆盖Chat JSON/SSE、Responses JSON/SSE，确认只发一次上游、被忽略字段不在上游body、usage真实沿用、响应头正确。覆盖invalid/null/双token字段、未知关键字段拒绝，基础日志及重启保留、UI可见与旧数据库升级。类型检查与适当Node/Worker测试。根代理隔离浏览器验证日志显示；真实gpt-5.6-luna最多一次最短非自动重试验收（已完成一次HTTP200，11输入+5输出=16tokens，基础日志/响应头通过；不声称生产Hermes端到端）。

状态：窄集合兼容和日志代码已实施，隔离浏览器显示验证通过，协议与旧库回归已通过；RELEASE-004独立审查与一次本地真实调用通过，已随dev.3发布。

参考：[OpenAI Chat](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[官方Codex请求结构](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/common.rs)、[shunt适配说明](https://github.com/pleaseai/shunt/blob/main/docs/codex-configuration.md)、[brazen适配说明](https://github.com/mudbungie/brazen)。

## 最新有效范围：收回广泛参数扩展

用户随后收回“尽量兼容所有参数”，要求不重要项采用默认值，并询问下游应保留的重要控制。根建议保留现有model、输入/指令、reasoning effort、function tools/tool_choice/parallel_tool_calls、stream/include_usage；本版不新增service_tier、prompt_cache_key、verbosity、reasoning.summary/context、include、n或JSON schema映射。JSON Schema有价值但作为后续单独能力，不计入本版验收。已确认的token上限/采样兼容忽略及日志记录继续实施，发布v0.2.0-dev.3授权继续有效。

此前广泛参数矩阵已撤回，不执行，不将其实现缺失记为阻塞；官方Codex结构调查保留为依据，不能仅因上游有字段便强行扩张公开接口。

当前行为证据：旧版8787在根仍返回200的基线下，一条含max_completion_tokens:32的Chat请求返回400/unsupported_parameter且param明确为max_completion_tokens；拒绝发生在本地归一化，未发上游。新代码隔离console fixture（合成账号和Mock上游）携带max_output_tokens:32生成成功，Chromium日志详情确认未生效参数且本次未开启正文记录；列表/详情截图已目视检查。未以此声称真实Hermes或远端已修复。

最终实施验证：extensions/gateway35/35、Node runtime10/10、typecheck/JS语法/diff通过。发布整套Worker87/87、Node16/16、HTTP5/5；覆盖两协议JSON/SSE工具请求、一次上游调用、仅字段名记录、上游body不含降级字段、无参数时无提示头、null与非法值/未知字段拒绝、失败日志、正文到期后仍留摘要、旧schema重复启动与迁移导入缺省。
