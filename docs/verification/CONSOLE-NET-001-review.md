# CONSOLE-NET-001 独立复核

日期：2026-09-07。审查类型：fresh R2 reviewer 首审及一次聚焦复核。

当前结论：**通过。** 首审两个问题均有实质修复和失败回归，聚焦复核已关闭；首审不通过记录保留在下文。

## 范围与基线

相对 `ccc04a2b` 检查当前未提交工作区中的 `CONSOLE-NET-001` 生产代码、新增文件、有效契约与验证记录；排除任务外 `.codex/evolution/signals.md`。审查期间生产代码冻结，未读取真实 `.env`、账号或密钥，未启动真实账号服务，所有新增探针只使用合成配置并已清理。

有效契约为 `docs/tasks/CONSOLE-NET-001.md`、`docs/Product-Spec.md` 的 DEC-015/REQ-18/REQ-19、`docs/Design-Brief.md` 与 `docs/NETWORK.md`；证据基线为 `docs/verification/CONSOLE-NET-001.md` 及当前冻结实现。

## 风险及依据

R2。新增监听地址和 LAN origin 会扩大管理登录与 API 的网络入口，错误的 Host、Origin、socket peer 或内部信任传递可能绕过认证/CSRF 边界；配置向导原子替换含真实 secret 的环境文件，错误可能泄露、破坏秘密或改变文件权限。后台布局本身为 R1，退出后的秘密清理纳入本次 R2 边界。

## 首审结论

**不通过。** 未发现客户端伪造 header 获得 `trustedLanHttp`、公网 peer 冒充 LAN、跨站管理写放行或配置输出 secret 的证据，但存在两个可复现的一致性问题。修复后应针对这两个问题及相邻登录/配置回归做一次聚焦复核。

## 首审问题

### 1. 中：配置接受并公布整个 127/8，gateway 和会话 cookie 却只接受 127.0.0.1

证据：`server/network-config.mjs:15-20,39-40` 将任意 `127.x.x.x` 判为 loopback；`server/config.mjs:104-112` 因此允许 `--host 127.0.0.2` 且把 `http://127.0.0.2:9090` 放入 `accessUrls`。但 `src/gateway.ts:11-12,42-43` 只把 `127.0.0.1` 识别为 loopback，`src/account-core.ts:236-240` 的 HTTP 会话 cookie 判断也只接受 `127.0.0.1`。独立合成探针确认：相同解析结果与 loopback socket peer 进入 gateway 后，`GET /health` 返回 403，预期为 200。

具体后果：一个被 CLI 校验接受、启动日志明确公布的本机地址实际不可访问；若只修 gateway，`POST /admin/session` 仍会在 `sessionCookie` 返回 `secure_session_required`，后台登录继续失败。

修复方向：让配置、HTTP adapter、gateway 和 `sessionCookie` 复用同一 loopback 地址判定；或者在配置入口明确拒绝不支持的回环形式。补充至少覆盖非 `.1` 的 127/8 地址的 `/health` 和管理员登录/退出行为测试；若继续接受 IPv4-mapped IPv6 host，也应覆盖其规范化形式。

### 2. 低：LAN 自动发现可生成超过自身上限的配置，向导仍报告保存成功

证据：`server/config.mjs:63-76` 对发现结果去重后直接返回，`server/config.mjs:104-105` 在 `--lan` 路径没有再次调用 `parseLanOrigins`；而 `server/network-config.mjs:56-60` 明确拒绝超过 32 个 origin。独立临时目录探针使用 33 个合成 RFC1918 网卡地址时，`configureEnv` 返回 `network_config_saved` 并写入 33 个 origin；对保存值执行运行时同一解析器随即得到 `LAN_ORIGINS accepts at most 32 origins`。

具体后果：具有大量虚拟网卡或别名地址的主机会在向导显示保存成功后写出无法启动的 `.env`；直接 `--lan` 启动也会在后续 runtime 校验失败，错误位置与配置解析结果自相矛盾。向导虽保留了 secret，仍违反“保存的是可启动有效配置”的原子配置预期。

修复方向：自动发现结果在返回或替换文件前必须经过与手工 `LAN_ORIGINS` 完全相同的数量和长度校验；超限时明确失败且不替换原文件，或用有契约依据的选择规则产生不超过上限的地址集合。补充 33 个唯一私网地址的 CLI 与向导失败不覆盖回归。

## 首审验收覆盖与文档核对

- fresh 重跑 Node 网络与 runtime：2 文件、13/13 通过；覆盖精确 LAN authority、真实 socket peer、Origin/CSRF、LAN 登录/退出及公网 peer/转发头拒绝。
- fresh 重跑配置向导：8 通过、1 跳过；四字段保存、secret/注释/DATA_DIR 保留、失败不替换、并发修改保护、父目录 junction 拒绝和 Windows 受保护 ACL 保持通过。文件 symlink 用例因当前 Windows 创建权限 EPERM 跳过。
- fresh 重跑 `npm run typecheck` 通过；内部 `trustedLanHttp` 类型从 gateway 经 Node runtime 传入 AccountService，客户端请求 header 没有映射到该上下文。HTTP adapter 同时移除 Forwarded/X-Forwarded 和已有内部 bridge headers。
- UI 源码与已有 Playwright Mock 证据一致：六个 hash 区域、直接进入日志只触发一次读取、草稿/对话/流切页保留；`showLogin` 使进行中请求失效并清除 created key、模型、对话、授权代码、key 列表、日志列表和日志正文，隐藏管理导航。浏览器证据不涉及真实上游。
- 已有冻结基线证据仍适用：Worker 84/84、HTTP fixture 5/5、最终构建 bundle 261015 bytes / payload 396928 bytes / runtimePackages 0、独立产物 1/1、真实配置值只在内存比较且源码与产物 0 命中。复核未输出这些值。
- Product Spec、任务契约、Design Brief 与 NETWORK 教程对新增能力和信任边界基本一致。`docs/verification/CONSOLE-NET-001.md:3,26` 仍写 UI 进行中和第三批待开始，`docs/DEV-PLAN.md:11` 仍写本地 8787 正在运行，而复核时只读检查已确认该服务不存在；聚焦复核收尾时需按实际状态修订，不能把本次不通过写成审查完成通过。

