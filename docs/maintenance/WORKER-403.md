# WORKER-403：线上登录后资源接口拒绝

状态：本轮对照结束；诊断已部署并验证，上游调用仍受阻，2026-09-07；基线efd57b9，关联Phase-02 / REQ-03、11、12。用户明确授权oneapi/api.arcinks.com测试修改；保留账号和存储，不影响其他Worker。

目标：恢复纯Worker真实目录、额度及生成能力，不硬编码目录或吞403。非目标：复制浏览器挑战Cookie、任意URL代理、关闭TLS、影响其他服务；新增外部常驻服务需新的范围决定。

已知：新设备授权成功，status200 connectedtrue reauthfalse；目录和额度403。Node与Worker共用业务请求构造但传输不同。WAF、IP、CF-Worker头或地区根因均未证实。

步骤：先让已鉴权管理员读取白名单错误诊断，绝不返回HTML/请求凭据；然后仅移除GET Content-Type做同账号线上对照；必要时省略reasoning最短gpt-5.5直接生成一次，验证目录失败是否覆盖生成。仅基于新证据追加假设。首组最多6次资源读取、1次生成，无自动重试；有明确新假设才记录追加预算。

风险R1：管理员白名单错误元数据、明确GET字段兼容修复，沿用权限。若涉及凭据跨组件、数据迁移或鉴权边界则R2并fresh review。Sol/high研究官方契约并实现诊断测试；root负责脱敏探测、部署、文档和对照。

已执行：初次tail命令采样参数无效，未发上游；修正后一次目录403但tail未捕获DO诊断，0生成。临时collector存output/phase02/diagnose-worker-upstream.mjs，不作为已验证交付脚本。下一步部署管理员诊断基线，保存错误类别/CF Ray/长度或hash等无凭据证据。

## 2026-09-07 线上对照

- 诊断基线部署：72cde0cc-0a34-4a0b-811e-2a597a5290da。typecheck、gateway/extensions 29/29、Worker构建通过；实际秘密扫描123文件0匹配。
- 基线模型与额度各1次：上游均403，text/html;charset=UTF-8，server=cloudflare，CF Ray后缀SIN，bodyBytes=6639，无title/cf-mitigated/cf-error-code。
- 基线直接生成1次：gpt-5.5，普通Responses，无reasoning、不预加载目录；同样403/HTML/6639/SIN。因此不是只有目录失败；无有效生成结果或官方token用量可报告。
- 候选A部署：fdc22752-6cd1-4af8-9dee-5d9e4a80912c，仅移除models/usage GET Content-Type，保留POST与其他头。类型与针对性测试通过。
- A模型与额度各1次仍403/HTML/6639/SIN，未观察到修复；回退该请求改动，保留诊断能力。不能据此排除所有头或证明具体WAF规则。
- 连同此前tail下的1次模型，本组累计5次资源读取+1次生成；读取预算余1。报告位于忽略目录output/phase02/probe-*-2026-09-07T03-*.json（只含白名单元数据）。
- 下一步：对6639字节且无title的响应增加编码/固定模板标记诊断，读取1次。需要新证据支持才能增加对照预算。

- B0纯诊断部署fe8c3c67-15d6-43b5-aecc-deb3209ae79b：已恢复原GET头。第6次读取模型仍403，但bodyFormat=html_text，无contentEncoding、固定blocked标记或title；压缩体误识别假设未获支持。
- 追加独立候选B预算：最多1次模型目录读取，0生成。依据：已确认是真HTML，三资源同类失败，且业务User-Agent明确含Workers运行环境；仅替换为诚实OneAPI身份以检验字符串画像影响，其他字段维持原始基线。失败则回退，不循环尝试伪装浏览器/官方二进制。

- 候选B部署bf8774f8-686a-47fa-82e6-742948016f32：仅诚实User-Agent变更；追加1次目录仍403/HTML/6639/html_text/SIN。回退B。累计7次资源读取、1次生成，无自动重试；不再盲试头组合。

## 当前结论与恢复条件

已证实上游chatgpt.com的Cloudflare响应持续拒绝三类资源，管理鉴权成功；未返回可确认的业务权限或重新登录错误。无法确认具体WAF规则、IP信誉、Worker provenance或地区哪项是根因；不能把修改失败写成纯Worker已修复。已测试的GET实体头和诚实UA调整均无改善，压缩体误分类未获支持。

纯Worker上游可用仍为阻碍。继续需要新的可验证入口，例如向上游/Cloudflare提交本记录的时间、路径与CF Ray核查拒绝规则；或采用用户现已授权的临时Node出站对照（由[EGRESS-001](../tasks/EGRESS-001.md)承接，已获同凭据Node目录/额度/生成成功证据并关闭临时链路）。现有本地Node成功证据仍按原基线有效，不能假设云端同一token已做Node对照。

平台边界依据：[CF-Worker自动来源标记与WAF阶段](https://developers.cloudflare.com/fundamentals/reference/http-headers/)、[Workers node:http包装fetch](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/)、[TCP sockets不支持Cloudflare IP目标](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。这些文档限制调整空间，不证明本次具体拒绝规则。

## 最终交付与检查点

- 当前线上版本：97efa97b-f5ec-4daf-bd1b-8e4f39b9fbc0，oneapi/api.arcinks.com。保留管理员专用脱敏诊断和probe；A/B请求实验均已回退，constants无diff；没有变更DO身份、加密Secret、OAuth连接、域名和其他Worker。
- 本地最终：typecheck通过；npm test 68/68；probe隔离fixture 4/4；build:worker通过；实际Secret扫描123文件0匹配；git diff --check通过。
- 线上最终管理冒烟（2026-09-07T04:06:41Z）：管理员登录、CSRF拒绝、普通key不可进入管理均通过；connected=true、reauthenticationRequired=false、Access关闭。测试key已撤销、测试会话已退出；该冒烟0上游调用、0生成、0重试。
- 风险R1诊断元数据沿用现有管理员权限，普通/v1无新增字段，当前会话已diff自查；未要求独立R2审查。回归通过只证明诊断与管理行为，不构成模型/额度/生成验收。
- 源代码基线HEAD=efd57b9 + 本任务工作区diff；本轮未推送GitHub。历史部署前R2审查仅适用于原部署鉴权/迁移契约，不能扩写成此次上游验收通过。
- 后续从本记录恢复，不重开导入Secret、不重置账号。若获新上游规则证据或批准出站架构调整，再登记假设/范围和测试预算。

后续证据：EGRESS-001于2026-09-07完成同一云端token对照，Worker目录/额度403，Node路径目录/额度200且gpt-5.5生成成功。可排除这次云端token本身/对应资源权限导致失败，剩余出口/运行时/平台特征未逐项区分。详见[任务](../tasks/EGRESS-001.md)，不扩写为纯Worker已修复。
