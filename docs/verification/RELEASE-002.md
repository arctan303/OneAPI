# RELEASE-002：v0.2.0-dev.1 开发版发布

日期：2026-09-07。用户明确要求“作为下一个开发版本推送发版”，并补充新安装教程供他人试用；授权提交当前相关源码、推送 main/新标签、创建 GitHub 预发布与上传安装包。目标仓库 `arctan303/OneAPI`，保持私有可见性，保留 `v0.1.0`。

## 范围和门禁

发布单服务器主路线及此前未推送的相关功能/诊断历史，包含完整安装教程、生产包、SHA-256 和版本说明。不提交本机 `.env`/`.dev.vars*`、账号 SQLite、日志、输出或个人工作流信号修改，不修改现有云端 Worker、DNS 或正在运行的本地账号。

复用 [SERVER-001](SERVER-001.md) 的真实模型/额度/两协议/日志验收与 [独立复核](SERVER-001-review.md)，不为发布再消费账号配额。本次变更为版本来源、打包、安装文档和相关声明；旧诊断队列按发布授权聚焦复查，结果见 [RELEASE-002-review](RELEASE-002-review.md)。

发布前发现并修复新增 SDK 测试缺少 `server/http.mjs` 类型声明，补 `server/http.d.mts` 后 typecheck 通过。诊断脚本的 usage 输出脱敏问题单独修复和聚焦复核，不能以旧测试通过代替修复。

## 构建与安装验收

版本由根 package.json 的 `0.2.0-dev.1` 同步到 bundle package.json、manifest 和归档文件名。`npm run build:server` 构建，`npm run package:server` 校验文件清单/哈希/秘密并打包。

新 [安装教程](../INSTALL.md) 随包发布为 `INSTALL.md`，覆盖私有仓库下载/所有者转发、校验和、Node 24.x、setup/启动、首次授权/key/模型、SSH、HTTPS/Access、备份升级和旧库迁移。附件无需 npm install；每个安装者生成自己的配置与账号授权。

验证入口：`npm run typecheck`、`npm run test:server`、构建后的 `npm run test:server:fixtures`、打包后的 `npm run test:release`。最后一项从实际 tar.gz 解压到独立临时目录，执行 setup 两次确保不覆盖配置，用生成的管理员口令登录，检查没有已有账号或用户创建的 key（仅出现 setup 新生成的 legacy gateway key），不访问真实上游。

## 敏感信息与发布核对

`scripts/audit-release-source.mjs` 检查 Git index 全部 blobs，内存比较本机实际配置秘密，检查凭据字面量、私有运行文件及二进制；只输出命中文件名与计数。`scripts/package-server.mjs` 对发布包执行固定清单/manifest/秘密检查，真实账号和日志不属于清单。

GitHub SSH 22 端口不可用，使用现有 gh keyring 登录，通过 HTTPS 推送，不把 token 写入 remote URL 或终端。推送采用 fast-forward/原子 main + 新标签，不 force、不移动首版标签。发布先上传草稿附件、回下载核验 SHA-256，再发布为 prerelease。

## 当前状态

实施/验证/审查：通过。typecheck、原生9/9、HTTP/迁移/产物/清理11/11、实际压缩包首次安装1/1、WORKER诊断4/4、PURE-WORKER诊断8/8；发布审查问题修复并聚焦通过，维护队列已清空。推送/预发布/远端资产回读：完成。

Linux systemd/Caddy 与第三方服务器出口仍待各安装者验证，不能把本机安装测试写成已完成 Linux 远端部署。仓库为私有，测试者需要读取权限或由所有者转发两个发布附件。

发布候选：`dist/oneapi-server-0.2.0-dev.1.tar.gz`，87087 bytes，SHA-256 `6b4d65e174423d58a19533c61cc7ba74baba00794a1fe007c755c1b875d314a5`；13文件（含INSTALL与manifest），0外部npm运行依赖。主程序253341 bytes、manifest内容352256 bytes。Git index初筛192文件/1324341 bytes，对照9项实际配置，发现0；包秘密扫描发现0。最终提交前再次扫描修订后的文档。

## 实际发布回读

发布于 `2026-09-07T08:24:42Z`，版本 `v0.2.0-dev.1`，GitHub `isDraft:false / isPrerelease:true`。地址：https://github.com/arctan303/OneAPI/releases/tag/v0.2.0-dev.1 。

发布提交 `a4d4587e28f5ba243e86f03b72814c154ac650c7`；远端main与新标签剥离后均指向该提交，旧v0.1.0仍指向54631e09bfc4f4ab9bd9ad061cfebc5bf70cdc49。后续仅追加本发布回执文档提交到main，不移动预发布标签。

两个GitHub附件均为uploaded：安装包87087 bytes、SHA-256文件99 bytes；从草稿回下载逐个比较SHA-256均一致，包哈希为本文件上述6b4d65e...314a5。正式发布后再次读取两个下载URL，均使用正确v0.2.0-dev.1路径。最终index审计192文件/1323767 bytes、9项实际配置对照、发现0。

本地8787 health仍为200；未修改云端Worker/域名/账号。个人.codex/evolution/signals.md修改保留在本机未纳入本次提交。维护队列已清空。
