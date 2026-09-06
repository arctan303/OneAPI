# OneAPI

个人 Codex 订阅网关。首版已归档为 v0.1.0，当前工作区为后续本地扩展。单管理员登录、连接自己的 Codex 账户、模型目录、API key 管理，以及 OpenAI 风格 Responses / Chat Completions 文本与函数工具子集。

## 本地启动

需要 Node.js 24（本次验证 24.15.0）。

```powershell
npm ci
npm run setup
npm run dev:node
```

打开 [本地后台](http://127.0.0.1:8787/)，用本机 .dev.vars 中的 ADMIN_API_KEY 作为管理员口令登录。连接 Codex 后，在官方网页完成设备码授权；已连接则直接加载模型。后台创建 API key，其他客户端填写 Base URL `http://127.0.0.1:8787/v1`、该 key 和模型 ID。

本地扩展加入官方账号额度、按 key 日志、可选完整正文、模型范围与有效期/停用/限速/并发控制，以及按模型目录选择思考程度。当前最终验收见 [Phase-01 证据](docs/verification/PHASE-01.md)。实际已通过 gpt-5.5 新 key 的 Responses 普通与 Chat 流式调用；目录可读取其他可选模型，但未逐一验证。原 Wrangler 方式仍遇到上游 403，当前本地真实可用入口是 dev:node。Cloudflare 部署尚未完成。

## 检查与边界

`npm test`、`npm run test:dev-node`、`npm run test:extensions`、`npm run typecheck` 为隔离检查；`npm run build` 是 dry-run。`npm run smoke:live` 会发送一次真实目录和一次 gpt-5.5 生成，并清理临时 key。

归档不包含真实凭据、OAuth 数据库、调用记录、截图或临时测试数据。在另一台机器使用需要初始化并自行授权账号。示例和测试配置只含公开测试值。

详见[使用说明](docs/README.md)、[接口与限制](docs/API.md)、[真实验收](docs/verification/LIVE-001.md)和[独立复核](docs/verification/LIVE-001-review.md)。历史文档中提及的本机截图和 PID 只描述当时证据，不作为仓库附件或当前进程信息。

Worker 部署与 Access 配置见 [部署说明](docs/DEPLOYMENT.md)。Phase-02 代码、本地验证及部署前独立审查已完成；云端上传等待宿主要求的明确凭据授权，尚未创建 Worker。
