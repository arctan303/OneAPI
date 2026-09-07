# CONSOLE-NET-001：网络配置向导与管理后台分区

日期：2026-09-07。路线：产品变更；规模：短任务。基线：ccc04a2b（v0.2.0-dev.1 发布后文档）；保留 .codex/evolution/signals.md 的任务外修改。

## 目标、依据与范围

用户要求私网访问、方便切换监听地址与端口，并解决所有管理功能挤在一页的问题；先选择命令行配置向导，随后明确希望直接启动参数更简单；保留向导作为可选持久化方式。对应 REQ-18/19 与 DEC-015。

- 默认保持 127.0.0.1:8787。提供本机、可信局域网、HTTPS 反代/Tunnel 三种配置入口。
- HOST 为监听 IP 或 localhost，PORT 为合法端口；通配绑定地址不是访问地址。
- LAN_ORIGINS 为逗号分隔的精确 http/https origin，仅接受 RFC1918 IPv4 与 IPv6 ULA 字面量，可带合法端口；不接受任意主机名或公网地址。仅实际 loopback/私网 socket peer 能使用显式配置的 LAN origin；公网 peer 伪造 Host 或转发头不能获得此权限。
- 保留现有 PUBLIC_ORIGIN HTTPS 域名规则和管理员会话、Origin/CSRF、API key、Access JWT 验证。非回环监听要求有效 LAN_ORIGINS 或 PUBLIC_ORIGIN。
- 向导只原子更新 HOST、PORT、LAN_ORIGINS、PUBLIC_ORIGIN；保留账号密钥、DATA_DIR、其他配置及注释。不输出秘密、不自动重启；缺失配置先要求初始化，拒绝符号链接，失败保持原文件。提供帮助、隔离测试入口与实际访问地址。
- 登录页按用户补充要求居中、紧凑、字号统一可读；后台拆为概览、账号连接、模型测试、API 密钥、调用日志、设置六个 hash 导航区域；桌面侧栏，移动端紧凑导航。沿用现有业务接口与视觉语言。
- 导航保留表单草稿、对话与运行中的流；不会因切页自动增加官方模型/额度请求。日志可从 key 卡片带筛选进入。退出后清除敏感页面状态，未登录不显示管理导航。

非目标：不部署或修改 Cloudflare/DNS，不自动发布新版本，不改变上游出站、协议、账号存储或迁移，不增加网页配置网络的管理 API，不引入后台热重启。

## 依赖、执行与风险

依赖 SERVER-001 已完成的原生 Node 运行时、现有界面接口；无用户待决项。主会话维护契约、集成产物/教程并验收；按用户最新要求分批有序推进：第一批 Sol high 完成网络与 CLI 并验证；第二批 Sol high 完成 UI 与浏览器验收；最后统一复核、构建与文档闭环。Luna 已完成 Cloudflare 官方资料核查，不并行运行新任务。

网络边界 R2：允许新的来源与监听方式可能放宽认证入口或 CSRF 防护，需覆盖 peer/Host/Origin/转发头、会话、CLI 原子保密写入并 fresh reviewer 独立审查。布局通常 R1；退出秘密清理及登录可见性纳入边界复核。

## 验收与状态

1. 隔离 HTTP 行为矩阵：本机、显式私网、未配置私网、公网 peer、伪造 Host/Forwarded、跨站写和未授权管理请求。
2. CLI：帮助、合法/非法端口及地址、只改四字段、秘密与其他配置保留、失败不破坏原文件。
3. 浏览器：桌面及 390px 移动端布局、六区导航、刷新/历史/无效 hash、key 到日志筛选、草稿和流状态、退出秘密清理；使用隔离 fixture，不消耗真实模型请求。
4. 构建、针对性测试、类型检查与 diff 自查；必要时覆盖共享 gateway 的旧 Worker 回归；R2 独立审查完成后再重启已验证为本仓库的本地服务。
5. 源码和独立部署包都包含向导，安装文档明确保存后重启、LAN HTTP 信任边界、Tunnel/公网反代配置差异。

实施：网络、启动参数、向导与六区后台完成。验证：网络/runtime15/15、HTTP5/5、Worker84/84、typecheck、独立包1/1通过；向导9通过/1跳过（Windows文件symlink权限），目录junction拒绝与受保护ACL保持通过；桌面和手机浏览器验收通过。审查：fresh首审发现两项问题，实质修复及一次聚焦复核后通过，见[独立复核](../verification/CONSOLE-NET-001-review.md)。本地：新版已用原.env与数据库启动，127.0.0.1:8787健康、connected=true、reauthenticationRequired=false，现有1个key可读取，三个页面资源与构建一致，配置哈希未变。发布：用户已授权发布 v0.2.0-dev.2，进度与结果见 [RELEASE-003](../verification/RELEASE-003.md)；不涉及线上Worker变化。

启动参数补充（用户随后明确）：支持 --host、--port、--lan、--public-origin、--help；启动参数覆盖环境配置，只影响本次进程，不修改文件。--lan 根据具体私网绑定 IP 或通配绑定时本机当前网卡的 RFC1918/ULA 地址生成精确 LAN_ORIGINS，启动输出可访问地址；不接受任意 Host。命令行参数校验先于打开数据库。公网直连使用 HTTPS 终止反代，Cloudflare Tunnel 与传统反代均为支持的安装拓扑，不要求使用 Cloudflare。
