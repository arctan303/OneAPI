# LIVE-001 验证记录

日期：2026-09-07。实施与本地真实验收完成，R2 独立复核通过。任务：管理员登录、原账户恢复、真实目录、命名 API key 与指定模型调用。本地 Node 先可用已获用户明确授权；未部署 Cloudflare。

## 发现与修复

1. 原 Wrangler 本地运行方式复用现有账户，管理员登录和账户状态正常，真实目录返回 403 HTML；同一项目持久化登录通过 Node 出站可读取目录。证据支持整体本地传输差异，不能独立证明某一请求头是充分根因，也不能证明 Cloudflare 云端可用。
2. 两次普通生成 HTTP 200 但正文为空。一次管理员 SSE 诊断证实 message 的 output_item.done 已携带正文，最终 response.completed 的 output 却为空；聚合器只读最后一个事件，丢失已完成项。修复按 output_index 保留完成项，并在空终态时恢复，同时补齐缺失或空字符串的 output_text。非空终态保持权威，8 MiB 聚合限制仍有效。
3. 本地 Node 出站对官方 HTTPS 主机、路径、方法和 query 做限制，拒绝任何重定向。Miniflare 的外层 fetch 可能自行跟随，所以必须在 Node handler 内拒绝 3xx，不能仅依赖内层 redirect:manual。
4. Miniflare 自定义出站初版不把 Worker 取消传播到 Node。直接 handler 的 signal 测试无法证明跨运行时取消；组合探针已证实缺口：初版 dispatchFetch 及实际 loopback HTTP 的客户端取消均未触发 Node 上游取消。仅 DO 内部取消成功不能代替浏览器/SDK 取消；因此增加本地 HTTP 入口的断开检测，并使用服务端请求组关联取消。最终已用私有绑定的响应头前取消、实际 loopback HTTP 的 A/B 流中取消与后续第三条生成验证修复。使用 60 秒上游 deadline、2 秒内取消断言，避免以硬超时制造通过。

## 隔离验证

- 保留原 Worker name、DO class 与 .wrangler/state/v3 持久化路径。Wrangler Mock 写入后，Node 读到原账号、会话、key，并能生成和重启恢复。
- SQLite 独占锁防止两个 Node 运行器打开同一存储；不同存储可并行，进程被终止后操作系统释放锁。原 Wrangler 不遵守该锁，切换前必须停止旧实例。
- Node 目标拒绝矩阵、同允许目标与外部目标 307 均只触发一次 fakefetch，取消重定向 body，不向目标发第二次请求。
- 聚合回归修复前新用例 2 项失败；修复后 SSE + gateway 19/19，全量业务 Mock 26/26，TypeScript 检查通过。锁定 SDK 的 public responses.create 会无条件从 output 重算 output_text，不能把内部 parser 对空串的行为误写成 public SDK 已证实故障；原始 Response 自洽仍单独补齐。
- 最终运行器 test:dev-node 通过：响应头前 helper → binding 取消；真实 loopback HTTP 两条并发 SSE 使用相同伪造组头，入口生成不同服务端 UUID，取消 A 仅中止 A，取消 B 后第三条普通生成 200/completed，active/pending/groups 均为 0。上游为 fakefetch，不宣称进行了真实付费取消。
- 活跃请求组采用允许集合；正常结束、取消、异常都会删除，迟到注册拒绝，不依赖 5 秒取消墓碑。未消费的 Response 在 deadline 到期时也清理，dispose 中止存量请求。
- 最终 adapter 还覆盖响应 hop-by-hop 字段剥除、超 1 MiB 的 JSON 413/nosniff 与不增加 fake 上游调用。
- npm run build（Wrangler dry-run）通过；原云端默认绑定仅 ACCOUNT/ASSETS，没有部署。
- SDK smoke 固定 maxRetries:0，每次只发一次目录、一次生成；只输出结构与文本长度，测试 key 与管理员会话在 finally 清理。

## 本轮真实请求计数（收尾）

| 运行方式 | 目录 | 生成 | 结果 |
| --- | --- | --- | --- |
| 原 Wrangler | 1 | 0 | 目录 403 |
| 稳定 Node 前台 | 5 | 5 | 目录全部 200；前 2 次 key 普通生成 HTTP 200 但聚合无正文；1 次管理员 SSE 诊断有正文；最终新 key SDK 与页面流式均成功且正文准确 |
| 初版 Node 脱离终端实例 | 1 次尝试，是否到上游未知 | 0 | 本地连接断开、进程退出，不能算确认的上游请求或成功证据 |

