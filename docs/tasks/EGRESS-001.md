# EGRESS-001：Worker 经本机 Node 出站对照

状态：临时诊断已完成；同凭据Node路径真实可用，已关闭临时配置和进程，2026-09-07；基线efd57b9 + WORKER-403诊断工作区，线上97efa97b-f5ec-4daf-bd1b-8e4f39b9fbc0。

## 目的、授权和范围

用户本轮明确授权按Worker→自己控制的Node→上游进行排查。新增诊断接口和跨组件access token处理，产品短任务，承接Phase-02/WORKER-403。风险R2：错误的目标/鉴权/重放可能泄漏或滥用凭据；需固定上游、应用层加密、重放拒绝、限制资源和fresh reviewer。沿用product-spec-builder/dev-builder；不新建冗余Phase。

仅管理员POST /admin/diagnostics/egress；请求JSON仅operation=models|usage|generate|ping。沿用admin session/Bearer/Access与CSRF。普通API key与未鉴权拒绝。关闭配置时503 egress_diagnostic_disabled。普通/v1及原后台请求不变，不新增UI。ping仅验证加密relay身份，不调用上游。

models/usage在同一个请求内读取一次当前云端StoredCredentials，顺序直连→relay，二者使用同一枚access token、同一业务请求字段；不refresh、不改OAuth。generate只经relay一次，固定gpt-5.5、默认思考、短提示Reply only EGRESS_OK；上游按既有normalize生成。上游401/403原样分类，不重登重试。不返回token、原始HTML/SSE、账户标识或全量响应。

## 临时链路与协议

- Node独立监听127.0.0.1:8791；仅GET /health（固定service:oneapi-egress-relay）和POST /relay。用本次专用Quick Tunnel暴露该端口，不暴露8787后台，不改既有DNS/Worker/DO。仅测试时运行，结束关闭。
- ONEAPI_RELAY_ORIGIN为配置的exact HTTPS origin，无路径/query/credentials；ONEAPI_RELAY_KEY为独立随机32字节base64密钥。Node从忽略文件.dev.vars.relay读取，Worker以Secret注入；禁止从公网请求选择origin/key。配置只对上述管理员诊断生效。仅传access token/accountId与所需业务字段，不传refresh/id token、管理key或云端存储密钥。
- src/relay-protocol.ts共享协议由Sol实现：AES-256-GCM，随机12-byte IV，request/response两个不同AAD；envelope {v:1,iv,data} base64。明文request含requestId(UUID)、issuedAt(ms)、operation(ping|models|usage|generate)、headers白名单、clientVersion、bodyText可选。response含同一requestId、status、headers白名单、bodyBase64；ping含固定service。Worker必须核对响应requestId，两个方向均加密。导出接口由两agent协调。
- Node验证时间±30秒，requestId在90秒内拒绝重放；缓存上限1000，满时拒绝。先通过加密认证/结构和资源检查再触达上游。全局最多2个活跃上游；请求最大64KiB明文（外层96KiB），响应最多2MiB明文body（外层4MiB）；读30秒、生成60秒，断开取消上游，无自动重试。
- 目标由operation派生，只能https://chatgpt.com/backend-api/codex/models?client_version=<validated version> GET、/backend-api/wham/usage GET、/backend-api/codex/responses POST。不接受URL/Host/任意方法；version仅短数字点版本。上游header仅authorization、chatgpt-account-id、accept、content-type、originator、user-agent、version，验证无换行/有界；不转发Tunnel传入的CF-*/Forwarded/Cookie或其他HTTP头。Node重建请求，redirect:error/manual拒绝跨域，沿用正常TLS校验。
- generate仅接受gpt-5.5固定诊断请求；Quick Tunnel不支持SSE，此实验在Node有界缓冲上游响应、加密后返回。不能宣称真实流式或生产中转已交付。
- Node不读取本地Demo OAuth或DO，不保存上游token/正文。stdout仅启动/固定错误类别；不得打印异常原文或请求/响应。

## 验证与预算

隔离fixture验证加密认证/篡改/重放/超时/越界/目标固定/无来源头转发、管理员与普通key隔离、同一token及response绑定、默认关闭。fresh R2审查通过后才能启动公网relay和上传Secret。

本组真实最多4次资源读取（models直连+relay，成功后usage直连+relay），最多1次relay短生成；ping/健康不算上游读取。目录relay失败就停止依赖步骤。无重试，不重放之前已失败的头实验。成功也只证明该云端token经Node路径可用，不能单独确认IP或Worker来源规则。

