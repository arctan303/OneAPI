# AUTH-001：单管理员登录和 API 密钥管理

日期：2026-09-06。产品变更，短任务；依据 DEC-007/008、REQ-05/08。实施：完成；验证：修复前全量 Mock 23/23、SDK/build 通过，最终鉴权 7/7、typecheck 与针对性浏览器回归通过；独立审查：聚焦复核通过，无剩余 P0/P1/P2；发布：未部署。

## 目标与范围

管理员登录一次，即可连接 Codex、测试模型和管理 API 密钥；复制 API key + `/v1` Base URL 即可在第三方使用。不做多用户/角色/权限选项/注册/找回密码，不部署 Cloudflare Access，不修改上游协议或解决 403。

用户确定的是单管理员全部后台操作与密钥管理。以下为方案负责人选择的本地实施默认值，不冒充用户逐项指定：

- `POST /admin/session` 验证现有 `ADMIN_API_KEY`（页面称管理员口令），返回 7 天会话 Cookie；`GET /admin/session` 仅返回认证状态/到期；`DELETE /admin/session` 消费并验证 `{}` 请求体后撤销并清 Cookie；非空对象或非法 JSON 返回 400，保持原会话。随机会话只存哈希与必要元数据，数量有上限，失败登录有限频率。
- HttpOnly、SameSite，HTTPS 带 Secure；HTTP 仅限原 loopback 模式。Cookie 管理请求与模型测试必须精确同源（协议、主机、端口），拒绝跨站及不可信 Origin；变更请求限制 JSON、缺少 Origin 不能用 Cookie 越过门禁。旧管理员 Bearer 自动化无 Origin 继续兼容。
- 管理员会话可执行全部后台能力，包括内置模型测试（如 `/admin/test/models`、`/admin/test/responses`）。页面不再要求调用密钥。`/v1` 第三方继续用 Bearer API key，不接受任意 Cookie 或伪造 CF 头提权。
- 创建命名 API key（`POST /admin/api-keys`），显示完整 key 一次；列表只返回 ID、名称、掩码/时间；可撤销（`DELETE /admin/api-keys/:id`）。使用至少 32 字节服务端随机熵，只存哈希，不把明文放日志、URL、列表或 localStorage。数量有界，不做每 key 的权限管理。
- 新 API key 支持已有 `/v1/models`、Responses、Chat，旧 `GATEWAY_API_KEY` 为兼容入口保留，不能进入管理接口。撤销阻止之后的新请求；已鉴权的在途生成按现有生命周期结束。
- 退出后台与断开 Codex 区分；前者只撤销当前会话。新会话/密钥存储与 OAuth 数据隔离，不迁移、删除或重置现有 OAuth 数据；重启可恢复有效会话/密钥。

## 风险与验证

R2：增加 Cookie 管理员授权与可创建的调用凭据 → 跨站请求或错误权限判断可能控制账户/消耗订阅 → 必须覆盖下列行为并由 fresh reviewer 独立审查。

1. 正确/错误登录、有限失败频率、会话持久化/到期/退出/旧 Cookie 拒绝；退出不影响 OAuth 连接或 API keys。
2. 未登录、跨站（包括另一 localhost 端口、Origin:null）、Cookie 变更缺 Origin、伪造 CF 身份头、API key 提权均失败；管理员无需额外 key 可管理/内置测试。
3. key 创建与元数据列表不泄漏、撤销生效/重启保存；标准 SDK 使用新 key 普通/流式 Mock 成功，旧 key SDK 回归。
4. 类型检查、相关行为 tests、SDK 兼容、dry-run build；页面登录/刷新/创建复制/撤销/退出做浏览器或等效行为验证。

全部使用隔离 Mock 与测试凭据，不请求真实上游，不读取既有 `.dev.vars`/`.wrangler` 或 Codex/OpenCode 凭据。保留原 8787 Demo，允许代码热重载，不主动重启/断开账户。

## 实施与恢复

实现由 `gpt-5.6-sol` + `high` 执行；主会话维护契约/核验；完成后同模型 fresh reviewer 独立审查。沿用现有锁文件、DO 和原生页面，不引入账户框架。

原始只读快照：`C:\Users\30330\AppData\Local\Temp\oneapi-auth001-baseline-df34ac0e144e4b479a41bfbe2684263d`，包含 src/public/test/scripts 与非秘密配置。无 `.git`；快照供差异审查，回滚只恢复本任务相关改动并停止接受新会话/密钥，不删除 OAuth 存储或整体覆盖他人文件。

实施证据见 [AUTH-001-implementation](../verification/AUTH-001-implementation.md)。原 8787 的 `/health` 为 true，静态页面已包含管理员登录与创建 API 密钥，原 PID `25116` 仍存在；没有通过该实例进行真实账户或模型操作。真实上游 403 仍沿用此前诊断结论，Mock 管理流程成功不能写成订阅可用。Cloudflare Access 与线上 API 路由只确定方向，留后续单独部署验收。
最终验证补充：同实例独立 reviewer 复核最终鉴权 7/7；浏览器旧 401 跨重登、新登录与旧恢复、当前 401 清理、退出后的迟到 key 响应、连续三轮登录退出均通过。早期 Mock 500 与 workerd 请求流异常、修正经过及因果证据限制见实施记录；不把失败的早期脚本当作通过。父会话已关闭自己的测试浏览器和 8791 Mock，原 8787 健康与 PID 25116 保留。
