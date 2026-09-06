# ARCHIVE-001：首版源代码归档

日期：2026-09-07。用户明确提供 git@github.com:arctan303/OneAPI.git 并要求第一版提交存档，授权 commit/push。范围仅当前已验证本地版本；不包括下一版需求实现或 Cloudflare 部署。

目标：main 分支、v0.1.0 标签。执行前 git ls-remote 成功且没有远端引用；本地此前没有 .git，已初始化独立仓库。身份沿用用户已有 Git 配置。

## 发布准备证据

- 业务代码没有改变；关键 runtime/account/collector 哈希与 LIVE-001 最终验证基线一致。
- 复用仍适用的全量 Mock 26/26、Node 运行器隔离检查、typecheck、Wrangler dry-run 与真实 SDK/浏览器证据，见 [LIVE-001](LIVE-001.md) 和[独立审查](LIVE-001-review.md)。没有为源代码归档重复消费真实模型调用。
- 初次暂存 94 个文本文件、623576 字节；程序在内存中对照本项目 3 个真实配置秘密并扫描 staged blobs，真实秘密命中 0，私钥/provider token/JWT 字面量命中 0，二进制 0。审计输出仅名称和计数。后续新增归档说明同样复查。
- .dev.vars、.wrangler、output、临时测试存储、日志、node_modules、dist、本机 .codex/config.toml 与 Python 缓存全部忽略；不删除本机数据。保留的 .dev.vars.test/test/mock.env 为公开测试配置，不含真实配置值。
- 源文件 CRLF/LF 由当前 Git 配置处理，未改业务语义。历史 Markdown 的两个空格换行保留，不将其视为代码错误。
- GitHub 根 README 提供 npm ci/setup/dev:node 和账号初始化说明；真实账号/OAuth状态不随仓库迁移。截图引用是本机历史证据，图片本身未归档。

## 回读与恢复

推送后必须比较远端 refs/heads/main 与本地 HEAD、远端 refs/tags/v0.1.0 与本地标签。推送与回读结果在本次任务回复中提供；该记录不预先冒充远端成功。

后续版本从此基线继续开发；回看首版使用 v0.1.0，不能通过删除本机 .wrangler 存储来回滚代码。扩展需求仍在讨论，第一版不会偷偷加入账号用量、日志存储或 key 权限变更。