结束删除本次ONEAPI_RELAY_KEY云Secret并移除临时origin配置，确认诊断503禁用、普通管理正常，停止专用Tunnel/Node；保留本地忽略文件和脱敏回执以便恢复。无持久服务/费用承诺，不推送GitHub。

准备：cloudflared 2026.8.3官方GitHub Release windows-amd64，SHA256核对通过（83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae），仅下载到output/egress，未安装系统服务、未启动公网隧道。临时独立加密密钥已创建于Git忽略文件.dev.vars.relay，尚未上传。


## 最终验证与结论（2026-09-07）

用户补充“完全确认”，明确授权真实云端Codex access token以AES-GCM经本次butler-assessments-webcams-recall.trycloudflare.com传给本人Node内存解密，再向固定ChatGPT上游调用。先重新核对同一域名、本人Node/cloudflared进程和loopback健康，恢复配置后执行。前次自动审批拒绝已解除；没有换目的地或绕过审批。

| 项目 | Worker直连 | 同凭据经Node | 证据时间UTC |
| --- | --- | --- | --- |
| 模型目录 | 403，Cloudflare HTML，6639字节 | 200 JSON，6个可选模型 | 04:56:48 |
| 官方额度 | 403，Cloudflare HTML，6639字节 | 200 JSON，七天已用5%、剩余95% | 04:57:11 |
| 固定gpt-5.5最短生成 | 本任务未重复直连生成 | 200，completed=true，9字符，输入11/输出18/总29tokens | 04:57:18 |

七天窗口10080分钟，重置2026/09/14 10:33:36（UTC+8）；通用五小时窗口此次未返回，保持未知。目录可选gpt-6-astra、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna、gpt-5.5、gpt-5.4-mini，不代表逐一生成过。

实际计数：模型直连+中转2次、额度直连+中转2次、生成仅中转1次，共4资源读取+1生成，0重试、0令牌刷新。直连与中转在同一个管理员请求内读取同一份云端凭据并使用同一业务Request；中转没有读取本地Demo OAuth。观测报告保存在忽略目录output/egress/probe-*-2026-09-07T04-56/57-*.json，仅白名单摘要，不保存原始上游正文或令牌。

结论：同一云端令牌和资源权限在Node路径可用，403不是由该令牌本身或这些请求的账号资源权限导致。差异缩小到出站网络/运行时/平台来源特征；本对照同时改变了出口、连接实现和Worker自动来源标记，不能单独断定机房IP、具体WAF规则或cf.worker字段是根因。纯Worker仍未跑通；普通/v1与原后台接口未切换，不把诊断成功写成生产API已修复。

## 交付、清理与恢复

- 实现及测试：typecheck通过，协议/gateway22/22，全量75/75；Node最终3/3无skip（含实际HTTP客户端断开两次取消+名额回收）；Worker构建通过；最终准备时实际Secret扫描131文件0匹配。fresh R2 reviewer首轮条件经同一实例聚焦关闭，结论通过，见[审查回执](../verification/EGRESS-001-review.md)。
- 代码部署版本ee109fdb-a6dd-46e1-b09a-8ef91945370b；随后Secret操作会产生新部署版本。两项临时云Secret ONEAPI_RELAY_ORIGIN/ONEAPI_RELAY_KEY已删除，04:58:07回读503 egress_diagnostic_disabled。
- 04:58:51先核对进程路径和命令再停止本次cloudflared与Node；读回ownedProcessesRemaining=0、relayListeners=0。没有修改其他Worker、DNS、DO、原三Secrets或账号。临时域名不再作为可用入口。
- 04:58:57云端管理冒烟通过：管理员登录、CSRF、普通key无管理权，connected=true、reauthenticationRequired=false；测试key已撤销、测试会话已退出，额外上游读取/生成均0。
- 保留可审阅代码、部署说明、脱敏回执以及忽略文件.dev.vars.relay（独立随机密钥，无OAuth）；没有GitHub推送。用户随后明确继续推进单 Worker，恢复方向以 [Phase-02 后续路线](../dev-plan/phase-02.md#单-worker-后续路线2026-09-07) 为准，替代此前优先讨论生产 Node 出站的建议。本任务已完成，Node 只保留为诊断基线；生产中转不在当前实施范围。
