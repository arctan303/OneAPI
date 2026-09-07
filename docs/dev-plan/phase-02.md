# Phase-02：Cloudflare Worker 部署与 Access 管理登录

状态：实施完成；本地验证与部署前R2审查通过；oneapi/api.arcinks.com已部署；云端新登录成功，但模型目录与额度仍403，端到端验收受阻。代码基线 `4294b99`，2026-09-07。

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

事实、版本、资源ID和限制见 [验证](../verification/PHASE-02.md)；[部署前审查](../verification/PHASE-02-review.md)结论仍适用，无新业务代码改动。当前阻碍是Worker资源请求上游403，根因未证实；Access真实SSO未验收。不能以管理后台上线替代上游可用。
