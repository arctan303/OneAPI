# MARKER-001：真实来源头单变量对照

日期：2026-09-07，UTC 06:33:11 完成。代码基线为 efd57b9 加当前工作区的限定 MARKER 脚本；执行前已通过 [独立 R2 复核](MARKER-001-review.md)。原始脱敏回执保存在忽略目录 `output/ws-probe/marker-live.txt`。

## 结果

同一 Node 进程，使用项目既有本地存储中的同一凭据快照；固定 GET `https://chatgpt.com/backend-api/codex/models?client_version=0.153.4`。第二次仅增加 `CF-Worker: oneapi.12213443th.workers.dev`，没有更改其他应用请求头或目标。无自动重试，baseline 非 200 时不会继续；本次 baseline 为 200。

| 观测 | baseline | 增加 CF-Worker |
| --- | --- | --- |
| HTTP 状态 | 200 | 403 |
| Content-Type | application/json | text/html; charset=UTF-8 |
| 正文字节数 | 421087 | 6634 |
| CF-Ray | a373ae301b58fa7e-SJC | a373ae37ce28fa7e-SJC |
| Server | cloudflare | cloudflare |
| cf-mitigated | 无 challenge 值 | 无 challenge 值 |
| SHA-256 | 2802009be759f831b5a34a957e24670e5f12a5529710829359e9c309d4475a89 | c542bf0c7b768919d4c88a87cd21c68eaf96b0cbac47a72927f8df395815bc48 |

本地 `/admin/test/models` 200；前后 connected、reauthenticationRequired、tokenExpiresAt、lastRefreshAt 核验保持一致。实际 2 次资源 GET、0 生成、0 refresh、0 retry。临时运行器已经正常 dispose，未部署或启动公网 relay。未保存上游原始正文、账号 ID 或令牌。

## 判断与边界

本项目已复现单独增加来源头时 200→403 的结果，支持 CF-Worker 字段影响此次拒绝；不再仅以第三方问题报告推断。此前 Node 出站本身也曾观测为数据中心网络，因此将全部失败简单归因为机房 IP 不充分。

这仍是一次有界配对，不是上游 WAF 规则的官方确认；未抓取实际 socket peer，也不能排除逐请求路由差异或证明所有 Worker 失败只有这个原因。合成四路径观测中，Cloudflare 云 Worker/DO 的该标记由平台附加；本地标记对照不证明云端可以移除它，亦不把 Node 中转改写为纯 Worker 修复。

下一证据由 [WS-001](../tasks/WS-001.md) 承接：使用官方 Codex 支持的 Responses WebSocket 路径，只握手、不发送生成消息，检查另一传输方式是否同样拒绝。普通云端 API 尚未修复。

## 验证

- 两个脚本语法检查及 4/4 无网络 fixture 通过；覆盖单变量、预算、拒绝刷新目标、失败摘要、超限与永不结束流取消。
- 首轮 clone tee 挂住问题已改为单次有限读取并重建业务响应；异常路径保留计数和已有摘要，独立聚焦复核通过。
- 执行脚本：`node scripts/probe-local-marker.mjs`，退出码 0；业务目录请求 1800ms，非生成测试。
- 执行前实际 Secret 值比对审计覆盖源码/资源/构建和诊断脚本共 29 文件，命中 0；OAuth 值始终只在既有业务和固定官方目标之间使用。