首次原服务已退出导致的 ECONNREFUSED 没有发出上游请求。计数不抹除旧任务的历史调用。上述稳定运行未观察到 OAuth 刷新请求，未发起新设备授权。已创建的临时 key 均撤销；早期脱离终端实例中测试会话的清理失败，未伪报成功，按既有会话到期机制处理。

真实目录：gpt-6-astra、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna、gpt-5.5、gpt-5.4-mini。列出代表目录可选，不代表各模型均已逐个生成验证；本轮真实生成仅 gpt-5.5。

## 最终真实验收

最终真实 SDK 命令：npm run smoke:live，exit 0。管理员登录 200；connected true / reauthenticationRequired false；目录 200 返回上述 6 项；创建临时 key 201；OpenAI Node SDK 7.10.0 仅设置 Base URL/key、maxRetries 0，调用 gpt-5.5 的 /v1/responses，status completed、output_text 长度 7、exactReply true（LIVE_OK）；临时 key 撤销 204、测试会话退出 204。

最终浏览器：独立 Edge context，管理员登录 → 原账号已连接 → 点击加载模型显示 6 项 → 指定 gpt-5.5 发送流式消息。/admin/test/responses 200、页面“测试通过”、助手正文长度 5 且准确为 UI_OK；退出本次会话 204。脚本没有在 CLI 参数、日志或截图中输出管理员口令/key/token。

截图：[后台真实成功](../../output/playwright/live001-real-success.png)。主会话已实际查看截图，账号显示已连接、目录 6 项、gpt-5.5、UI_OK 和创建密钥区域；完整 key 没有出现在图中。浏览器测试脚本和状态检查脚本位于本机忽略目录 output/playwright，截图反映测试当时状态，测试会话已退出。

## 精确代码基线与收尾

真实 SDK/页面基于 dev-local 31064B844070EEB8842796A42CA9E7CDEA555F05D0BF83488D565171270D853E、collector 5FADC3D6FC7E51B8F5D2ABF9C0CD84D5994D4A329FBD5E02FBE47ABC34C1ECA8、adapter 64A3A39F303DC58F78BCC5C1C8E14E4D0E3C2B277924723D13B35347C50C2BFA。

随后 adapter 的唯一小修是本地 JSON 错误 nosniff 与响应 hop-by-hop/Connection 字段剥除，最终 hash 5F9488552150D5431DF84F6EB06C7D60A0B4D9C17B6C118A8A90221ABB838F0B；请求、分组、取消、DO 和上游逻辑未变化。受影响真实 HTTP Mock 流、普通 JSON、413 及进程启动检查通过，故没有为这次响应头小修重复付费模型调用。

最终源代码：local-outbound F05DCFFFCC729A69D45570245AD6861E8860DB4415AB365DF7A9AB7434BFB8DD；account A5320D4DAE073F11CFE82B4DB9C397B90BE800973DBBA4FF27148EF5004BCA44；types ED9290E3EA7637B51DE30A23ECCB31CC82448D699F2EFC37A937DFEBEBCBE867；运行器验证脚本 B0A3E76BDA8A2A688DA00BBFB2E22878BC1BDD15983D34A4DDC234678075CFB4。

最终 5F948 adapter 已重启载入。收尾进程 PID 2940，前台会话 79521；http://127.0.0.1:8787/，健康 200/ok true；connected true、reauthenticationRequired false；API key 数量恢复原基线 0，所有本轮临时 key 已撤销。状态回读没有发上游请求；稳定运行 trace 只有上述模型/生成路径，没有 OAuth 刷新。进程保留运行，PID 会随下次启动变化。

## 独立审查与限制

同一 fresh reviewer 对最终 hash 独立核验。首次 test:dev-node 在恢复状态后无断言栈 exit 1；确认无残留后同 hash 仅复跑一次，完整通过。原因未证实，记录为一次测试运行中断，不把首轮写成通过。独立业务 Mock 26/26、typecheck 与脚本语法检查通过；正式结论：通过，无未关闭 P0/P1/P2；见 [独立复核回执](LIVE-001-review.md)。

未执行 Cloudflare 部署、自然 token 刷新或所有模型/Chat/工具的真实测试。早期脱离终端进程退出原因未知，不能归因于未经证实的 Response 类型问题。本地正常生成、模型目录与客户端取消分别用真实订阅和隔离上游证据验证，不混用证据范围。
