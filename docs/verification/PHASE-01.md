# Phase-01 本地扩展验证

日期：2026-09-07。基线：v0.1.0 / 54631e0 之后的本地扩展。实施、验证、fresh R2 独立复核通过；未部署 Cloudflare、未推送本轮扩展。当前服务为 http://127.0.0.1:8787/，使用项目原 OAuth 与 .wrangler/state/v3。

## 最终结果

- 账号资料和官方订阅额度：真实可读。七天快照在本轮依次为79%、80%、83%已用；最后记录剩余17%，reset=2026-09-07 10:32:58（Asia/Singapore），仅代表快照时刻。
- 通用 fiveHour 未解析到窗口；显示未知。Spark 的独立5h/7d和gpt-reserve 7d单列，不补入通用额度。未保存原始额度正文，因此不反推 raw primary_window 一定为 null。
- 三个标准入口 /v1/models、/v1/responses、/v1/chat/completions 可用；按 key 返回目录与执行模型权限，停用/到期/RPM/并发限制保留旧 key 兼容。
- 管理员按 key 查看精简或可选正文日志、筛选/分页/JSON下载；默认不开正文，usage未知保留null，撤销key保留历史。保留策略、5000条已结束记录容量上限及alarm物理清理见 [API](../API.md)。
- 思考程度按当前账号官方目录：gpt-5.5 实际支持 low/medium/high/xhigh，默认 medium。后台动态选择；Responses reasoning.effort 与 Chat reasoning_effort 按请求传递。不使用公开 Platform 的档位表覆盖账号目录。

## 真实请求（共4次生成，SDK零重试）

| 基线与方式 | 结果 | 日志与边界 |
| --- | --- | --- |
| 扩展初次SDK Responses普通，未指定effort | completed，9字符；usage13/19/32 | 精简日志usage一致，两个正文null |
| 扩展初次SDK Chat流式，未指定effort | 11字符；usage13/19/32 | 启用正文后SSE日志可读，无截断/认证秘密 |
| 最终源码SDK Chat流式，指定low | 11字符；usage13/8/21 | 完整请求reasoning_effort=low，usage一致 |
| 最终后台浏览器Responses流式，指定low | 页面“测试通过”，实际回复PHASE1_UI | 管理员测试按契约不作为API-key日志 |

前两次命令为 node scripts/verify-extensions.mjs --live。随后还有RPM压缩、容量上限、取消通知、TTL alarm及思考目录/页面修复；不将早先成功当作最终源码全路径证明。最终SDK命令为 node scripts/verify-extensions.mjs --live --reasoning-only；最终浏览器命令为 node output/playwright/phase01-browser.mjs --live。两次最终请求覆盖新思考参数的实际调用，不重复旧普通生成。

最终SDK还证明：管理员与key目录能力元数据一致且仅含allowlist模型；其他模型及非法档位在两个接口拒绝；普通key不能读管理日志；临时key停用/恢复/撤销、历史保留、设置/key集合恢复、测试会话退出通过。

最终真实浏览器证明：登录与原账号连接、5张额度卡、目录6个模型、key创建/编辑/停恢与一次性明文隐藏、low动态选择、自己的完整key日志/正确筛选badge/JSON下载、390×844无横溢、退出清屏；pageErrors=0。根代理视觉检查确认实际回复及请求字段。截图在忽略的 output/playwright/phase01-real.png 与 phase01-real-mobile.png，不纳入Git。

## 隔离验证

- npm test：5 files / 60 tests全部通过；npm run typecheck通过。
- npm run test:dev-node：Node出站白名单/拒重定向、原存储与会话兼容、进程锁、流取消隔离、大请求413、普通聚合取消及后续可用通过。
- 普通取消使用真实loopback socket与隔离慢SSE：headers后destroy，Worker499/日志cancelled，上游signal/source取消，active/pending/groups归零，下一请求200。
- alarm专项直接触发后检查SQLite，未用GET触发lazy prune代替：正文物理NULL、实际expiry保留、缩短TTL提前清理、过期摘要删除、active保留、5000 completed上限。请求开始快照正文开关，清理排程使用当前保留策略。
- reasoning专项3/3：metadata/key过滤/null/[]/default、旧/过期/未来缓存刷新、首次并发singleflight、目录支持的none/max两协议精确转发、非法参数名、未指定省略、断开迟到不回写、非法目录JSON502。参数规范化另20/20通过。
- node scripts/verify-extensions.mjs：独立临时Node/Worker/DO/Mock上游和OpenAI SDK；两个协议显式low、权限/日志/usage/设置清理全部通过。
- 浏览器隔离全流程及专项均通过。可复跑本机夹具位于忽略的 output/playwright/：phase01-browser.mjs、phase01-ui-races.mjs、phase01-reasoning-ui.mjs、phase01-body-expiry-ui.mjs。分别证明分页与详情、慢A→快B、断开迟到清屏、手动key筛选/清空、动态档位精确payload、服务端expired权威（兼容旧响应）、防注入与手机布局。
- npm run build为Wrangler dry-run，通过，不创建或更新云端资源。

## 审查与修复

唯一fresh reviewer为 /root/review_phase01，复用同实例聚焦复核；最终无剩余P0/P1/P2。其独立34项后端聚焦测试及多组浏览器fixture通过。问题与证据见 [审查回执](PHASE-01-review.md)。

曾发现并关闭：普通取消误记502、日志仅lazy清理、过期原因丢失/客户端时钟误判、容量计数、RPM存储与删除、日志列表/详情异步竞争、断开残留账户/模型、手动筛选不清旧key，以及有效页面函数误删。首个全量曾35/36；最终60/60和实际浏览器关闭该回归。

早期test:dev-node有一次无具体await的ECONNRESET未定位；随后专项复现超限上传提前close，并修复该具体socket排空路径。不能仅凭相似症状断定两次同根因；修复后完整运行器检查通过，未自动重试真实生成。另有一次根代理临时probe误用Fetch Response.ok()导致失去新会话Cookie，该会话元数据自然过期；正式验收脚本创建的会话均退出，没有秘密泄露。

## 最终状态与证据边界

服务以最终代码重启，核验时PID17644、监听127.0.0.1:8787（不是未来固定停止目标）。末次只读核验：connected=true、reauthenticationRequired=false、captureBodies=false；仅原1把legacy key，测试key全撤销，3条自己的已完成API-key日志保留。该核验自己的会话也已退出；原OAuth和用户会话未重置。

真实数据与截图只在忽略存储/输出目录。本轮生成数只统计根代理显式4次，不把早前进程输出或其他客户端算入。目录可选不等于逐一生成，函数工具目前为Mock/SDK兼容证据；自然OAuth过期刷新、真实中途取消与Cloudflare部署未新增真实验收。取消链有真实loopback和隔离上游证据。Cloudflare仍保留后续隔离验证计划，本轮无任何云资源变更。

官方依据：[参数说明](https://developers.openai.com/api/docs/guides/latest-model)、[Codex model/list](https://learn.chatgpt.com/docs/app-server)、[ModelInfo固定源码](https://github.com/openai/codex/blob/4aec23384e85734bbae3a3eed06a9218babc4e51/codex-rs/protocol/src/openai_models.rs)。用量实现同一固定提交的 backend-client/src/client/rate_limit_resets.rs。
