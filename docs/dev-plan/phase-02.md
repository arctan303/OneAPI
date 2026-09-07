# Phase-02：Cloudflare Worker 部署与 Access 管理登录

状态：实施完成；本地验证与部署前R2审查通过；oneapi/api.arcinks.com已部署；云端新登录成功，但模型目录与额度仍403，端到端验收受阻。初始代码基线 `4294b99`；后续诊断交付见[WORKER-403](../maintenance/WORKER-403.md)，2026-09-07。

## 目标与授权

用户明确要求开始部署，目标 `api.arcinks.com`，Worker 名称沿用仓库名（部署标识采用 `oneapi`）。允许在自己的新 Worker 复用本地 Demo 已登录的 Codex 账号；若迁移需要人工授权，保留已完成部署并停在该步骤等待用户。允许新建必要存储，禁止影响其他现有服务。

depends_on：Phase-01 本地能力、真实两协议和思考程度验收、独立审查通过。supersedes：原 Phase-02 仅设备码登录、不复制本地 OAuth、不绑定域名的默认限制，由本轮明确授权替代。

## 范围与预期行为

- 后台配置 Team Domain、Application AUD 和启用开关。有效 Access JWT 为唯一管理员；验证签名、issuer、audience、时间边界，固定可信 JWKS 地址。
- 保留管理员 key 登录及 Bearer 管理；Access 边缘卡住时用户在 Cloudflare 控制台关闭门禁，不另设恢复域名。
- `/v1/*` 继续只接受调用 key。Access 门禁仅配置管理路径，不让机器调用跳转登录。
- 独立云配置、加密密钥和 DO；只迁移 Demo 账号凭据，不复制本地会话、日志或自建 key。管理员口令复用方便用户恢复。导入仅 HTTPS、管理员 Bearer 和临时额外导入 secret，空账号才允许；成功关闭导入功能。
- 仓库提供部署、Secrets、域名、Access 手工配置、迁移、回滚和实测限制说明。

## 实施与验收

1. 只读清单确认 Worker 名及域名冲突；域名绑定禁止替换已有 DNS/Worker。
2. Sol/high 实施 Access 后端/导入与鉴权测试；Luna/high 实施 UI；主会话负责部署脚本/说明和集成。
3. 鉴权、CSRF、配置失效、API key 隔离、导入保护测试及 fresh R2 审查通过，再部署。
4. 回读新资源；迁移后有限查询官方目录/额度；成功再用新 key 测试 gpt-5.5 两协议及思考程度。403 等失败明确记录，禁止以 Node 或 Mock 代替纯 Worker 证据。
5. 验证已有服务未改；记录资源/版本、登录状态及用户是否需要操作。迁移失败不无限重试。

风险 R2：鉴权与凭据迁移可能允许越权或泄漏订阅访问能力；需验签/失效/CSRF/Secret 不落输出/导入关闭证据。不额外创建 D1/KV，沿用 SQLite DO 架构。

## 已核对事实

Wrangler 已登录。现有 Worker 为 arcinks-com、blog、mail、music-arctan-top，无 oneapi。无 api.arcinks.com Worker Custom Domain、无 zone Worker routes。DNS 查询权限不足（403），不能据此认为 DNS 空闲。Wrangler 非 TTY 发布会开启覆盖，故配置不自动绑定路由，改用 API changeset 预检和覆盖标志 false 的绑定。Access 应用列表为空。只读清单在忽略目录 output/phase02/inventory.json，不含 token。

## 当前恢复检查点

前次自动审批要求的具体凭据授权已由用户“允许”补齐。Worker和指定域名已部署，管理员/key隔离真实检查通过；受控迁移被一次目录403拒绝后已关闭临时导入。用户随后在云端重新授权成功；2026-09-07T03:34:52Z确认connected=true、无需重登，但一次目录检查仍403。保留新登录，未发送生成，不继续重复登录。

事实、版本、资源ID和限制见 [验证](../verification/PHASE-02.md)；[部署前审查](../verification/PHASE-02-review.md)结论仍限于原鉴权/迁移基线；后续R1诊断变更与线上单变量对照另见[WORKER-403](../maintenance/WORKER-403.md)。当前阻碍是Worker资源请求上游403，根因未证实；Access真实SSO未验收。不能以管理后台上线替代上游可用。

追加任务[EGRESS-001](../tasks/EGRESS-001.md)已完成并关闭临时链路：同一云端凭据直连目录/额度403，经Node两者200且gpt-5.5生成成功；独立R2审查通过。普通API仍保持原路径，生产中转未实施。

## 单 Worker 后续路线（2026-09-07）

