# RELEASE-003：v0.2.0-dev.2 测试版发布

日期：2026-09-07。用户明确授权“这一个版本可以作为下一个测试版发布”。目标为将已验收的 CONSOLE-NET-001 提交并推送至 arctan303/OneAPI，创建新标签与 GitHub prerelease，提供独立安装包和 SHA-256。保持仓库私有及旧标签、旧附件不变；不修改现有 Worker、DNS、账号或运行配置。

## 范围、风险与门禁

包含六区后台、居中登录页、CLI 监听参数、可选持久化网络向导、私网访问边界及安装教程。功能代码复用 [CONSOLE-NET-001 验证](CONSOLE-NET-001.md) 与 [fresh R2 首审及聚焦通过](CONSOLE-NET-001-review.md)，不重复消费真实上游配额。本轮仅调整版本元数据和发布说明，按 R0/R1 发布准备验证，不改变已审查的鉴权代码。维护队列当前为空。

任务外 `.codex/evolution/signals.md` 保留在工作区，不纳入提交。实际 .env、.dev.vars、SQLite、日志和浏览器截图不进入仓库或安装包；截图和测试仅使用合成账号。源码 index 使用现有 audit-release-source.mjs 审计，包按 manifest 检查秘密、文件清单与哈希。

## 安装与恢复

根 package.json、锁文件根版本、包 package.json、manifest、归档名统一为 0.2.0-dev.2。Node.js 24.x >=24.15 且 <25；bundle 不需要 npm install。INSTALL.md、NETWORK.md、setup.mjs、configure.mjs 随包提供。

先停止旧服务并备份原环境文件和数据库，在独立 release 目录解包，复用原密钥与发布目录之外的绝对 DATA_DIR，再启动。已有原生 Node 账号无需重新迁移。本版未新增数据迁移；回滚到 v0.2.0-dev.1 时移除该旧版不支持的新增启动参数，恢复原网络配置后使用同一外置数据，避免并发打开数据库。首次安装必须生成自己的配置并完成账号授权。

## 验证与状态

实施与安装验证通过；Git index 敏感信息检查通过（206文件、9项实际配置值比对、发现0），diff --check通过；推送、预发布及远端回读均已完成。npm run build:server 构建成功，bundle261174 bytes、payload398424 bytes、0外部npm运行依赖；npm run package:server 输出15文件归档101441 bytes，实际配置9项内存比对0命中。npm run test:release 实际压缩包新安装1/1、独立manifest产物1/1通过，均在临时目录使用新生成的合成配置，确认不含已有账号和用户key。沿用同一生产代码的网络/runtime15/15、向导9通过/1跳过、Worker84/84、HTTP5/5、typecheck与UI浏览器验收和独立复核。

附件：oneapi-server-0.2.0-dev.2.tar.gz；SHA-256：`2fff3cdf37087f240e4ca9468a12c5b474c34cce0153b337b5e7111153d69663`。Windows 文件 symlink 测试因 EPERM 跳过；目录 junction/ACL 已通过，Linux mode/owner、真实第二台 LAN 设备及公网部署仍没有本轮实机证据。这些限制已在功能审查中披露。

发布顺序：提交已验证文件，原子推送 main 和新标签，创建草稿并上传安装包/校验和，回下载逐个核对 SHA-256 后发布为 prerelease。仓库保持私有，试用者须有读取权限或由所有者转发附件。

## 实际发布回读

发布提交 `1b85beddb349222d450b7148d7c66bd8d03a484d`，新标签 `v0.2.0-dev.2`；通过 HTTPS 原子推送 main 与新标签。GitHub API 确认 main 与新标签均指向该提交，旧 v0.2.0-dev.1 仍指向 `a4d4587e28f5ba243e86f03b72814c154ac650c7`。一次 Git HTTPS 回读遇到 schannel TLS 握手失败，已改用 GitHub API 核对相同 refs，未 force 或移动旧标签。

发布于 `2026-09-07T10:58:10Z`，`isDraft=false`、`isPrerelease=true`；地址：[v0.2.0-dev.2](https://github.com/arctan303/OneAPI/releases/tag/v0.2.0-dev.2)。安装包101441 bytes、SHA-256文件99 bytes，两项均为uploaded；草稿回下载逐文件哈希一致，正式发布后再次读取的下载URL均含正确版本路径。最终发布前index审计206文件/1423057 bytes、9项配置值比对、0发现。

发布后本地8787只读验证：health=true、connected=true、reauthenticationRequired=false、keyCount=1、assetsMatch=true，原.env哈希保持不变。未重启或重新登录，不消耗上游模型调用。任务外.codex/evolution/signals.md保留未提交。此后仅提交本发布回执与当前计划文档，不移动测试版标签。
