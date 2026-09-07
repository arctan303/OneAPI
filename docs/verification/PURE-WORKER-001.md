# PURE-WORKER-001 观测记录

日期：2026-09-07。本轮参考核查与无令牌观测已完成；原 OneAPI 403 未修复。

## 可验证事实与能力边界

- 原 EGRESS-001 使用同一云端凭据，Node 可读取目录与额度并生成，Worker 直接访问仍 403。该实验同时改变网络、运行时和平台来源特征，不能单独定位根因。
- 当前本地脚本 scripts/dev-local.mjs 使用 miniflare 导出的 fetch；已安装 miniflare 源码 fetch4 的普通 HTTP 路径调用 undici.fetch。源码位置只证明实现，不证明所有网络配置。
- 当前工具进程未发现名称匹配 PROXY、NODE_OPTIONS、NODE_EXTRA_CA_CERTS、SSL_CERT 的环境变量。不足以排除系统代理、TUN、策略路由或宿主影响。
- [Cloudflare 请求文档](https://developers.cloudflare.com/workers/runtime-apis/request/) 定义的 request.cf 包含入站 HTTP/TLS 与 ASN 信息。观测接收端数据不能直接代表 ChatGPT 的规则或出站握手；Worker 子请求的字段还可能保留外层连接信息。
- [global_fetch_strictly_public](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public) 在本工具用于同 Worker 的 /collect 公网回环。该配置不构成 chatgpt.com 跨 zone 请求的新修复证据。
- [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations) 禁止访问 Cloudflare IP 范围，因此不能预设手写 TCP/TLS 可替代当前上游 fetch。

## 隔离与资源基线

部署前清单只有 arcinks-com、blog、mail、music-arctan-top、oneapi；namespace 只有原 oneapi_AccountDurableObject。oneapi-network-probe 无冲突。清单存在忽略目录 output/network-probe/inventory-before.json。禁止改原账号 namespace 或其他服务。

## 实际观测

固定 JSON、应用 headers、诚实 User-Agent 相同；接收端四条观测均成功，UA 与 Accept-Encoding 的摘要在四条中一致。数据为自身 workers.dev 接收端的观测，不等于 ChatGPT 所见。

| 路径 | UTC 时间 | CF-Worker | CF-Connecting-IP 摘要前缀 | HTTP / TLS | 接收端 ASN |
| --- | --- | --- | --- | --- | --- |
| Node（miniflare 导出 fetch / undici） | 05:34:49 | 无 | e436730fd5c9 | HTTP/1.1、TLSv1.3、AES256-GCM，ClientHello 1626 bytes | 16509，Amazon Data Services Singapore |
| 云顶层 Worker | 05:39:23 | 有 | abc9a4f1ab7d | HTTP/1.1；TLS 元数据未提供，ClientHello 长度 0 | 13335，Cloudflare |
| 云 ProbeDO | 05:39:24 | 有 | abc9a4f1ab7d | 与顶层相同 | 13335，Cloudflare |
| 本地 workerd（独立 Miniflare，cf:false） | 05:39:25 | 无 | af917f74c8ac | HTTP/1.1、TLSv1.3、CHACHA20-POLY1305，ClientHello 508 bytes | 16509，Amazon.com |

完整脱敏字段在忽略目录 output/network-probe/{node,worker-top,worker-do,local-workerd}.json。Node/本地 workerd 的 TLS cipher 与扩展摘要不同；两个云分支的 CF-Worker 摘要相同。云端 TLS null 不是明文连接证据，是接收端未提供这类元数据。CF-Connecting-IP 只是边缘请求头，不宣称它是实际 socket peer。

结论：本项目这次合成观测证实云端存在 Worker 来源标记，但本地 workerd 不带该头；不能直接照搬外部 issue 把所有本地/云端失败都归到同一个头。两个本地路径的来源头和握手不同，也没有建立同一实际出口的对照。DO 与顶层 Worker 在当前观测中没有显示可去除标记的区别；这些证据不足以支持为移动出站代码而传递真实凭据。没有新增值得执行的纯 Worker 目录变体，本轮不使用后续四次目录预算。

## 开源参考与停止条件

[资料核查](PURE-WORKER-references.md) 核对五个相关候选/基线，其中三个有 Worker/OAuth 相关代码或部署说明，未找到足以复现 Worker 直连成功的证据。最相关的 [background-agents #1374](https://github.com/ColeMurray/background-agents/issues/1374) 是第三方单 Node 进程仅加入 CF-Worker 后从 200 变 403 的报告；这是对方实验，不是本项目确诊。

本轮没有来源充分的纯 Worker 修复方案。停止无依据的真实账号调用；恢复条件是平台/上游明确规则反馈、可复现的直连成功实现，或官方新增可控制且相关的出站能力。[支持草稿](PURE-WORKER-support-draft.md) 已整理既有时间和 CF-Ray，未对外发送。普通 /v1、账号、日志、额度仍按原行为，不能把探测成功写成网关成功。

## 工具实现、验证与真实失败修正

实现仅 scripts/network-probe/，无需新增依赖或任何账号 secret。固定 collector origin、合成正文、小响应、超时、元数据白名单和 hash；ProbeDO 不读写存储。无任意 URL 转发。风险 R1，自查完成；待例行复查队列不表示原 403 已修复。

- 最终无网络单测 6/6，通过语法检查；真实本地 workerd fixture 2/2（test-runtime.mjs），覆盖本地 collect 200 与固定进程内 outbound 403 恰好一次，均 finally dispose、无公网。
- 首次检查发现慢正文取消抢先返回 done 的竞态，已改为先拒绝超时并保留 timedOut 状态；新增字段的 fixture 同步。
- 首轮三个客户端 probe 在网络发送前因 global Request 与 miniflare.Request 不兼容而失败；离线构造复现 Failed to parse URL from [object Request]，改为 URL + plain init。初始回执的 collectorAttempts:1 为意图计数，并非已触达；这三次实际未发出 collector 请求。
- 真实本地启动另复现 Miniflare v5 workers 配置/模块图要求，修复为 convertV4MiniflareOptions + bundle。首次云 top/DO 外层返回502：workerd 在构造 redirect:error 时即报 TypeError；本地 fixture 证明 collectorCalls=0。改为 manual 后显式拒绝非2xx，再各补一次失败路径。没有重复已成功的 Node 样本。
- 最终 dry-run：12.78 KiB / gzip 3.80 KiB，2个绑定（PROBE、COLLECTOR_ORIGIN），无账户绑定/Secrets；构建与源码实际敏感值扫描9文件0匹配。后来新增的本地 runtime fixture/README 不进入部署产物；最终源码及产物扫描10文件0敏感值匹配，10个本地文档链接无缺失，git diff --check通过。最终core/run哈希与开发交付一致。
- 最终计数：成功到达 collector 的观测4条；另有3次本机 Request preflight失败与2次云构造失败，已保留回执及离线复现，修正后仅补失败路径，无自动重试。OpenAI/Codex 资源请求0、生成0、OAuth刷新0。

## 部署与清理

- 临时 Worker oneapi-network-probe；初始版本5584d970-530c-432d-a9c4-86a487893569；修正版本faf41a2c-b6ed-4133-b3a6-555d3ab39f54。独立 ProbeDO namespace ef5e1c32fbd841dfa03ca5c8d9506dfe，无账号/持久业务数据。
- 05:40:50 UTC，按创建前后清单核验后以 force=false 删除本次 Worker。05:41:14 回读确认 Worker 及 ProbeDO namespace 均不存在，原五个 Worker 的 modified_on 均未变，原账号 namespace 完全一致，api.arcinks.com /health 200。回执 output/network-probe/cleanup.json 与 final-readback.json。
- 未改 DNS、Access、原 oneapi 源码或部署、原账号 Secret，也未推送 GitHub。保留可复现探测源码、配置、脱敏证据；临时入口已不可用。一次相对 outdir 意外生成的 C:/output/network-probe/build/README.md 已核对准确内容后仅删除该文件；最终构建明确在工作区 output/network-probe/build。