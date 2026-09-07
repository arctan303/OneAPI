# RELEASE-005 独立审查：v0.2.0-dev.4

日期：2026-09-08。fresh reviewer 未参与实现，只读审查基线为 `v0.2.0-dev.3..HEAD` 加候选 Git index；个人 `.codex/evolution/signals.md` 明确排除。

## 风险及结论

R2：Codex 安装、会话、窗口和 turn 元数据会按白名单发送给固定 OpenAI Codex 上游；原始模型能力目录也会返回给通过 key 权限过滤的调用者。

**最终结论：通过。** 无剩余可执行问题，无发布阻断。

## 首审发现与关闭

1. 原生工具路径最初会接受任意工具 type。修复后顶层 native `tools` 仅允许 `function/custom`，对象式 `tool_choice` 同样受限；`additional_tools.tools` 只额外允许当前 Codex 0.153.4 真实默认发送的客户端 `namespace` 声明。顶层与嵌套的 `web_search`、`file_search`、`computer_use_preview` 等托管类型均明确拒绝并有回归测试。
2. 日志列表和动态额度标签原使用动态 `innerHTML`。修复为 DOM 节点与 `textContent`；真实恶意 model 日志仍显示文本，但 `#injected-proof` 节点为 0，严格 CSP 控制台 0 error。
3. 低额度 progress 缺危险色。已补 `bar-danger=#dc2626`，浏览器计算值核对一致。
4. 受限 key 的原生 `models` 视图缺隔离测试。现以 `client_version` 请求同时断言 `data/models` 仅含允许模型，且整体不含隐藏模型。
5. 元数据 16 KiB 上限已从 JavaScript 字符数改为 UTF-8 字节数，并增加多字节 `client_metadata` 回归。

## 真实协议校准

第一次聚焦修复把 `additional_tools` 收紧为仅 `function/custom` 后，真实 Codex smoke 立即以 `input[0].tools[0].type` 被拒绝。随后使用假 key 的 loopback 捕获端点只记录 type/name，确认 Codex 0.153.4 默认发送 `{type:"namespace",name:"functions"}` 且顶层 tools 为空。最终实现只在 `additional_tools` 位置放行该客户端声明，修复后真实 ephemeral `gpt-5.6-luna` 返回 `NESTED_TOOLS_OK`。

## 独立证据

- `npm run test:codex`：27/27；`npm run typecheck`：通过。
- 最终归档：113686 bytes；SHA-256 `a152eb9b7ae25a68bdbe4876264c0bf24d8498c9e69f0968377e164ad6496cce`；校验文件一致。
- 最终源码 index 审计：218 files、1555556 bytes、9 个本机配置值内存对照、0 findings。
- 前端注入、危险额度色、双模型目录权限隔离与 UTF-8 字节边界在最终聚焦复核中保持关闭。

## 残余缺口

仅剩 GitHub 发布流程本身：草稿附件回下载哈希核对、远端 tag/commit 和 prerelease 状态回读。发布后写入 RELEASE-005；远端生产部署不在本次范围。
