# RELEASE-004：v0.2.0-dev.3 开发版

日期：2026-09-07。用户明确授权“现在修复优化前后提到的问题，发版为下一个开发版”。已提交推送并发布v0.2.0-dev.3 prerelease；未更新远端Node。

## 范围与门禁

ACCESS-RETURN-001：有效Access JWT的精确回跳导航；ACCESS-ENTRY-001：根跳转/admin/login与/admin/后台，无额外CF按钮；SPARK-CATALOG-001：保留OAuth目录实际可选但API不支持的模型；PARAM-COMPAT-001：核对Codex原生请求参数，按用户最新收窄决定保持现有核心映射，仅增加输出限制/采样参数兼容忽略并基础日志显示未生效字段。

鉴权路径为R2，需要相关行为回归与fresh独立审查；参数公开兼容与日志字段需同步API矩阵、升级/旧库测试。先按用户分批实现，统一审查后构建最终包，使用实际压缩包执行隔离新安装与升级验证。真实生成只允许有限最短验证，不作重复负载测试。

## 发布与回滚约束

根package/锁文件、bundle包元数据/manifest/归档统一0.2.0-dev.3。保留v0.2.0-dev.2及更早标签/附件；新版本采用独立归档和SHA-256，草稿上传后回下载核验再发布prerelease。仓库保持private，用户试用需读取权限。

个人.codex/evolution/signals.md不属于本任务，保留且不提交。环境文件、真实账号/密钥、SQLite、日志与浏览器截图不进Git或安装包。使用既有index秘密审计和artifact manifest审计，日志只记录被忽略字段名。

升级停旧服务、备份外置数据和环境文件，使用同一原凭据与绝对DATA_DIR启动新版，不能两个进程同时打开相同数据库。日志摘要如有新增列，必须幂等兼容旧数据；不重新登录Codex、不重建库。回滚先停新版并使用旧二进制及升级前备份（若需要恢复原schema），会丢失备份之后新增日志，需先保留新版数据副本。具体证据实施后补齐。

## 状态与证据

全部代码与测试已冻结。最终包构建与隔离新装/升级通过，[fresh独立审查通过](RELEASE-004-review.md)，本地真实调用通过，已发布。公开源站Cloudflare策略与远端Node安装不包含在本次GitHub发版动作中；提供可安装更新包，不能据此声称已修复他人部署。

候选验证：npm test Worker87/87；npm run test:server Node16/16；HTTP5/5，类型/语法检查通过。build:server bundle265940B、payload404689B、0外部npm依赖；package:server归档103347B/15files（SHA-256：76a499e9b2d210fb69da759b7e021bf0f4a41228f033670e9db680fdfefff169），9项真实配置值仅内存比对、0命中。实际压缩包新安装1/1、manifest独立产物1/1过。旧dev.2归档SHA核对后运行并创建合成会话/key/旧schema日志，关闭后dev.3使用同一外置DATA_DIR，确认旧会话/key/日志和配置保留，旧日志ignoredParameters=[]。初次升级脚本用了非UUID日志id导致路由405；修正合成id后通过，未改生产代码。所有归档测试无真实上游。

本地真实数据库已用SQLite在线backup生成一致性快照，保存在ignored output/server-live内；不复制到安装包或Git。原环境文件保持不变；独立审查通过后核对原进程身份并停止，启动最终dev.3，健康、账号connected、无需重认证、既有1个key及页面资源均验证通过。首次启动后立即探测遇到进程尚未监听的ECONNREFUSED；就绪后读回通过，未重复启动进程。一次真实模型目录请求返回7项，含Spark及low/medium/high/xhigh；一次真实gpt-5.6-luna low普通生成返回HTTP200 / OK，上游usage为11输入+5输出=16tokens，基础日志与响应头均记录max_completion_tokens、temperature、top_p未生效。没有生成重试；先前旧版本400复现发生在归一化阶段，未到上游。该验证不等于生产Hermes或远端CF端到端验收。

## 发布回执

2026-09-07T15:43:48Z发布：[v0.2.0-dev.3](https://github.com/arctan303/OneAPI/releases/tag/v0.2.0-dev.3)，isDraft=false、isPrerelease=true。代码与标签commit为deb5eb07f94872663a396e0374c366493ea65a44；main和新标签原子推送成功，旧版本标签/附件未改。两份附件先上传草稿，再回下载逐文件SHA-256比对通过后发布；归档103347B，SHA-256见上。最终源码index审计213files、1481051B、9配置值内存比较、0findings，cached diff检查通过；个人signals修改未提交。后续文档回执单独提交，不移动版本标签。

本地8787运行最终dev.3，账号/key/配置保留；远端Node、Cloudflare策略及Hermes生产端到端仍须用户安装后验收，本次未连接或自动部署。