依据：用户继续要求朝单 Worker 目标逐步排查。目标仍为 oneapi 自身完成上游访问（沿用 DO 存储），无需常驻本机、外部代理或服务器。EGRESS-001 的 Node 仅为诊断证据，不是交付方案；替代该任务原恢复段优先讨论生产 Node 出站的方向。本节为现有 Phase 的后续计划；前两项准备已完成，见 [PURE-WORKER-001](../tasks/PURE-WORKER-001.md)：无令牌四路径观测与开源核查完成、临时资源已删除；未发现有依据的纯 Worker 修复变体，未新增上游调用。

前置证据：同云端凭据经 Node 可用，Worker 直连 403；出口、连接实现和平台来源特征同时变化，具体根因未知。保留现有登录，不重复登录或已失败的 Content-Type / User-Agent 对照。

| 顺序 | 工作与产物 | 通过条件 / 下一步 |
| --- | --- | --- |
| 1：参考实现与无令牌观测 | 检查开源候选的真实出站代码、部署配置和可复现证据，区分 Codex OAuth、平台 API key、隐藏代理及未经实测的兼容声明。设计合成探测，比较本地 Node、本地 workerd、线上 Worker/DO 到同一自有受控接收端的请求头、网络和协议元数据。 | 差异表、资料出处、最多两个有依据的假设。接收端看不到的 TLS、出口或平台内部信息记未知；自身接收端不能代表 ChatGPT 所见。没有具体假设就不发新账号请求。 |
| 2：最小真实目录对照 | 只选官方能力或可复现实例支持的纯 Worker 改法，先以合成请求证明变量生效。可评估顶层 Worker 与当前 DO 出站差异，但不预先声称位置或出口一定变化。固定同一凭据、上游和业务请求，一次改变一个可控因素。 | 每个假设最多一次基线和一次变体目录读取；首轮最多两个假设、四次读取、零生成、零重试。必须返回真实官方 200 JSON，HTML、缓存或硬编码目录不算。失败记录并恢复；预算耗尽且无新证据则停止真实调用。 |
| 3：额度与生成 | 目录成功后查询一次官方额度，再用 gpt-5.5 做一次最短生成，验证真实 token 用量。未返回的额度窗口继续显示未知。 | 最多一次额度读取和一次生成，零重试；任一步失败先定位，不继续后续生成或宣布已可用。 |
| 4：集成与完整验收 | 最小成功后才集成后台检测、key 的 /v1/models 与模型权限、Responses / Chat Completions、流式、思考程度、日志和凭据刷新。 | 实施前按验收矩阵另列有限调用预算；针对性验证，受影响 R2 变更独立审查，部署并真实回读。刷新需真实生命周期证据或明确保留缺口；纯 Worker 端到端通过才关闭上游阻碍。 |

边界与风险：本次仅计划 R0；观测工具按实际实现评估。凭据跨运行边界或新增诊断权限按 R2 验证并 fresh review，不沿用旧代码审查证明新代码。主会话统筹，后续开发 Sol/high，简单脚本或资料核对 Luna。只用本项目授权资源，不改其他服务，不删除或替换 primary DO，不向第三方回显站发送真实令牌。不随机改头、反复换节点或无限重试。

已核实官方限制：[node:http](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/) 封装 fetch，Node 兼容不等于本地 Node 出站；[CF-Worker / cf.worker.upstream_zone](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-worker) 是平台来源信息，删业务请求头不能证明移除平台标记；[DO locationHint](https://developers.cloudflare.com/durable-objects/reference/data-location/) 只在首次定位生效且不保证位置，不能用于声称迁移现有账号对象。这些说明平台能力，不证明具体拒绝规则。

停止与恢复：有依据的变体仍被拒绝且无对应官方控制能力时，保留“纯 Worker 上游访问受阻、具体规则未知”，整理时间、CF-Ray、路径及脱敏对照供支持工单草稿，不自动向外发送。恢复需要可复现的纯 Worker 成功实现、新的平台能力或上游明确反馈。Node 成功基线保留供诊断，不默认转成生产依赖。

继续排查（用户明确要求自主推进）已实际执行：[MARKER-001](../verification/MARKER-001.md) 完成同Node来源头200→403对照，[WS-001](../verification/WS-001.md) 完成官方WebSocket云端一次握手且仍403。两项均先实现、验证并独立审查后实测；0生成、账号状态未变，临时开关已清理。它们承接并替代上轮提前将外部反馈作为唯一下一步的暂停方向；现有两条新假设已得到结果，具体上游规则仍未知，单Worker交付目标保持未完成。