## 首审关闭、剩余问题与新增证据

本轮没有可关闭问题；剩余问题为上述两项。新增证据是 127.0.0.2 配置成功但 gateway 返回 403 的失败探针，以及 33 个自动发现 origin 保存成功但同一运行时解析器拒绝的失败探针。两项均使用合成 secret，临时文件已清理。

## 首审残余缺口和恢复条件

未在 Linux 实机验证 POSIX mode/owner 保留；当前 Windows 无权创建文件 symlink，只有目录 junction 拒绝和 Windows Access/Owner/Group ACL 保持得到实际验证；未用真实上游、真实公网反代或真实 LAN 第二台设备做请求。它们是环境覆盖缺口，没有推翻已验证的 Host/Origin/peer 逻辑，也不能替代两个失败探针的修复。

恢复条件：生产代码实质修复两个问题并加入相应失败回归后，基于新 diff 运行一次聚焦 reviewer；重跑受影响的网络/runtime、配置向导与类型检查，并更新任务、验证和 DEV-PLAN 的实际状态。聚焦通过前不应把本轮标为完成或据此启动真实账号服务。

## 聚焦复核

范围仍为相对 `ccc04a2b` 的当前冻结工作区，只检查首审两个问题的修复及紧邻 Host、会话、LAN 防伪造和配置原子回归。审查期间未启动真实账号服务、未读取真实 `.env` 或真实密钥、未修改生产代码。

结论：**通过。** 两个首审问题均关闭，没有新增可执行问题。

### 问题 1：已关闭

`server/network-config.mjs:10-28` 现在统一去除 IPv6 方括号、规范化完整 IPv6，并把 IPv4-mapped IPv6 转回点分 IPv4；`server/http.mjs:25`、`src/gateway.ts:39-40` 与 `src/account-core.ts:237-240` 都复用共享的 loopback 判定。`server/config.mjs:110-113` 也用同一规范化结果生成合法的 canonical `accessUrls`。

新增行为回归实际绑定 `127.0.0.2`，依次验证 `/health`、管理员登录、会话查询和退出，包含非 Secure loopback cookie 与清除 cookie，均通过；另覆盖 `::1` 完整写法、带方括号和 IPv4-mapped 形式的判定及访问 URL 规范化。原有 LAN 精确 origin、公网 peer 与转发头伪造拒绝仍通过，因此修复没有把扩展回环判定误放宽到普通私网或公网地址。

### 问题 2：已关闭

`server/config.mjs:63-76` 现在把自动发现结果交回 `parseLanOrigins`，与手工配置共用 32 项及 4096 字符上限。新增 CLI 配置解析回归确认 33 个唯一 RFC1918 地址立即拒绝；新增向导回归确认相同输入在替换前失败，原 `.env` 逐字保持且不留下临时文件。`docs/NETWORK.md` 已写明两种入口共用的限制和超限处理。

### 聚焦证据与当前状态

- reviewer 独立重跑网络与 Node runtime：2 文件、15/15 通过。
- reviewer 独立重跑配置向导：9 通过、1 跳过；跳过项仍是当前 Windows 无权创建文件 symlink，目录 junction 与受保护 ACL 用例通过。
- reviewer 独立重跑 `npm run typecheck`：通过。
- 主会话在同一冻结修复后补跑 Worker 84/84、HTTP fixture 5/5；最终构建为 bundle 261174 bytes、payload 397981 bytes、runtimePackages 0，独立 manifest 产物 1/1，`diff --check` 通过。
- 主会话按名称含 KEY/TOKEN/SECRET/PASSWORD 且值长度至少 16 的口径筛选并去重配置值，对 204 个源码文件和 14 个 manifest 产物以内存方式比较 5 个值，0 命中；复核未读取或输出这些值。
- `docs/verification/CONSOLE-NET-001.md` 和 `docs/DEV-PLAN.md` 已修正首审状态及 8787 无监听的事实。主会话仍需在交付闭环时把状态更新为聚焦复核通过及最终验证完成。

### 剩余缺口

POSIX mode/owner 保留仍缺 Linux 实机证据；当前 Windows 文件 symlink 创建测试仍因 EPERM 跳过；没有真实公网反代、真实 LAN 第二台设备或真实上游请求。本次修复没有改变这些既有缺口，其余 Windows ACL、junction、Host/Origin/peer、会话及原子失败路径已有对应证据。它们不阻止本次两个 finding 关闭。

本节文字由独立 reviewer 给出；因其 apply_patch 连续 helper_unknown_error，由主会话原样代写，未改变审查判断。
