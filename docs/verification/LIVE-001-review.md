# LIVE-001 R2 独立复核回执

日期：2026-09-07。Reviewer：review_live_local（gpt-5.6-sol / high），使用 reviewer 技能；同一个 fresh 实例完成首次与聚焦复核。主会话根据其最终回执持久化本记录。

结论：通过，最终冻结范围无未关闭 P0/P1/P2。不是发布或云端通过。

## 范围与基线

- dev-local.mjs：31064B844070EEB8842796A42CA9E7CDEA555F05D0BF83488D565171270D853E
- local-http-server.mjs：5F9488552150D5431DF84F6EB06C7D60A0B4D9C17B6C118A8A90221ABB838F0B
- verify-dev-local.mjs：B0A3E76BDA8A2A688DA00BBFB2E22878BC1BDD15983D34A4DDC234678075CFB4
- local-outbound.ts：F05DCFFFCC729A69D45570245AD6861E8860DB4415AB365DF7A9AB7434BFB8DD
- account.ts：A5320D4DAE073F11CFE82B4DB9C397B90BE800973DBBA4FF27148EF5004BCA44
- responses.ts：5FADC3D6FC7E51B8F5D2ABF9C0CD84D5994D4A329FBD5E02FBE47ABC34C1ECA8
- 同时检查 types、公开页面、live-session-smoke 和当前契约/任务/验证文档。

## 关闭的问题

1. 固定官方 HTTPS 主机/路径/方法/query，所有 3xx 在 Node 边界取消 body 并拒绝，不交给 Workerd 跟随。
2. 内部 request/group 标识及 hop-by-hop 不出上游，日志和错误脱敏。
3. 新 HTTP front 用服务端 UUID 覆盖客户端组标识；断开先关闭允许组，再只取消对应出站。未打开/已关闭组的迟到调用在出站前拒绝。
4. 正常、错误、取消、deadline、dispose 清理 active/pending/groups；取消 A 不误停 B，后续第三条生成可用。
5. 同名 v3 存储兼容和 SQLite 独占锁。原 Wrangler 不遵守锁，切换先停止旧实例的限制已记录。
6. 真实 smoke 默认固定一次目录、一次生成、SDK 零重试，key/session 最后清理，输出无敏感值；旧多生成脚本不再是默认入口。
7. 空终态 output 从 done items 按 output_index 恢复，缺失/空 output_text 补齐，非空终态维持权威。SDK public create 的重算路径与内部 parser 的条件路径已区分，未把错误推断写成真实根因。

## 独立行为证据

- test:dev-node 首次恢复状态后无栈 exit 1；确认无残留后，同 hash 仅诊断复跑一次完整通过。原因未证实，首轮不计通过。
- 最终通过覆盖：实际 loopback A/B 取消隔离、60 秒 deadline 下 2 秒内取消、第三条生成成功、307 底层单次调用、413 JSON/nosniff、存储兼容/锁和状态归零。
- npm test：3 文件、26/26 通过；typecheck 通过；相关脚本语法通过。
- 主会话另外完成 Wrangler dry-run build 与文档链接检查。

## 真实验收与边界

主会话执行真实目录、新 key SDK gpt-5.5 精确 LIVE_OK、Edge 管理员流式精确 UI_OK、清理与状态回读。真实 adapter 基线64A3，后续仅响应 hop-by-hop/nosniff小修至5F948，HTTP Mock覆盖且最终版本已重启、health 200、账号连接正常、key 0。

取消使用真实 Worker/DO/front 加 fake 上游；未进行付费真实取消。Cloudflare部署、自然OAuth刷新、其他模型逐一生成、Chat及函数工具真实行为未验收。完整计数、截图与运行入口见 [LIVE-001 验证](LIVE-001.md)。
