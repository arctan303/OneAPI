# RELEASE-005：v0.2.0-dev.4 开发版

日期：2026-09-08。用户明确授权本地开发、测试、提交推送与 GitHub dev.4 prerelease；未授权也未执行远端生产部署。路线为 CODEX-PROVIDER-001 产品变更与既有前端优化合并发布，R2 原因是 Codex 安装/会话/窗口/turn 元数据将按白名单转发给既有 OpenAI Codex 上游。

## 发布准备状态

状态：已提交、推送并发布 GitHub prerelease；fresh R2 reviewer、附件回下载哈希和远端状态回读均通过。

版本来源：package.json 与 package-lock.json 为 0.2.0-dev.4。发布产物：
- `dist/oneapi-server-0.2.0-dev.4.tar.gz`
- `dist/oneapi-server-0.2.0-dev.4.tar.gz.sha256`
- 归档 113686 bytes，15 files，SHA-256 `a152eb9b7ae25a68bdbe4876264c0bf24d8498c9e69f0968377e164ad6496cce`
- server bundle 274785 bytes，payload 452833 bytes，runtimePackages 0

## 协议与真实证据

本机 Codex CLI 0.153.4 使用 `--ignore-user-config --ephemeral` 和临时 provider 覆盖，不修改用户长期配置。真实账号目录返回 7 个模型，标准 data 与原生 models 顺序一致，原生对象包含 shell_type、base_instructions、model_messages、reasoning、verbosity、service tier 等当前字段。

真实 `gpt-5.6-sol` 文本调用返回 `CODEX_LOCAL_OK`。最终工具边界修复前，一次真实 smoke 精确暴露 Codex 默认 `additional_tools` 包含 `{type:"namespace",name:"functions"}`；无凭据 loopback 捕获仅记录 type/name 后自动退出。实现据此只在 `additional_tools` 放行客户端 `namespace`，继续拒绝 `web_search`、`file_search`、`computer_use_preview` 等托管类型；修复后真实 `gpt-5.6-luna` 返回 `NESTED_TOOLS_OK`。只读 `view_image` 工具调用经两轮 Responses 回传后返回 `VIEW_TOOL_ROUNDTRIP_OK`；精简日志显示对应连续请求。另一次 `gpt-5.6-luna` 请求携带 `service_tier` 和自定义未来字段，HTTP 200、响应头为 `service_tier, future_option`、正文为 `UNKNOWN_OK`。一次 shell 工具探针因宿主嵌套执行策略被拒绝，但错误工具输出仍回传并触发续轮；未使用无沙箱绕过。

## 前端证据

Playwright 隔离浏览器完成桌面与 390×844 验收：登录、概览真实额度刷新、原生 progress 数值、模型与 reasoning 目录、手动模型入口、API key 创建对话框（只打开未提交）、日志筛选与详情弹窗。390px 文档宽度 375px，无横向溢出；创建弹窗边界 left 16/right 374。修复额度条、账号状态和日志 chip 的内联样式后，严格 CSP 下 error 级控制台记录为 0。reviewer 修复后又用恶意 model 标记生成本地失败日志：页面显示其文本但 `#injected-proof` DOM 节点为 0；`bar-danger` 计算变量为 `#dc2626`，复验控制台仍为 0 error。截图仅保存在 ignored 的 `output/playwright`，不进入 Git 或安装包。

## 自动化与产物

已通过：
- `npm test`：Worker/Vitest 95/95
- `npm run test:codex`：27/27
- `npm run typecheck`
- `npm run test:server`：16/16
- `npm run test:server:http`：5/5
- `npm run test:dev-node`
- `npm run test:sdk`
- `npm run test:extensions`
- `npm run build:worker` dry-run
- `npm run build`、`npm run package:server`
- `npm run test:server:fixtures`：11/11
- `npm run test:release`：1/1

SDK 并发测试最初稳定复现首 SSE 事件晚于 Mock 专用 100ms 生成超时；慢流仍保持 10ms 拉取延迟，仅将慢流分片从 17 增至 256 bytes 后通过，并保留并发占位与 AbortController 取消覆盖。生产流式代码未因此改变。

## 隐私和敏感信息审计

打包器从本机配置仅内存读取 9 个 secret 值并与 15 个产物逐字节比对，configuredSecretMatches=0；不输出真实值。个人 `.codex/evolution/signals.md` 已从前端发布提交中移除，工作区原内容哈希保持不变且不纳入候选。最终源码 index 审计覆盖 219 files、1558247 bytes，并把 9 个本机配置值仅在内存中逐字节对照，0 findings；通用疑似 secret 初筛无结果。GitHub 草稿附件回下载后，本地归档、下载归档与下载的 `.sha256` 三方哈希一致。

发布涉及真实账号模型目录、额度和精简调用日志，但不提交账号标识、正文、截图、数据库或环境文件。原始 Codex 模型能力字段会向通过该 key 权限过滤的调用者返回；白名单 client_metadata/header 会转给固定 OpenAI Codex 上游，客户端认证头与未知值不转发。

## GitHub 发布回读

2026-09-08T02:05:20Z 发布 [v0.2.0-dev.4](https://github.com/arctan303/OneAPI/releases/tag/v0.2.0-dev.4)：`isDraft=false`、`isPrerelease=true`。远端 `main` 与 annotated tag 剥离后的提交均为 `e79723f7b92bb125d5ee079025d4a1012091e86b`；tag 对象为 `4aef5c73be92f296586ece3161e6258f814c1cba`。

草稿阶段上传并回下载两份附件：

- `oneapi-server-0.2.0-dev.4.tar.gz`：113686 bytes；GitHub digest 与三方实算均为 SHA-256 `a152eb9b7ae25a68bdbe4876264c0bf24d8498c9e69f0968377e164ad6496cce`
- `oneapi-server-0.2.0-dev.4.tar.gz.sha256`：99 bytes；内容指向同一归档哈希

回下载核对通过后才解除草稿。dev.3 标签与附件未修改；本次未部署远端 Node、Worker 或 Access。

## 回滚与恢复

dev.4 无数据库迁移。回滚时停止 dev.4，备份当前外置 DATA_DIR 与环境文件，再启动 dev.3 并继续使用原配置；回滚后的新增日志/调用记录只存在于当前数据副本。GitHub 发布后保留 dev.3 标签与附件；若 dev.4 需撤回，可将 prerelease 标记为 draft/删除 dev.4 标签与附件，但不移动旧标签。远端生产升级不在本次范围。
