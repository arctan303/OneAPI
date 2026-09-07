# CONSOLE-NET-001 验证记录

基线：ccc04a2b 之后本地工作区，2026-09-07；以下记录为发布前实施验收，后续已随 v0.2.0-dev.2 发布，见 [RELEASE-003](RELEASE-003.md)。任务外 .codex/evolution/signals.md 未纳入成果。网络第一批和 UI 第二批已实现并验收；第三批首审发现的回环判定与自动发现地址超限问题已修复，一次聚焦复核通过；本地新版已启动。

## 第一批：网络与配置

- 新增网络矩阵 4/4；原生 runtime + 网络 13/13；既有 HTTP fixture 5/5（Sol 实施代理报告，相关文件 test/server-network.node.spec.ts 与 test/server-runtime.node.spec.ts）。覆盖精确私网 origin、参数优先级、HTTP/HTTPS scheme、跨站拒绝、真实 peer 校验、LAN 登录/注销和公网来源伪造拒绝。
- 主会话 npm test：Worker 8 文件 84/84 通过，证明共享 gateway/account 变更没有破坏这组既有行为。全为 Mock，不代表纯 Worker 上游 403 修复。
- typecheck：补齐 config.d.mts 与新测试类型后通过。早期测试半成品的类型失败已由实施代理修正，生产类型契约保持一致。
- npm run build:server：成功，当次 bundle 261015 bytes，runtimePackages=0。后续向导权限调整及 UI 完成后须再构建。
- node --test scripts/test-server-artifact.mjs：1/1，manifest 文件复制到独立临时目录，无 npm install 启动；oneapi/configure 的 --help 无密钥且不创建 DATA_DIR；--port 18793 覆盖环境 PORT 18794。
- node --test scripts/test-configure-server.mjs：当前 8 通过/1 跳过。Windows 文件 symlink 创建因 EPERM 跳过；Windows 目录 junction 路径拒绝实际通过。验证四字段更新、保留秘密/注释/data路径、非法输入失败不覆盖、并发编辑保留、重复网络字段/多行配置拒绝。
- Windows 受保护 ACL 用例先失败，证明直接复用读取的 FileSecurity 没有持久化修改；已改为在空临时文件上设置新描述符的 Access/Owner/Group 再写配置，通过保存前后 SDDL 相等验证。使用系统自带 Windows PowerShell/.NET，不依赖 PS 模块搜索路径，不复制需系统特权的审计 ACL。POSIX mode/owner 保留代码需 Linux 实机补测。
- 主会话额外合成断言：help 不依赖密钥、运行参数不改变输入环境、fd12 域名与 fd::1/fc::1 短 IPv6 不会被错判为 ULA；标准 80 端口输出 canonical origin。

在真实启动前的恢复检查中，8787 无监听，原 .env 与账号数据库仍存在；最终启动证据见下文。无真实模型请求、账号迁移、CF/DNS变更。

## 第二批：后台分区

使用 scripts/console-fixture.mjs 原生 Node Mock + 临时 SQLite，在 Playwright 专用会话验收，无真实 .env 或上游调用。桌面1440x1000、手机390x844：登录居中与26px标题、单一可见区域、六导航aria-current、无效hash回退、浏览器前后退/刷新、草稿保留、切页不新增模型/额度请求通过。新建key可列模型并指定high调用Mock，key到日志UUID筛选正确。手机日志无页面横向溢出；slow Mock流切页继续、返回完成、退出清created-key/transcript/user-code/log-detail-bodies与隐藏导航通过。

首轮浏览器脚本URL全局不可用已修脚本；日志筛选断言错误假设标签保留名称，实际标签显示UUID且筛选正确，已按DOM与日志结果确认。实际发现并修复：标题旧CSS覆盖30px、直接进入logs未自动读取、手机UUID挤压标题。聚焦浏览器验证：桌面标题实算30px，直接导航/刷新logs/key到logs每次仅1次本地日志读取；390px日志标题和UUID纵向排列且页面无横向溢出。截图/验证脚本位于 output/playwright/。

## 第三批：复核与交付

fresh R2 首审覆盖本次网络/会话/配置秘密保存及 UI 退出清理，发现两个可复现问题。回环全链路判定与自动发现 origin 保存前限额均已修复，新增失败回归及一次聚焦复核通过；详见 [独立复核](CONSOLE-NET-001-review.md)。

最终构建（UI聚焦修复后）：bundle 261015 bytes，总payload 396928 bytes，runtimePackages=0；独立产物1/1。实际配置密钥内存比对：203个当前源码文件+14个manifest产物，9个配置值，0命中；任务外evolution信号未纳入扫描成果。浏览器控制台仅浏览器建议添加username的verbose提示，无应用异常。

聚焦修复后（reviewer 已关闭两项问题）：网络/runtime 15/15，向导9通过/1既有symlink权限跳过，typecheck通过；127.0.0.2 health、登录、会话、退出实际回归及33网卡保存失败不覆盖通过。主会话重跑共享Worker84/84、HTTP fixture5/5；重新构建bundle261174 bytes / payload397981 bytes / runtimePackages0，独立manifest产物启动1/1。最新密钥扫描204源码+14产物，5个去重配置秘密值，0命中（本次按变量名含 KEY/TOKEN/SECRET/PASSWORD 且长度至少16筛选并去重）。原子保存和UI证据未因本次聚焦修改失效。

最终本地启动：主会话以原 .env 启动 dist/server/oneapi.mjs，PID24796，地址 http://127.0.0.1:8787/。只读回读health/status/key目录与三个静态资源：health=true、connected=true、reauthenticationRequired=false、keyCount=1、assetsMatch=true；.env的启动前后SHA256一致。没有真实模型或额度请求。隔离Mock进程与专用浏览器已关闭。证据在忽略目录output/server-live/post-start.json及console-v2日志；截图在output/playwright/。当时构建在dist/server，尚未发布；随后已由RELEASE-003完成新版本发布，没有覆盖旧版发布归档。
