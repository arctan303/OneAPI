# 本地 API 与管理扩展

本文件描述 Phase-01 的有效接口范围；当前实施与验证进度见 [Phase-01](dev-plan/phase-01.md)。Base URL 为 http://127.0.0.1:8787/v1。机器调用使用 Authorization: Bearer 加后台创建的 API key；不需要管理员 Cookie。

## 模型与生成

| 方法与路径 | 接受字段与行为 | 边界 |
| --- | --- | --- |
| GET /v1/models | object:list、data；账号可用目录与该 key 模型范围交集 | 停用/到期 key 拒绝；允许清单不会自动增加未来模型 |
| POST /v1/responses | model、input、instructions、stream、tools、tool_choice、parallel_tool_calls、reasoning.effort、store:false、background:false | input 支持文本消息、function_call 和 function_call_output；客户端传完整上下文 |
| POST /v1/chat/completions | model、messages、stream、tools、tool_choice、parallel_tool_calls、stream_options.include_usage、reasoning_effort | system/developer/user/assistant/tool 与函数工具；普通 JSON 或 SSE |

不支持的字段明确返回 400：temperature、top_p、max_tokens、max_completion_tokens、max_output_tokens、n、response_format、previous_response_id、图片/音频、托管工具和后台任务。不能通过忽略调用方限制伪装兼容。reasoning effort 最终以选定模型目录的能力校验为准。

两种生成接口使用同一 key 模型权限、到期、停用、每分钟限额和并发检查。原全局并发上限仍为 2。每 key RPM 使用从首个已接受请求开始的固定 60 秒窗口，不是自然分钟或滑动窗口。目录列表和后台检查不会自动逐一生成，也不能将目录可选误写为所有模型都已完成真实测试。上游 usage 缺失则返回/显示未知。

## 思考程度

思考程度按每次请求指定；key 继续控制可用模型，不固定思考档位：

- Responses：`{"model":"gpt-5.5","input":"你好","reasoning":{"effort":"high"}}`。
- Chat Completions：`{"model":"gpt-5.5","messages":[{"role":"user","content":"你好"}],"reasoning_effort":"high"}`。
- 省略参数使用上游默认。目录无法确认或模型不支持时明确报错，不替换为其他档位。

`GET /v1/models` 在标准模型条目上附加 OneAPI 自定义字段：

```json
{"id":"example-model","object":"model","created":0,"owned_by":"openai","capabilities":{"reasoning":{"supported_efforts":["low","medium","high"],"default_effort":"medium"}}}
```

示例档位不是所有模型的固定范围。supported_efforts 为 null 表示官方未提供，[] 表示官方明确为空；default_effort 缺失或不在确认范围时为 null。目录仍只返回 key 允许的模型。能力缓存为 5 分钟，绑定当前账号与连接代次；首次显式指定或缓存过期时有限更新一次，并合并并发加载，后台加载目录后按所选模型提供下拉选项；未知模型只显示上游默认。

官方说明：[请求参数](https://developers.openai.com/api/docs/guides/latest-model)、[Codex model/list 能力字段](https://learn.chatgpt.com/docs/app-server)、[标准 models list 字段](https://developers.openai.com/api/reference/resources/models/methods/list)。原始目录字段依据 [官方 ModelInfo 源码](https://github.com/openai/codex/blob/4aec23384e85734bbae3a3eed06a9218babc4e51/codex-rs/protocol/src/openai_models.rs)。Codex 订阅账号目录与公开 Platform 模型介绍可能不同，应以当前账号实际响应为准。

## 第三方接入示例

客户端填写 Base URL http://127.0.0.1:8787/v1、后台创建的 key 和该 key 允许的模型。以下 JavaScript 示例使用仓库的 OpenAI SDK，从环境读取 key：

```javascript
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: process.env.ONEAPI_KEY,
  maxRetries: 0,
});
console.log((await client.models.list()).data.map(model => model.id));
const response = await client.responses.create({
  model: "gpt-5.5", input: "只回复：连接正常",
});
console.log(response.output_text);
const stream = await client.chat.completions.create({
  model: "gpt-5.5",
  messages: [{ role: "user", content: "只回复：连接正常" }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? "");
}
```

示例会实际调用两次。自动附带 temperature 或 max_tokens 的客户端需要关闭这些字段；当前不会静默忽略不支持的参数。

## 管理接口

所有 /admin/* 数据接口只供管理员。浏览器使用既有 HttpOnly 会话；脚本兼容管理员 Bearer。会话写操作必须同源且 application/json。普通 API key 无权读取日志、账户资料或设置。

| 方法与路径 | 用途 |
| --- | --- |
| GET /admin/status | 连接状态、邮箱/套餐（缺失 null）、账号标识和凭据刷新状态；无 token |
| GET /admin/usage | 官方账号额度；正常读取有 30 秒缓存，refresh=true 强制刷新 |
| GET /admin/api-keys | 密钥掩码、名称、模型范围、到期/启用状态、限速与并发 |
| POST /admin/api-keys | 创建；完整 key 只在该响应返回一次 |
| PATCH /admin/api-keys/:id | 编辑 name、enabled、expiresAt、modelAccess、rateLimitPerMinute、concurrencyLimit |
| DELETE /admin/api-keys/:id | 撤销新建 key，不删除其历史日志 |
| GET /admin/log-settings | 读取精简/正文保留策略与正文记录开关 |
| PATCH /admin/log-settings | 修改保留天数、captureBodies、maxBodyBytes |
| GET /admin/logs | keyId、model、outcome、from、to、limit、cursor 筛选分页 |
| GET /admin/logs/:id | 日志详情；管理员可下载此 JSON 作为导出 |

modelAccess 为 `{"mode":"all","models":[]}` 或 `{"mode":"allowlist","models":["gpt-5.5"]}`。原环境 key 以 legacy 标识管理，也执行限制；不能删除其环境值，需停用或修改本机配置。旧 key 缺新增字段时默认启用、全部模型、不过期、无附加限流，不改变密钥值。

实施边界：白名单 1..64 个模型；每分钟限额 1..6000 或 null；并发 1..2 或 null；到期时间使用毫秒时间戳或 null。精简保留 1..365 天，默认 30；正文 1..30 天，默认 7；单正文上限 1024..262144 字节，默认 65536。超限、未完成和缺失正文显式标记，不声称可恢复未采集的历史内容。

额度来自当前项目保存的 OAuth 账号调用官方 /backend-api/wham/usage。按实际窗口时长识别 300 分钟与 10080 分钟，显示 usedPercent、remainingPercent 和 resetsAt（毫秒时间戳），不把单次 token 统计变成订阅剩余量。额外 bucket 保留来源标识单独展示。失败显示错误与最后成功时间，不能用旧数据冒充新额度。

完整日志默认关闭。开关在请求开始时确定；仅采集客户端 JSON 与响应内容，不记录认证头、Cookie 和 OAuth 凭据。日志含用户输入输出，应按需启用。正文到期由 Durable Object alarm 物理清除（本地进程须在运行，重启会补清）；元数据保留已采集与到期时间，详情可区分已过期与未开启。精简记录按期限清理，同时最多保留 5000 条已结束记录，超额从最旧开始淘汰；活跃记录另计，异常退出的孤儿请求按截止时间结束。容量上限可能早于 30 天淘汰历史。失败记录不影响已成功返回的生成。两类日志仅覆盖身份已识别的 API-key 调用，包括模型权限/限流拒绝；随机无效、到期或停用 key 的鉴权失败不记为调用日志。后台管理员直接测试不生成 API-key 日志。

## 验证命令

- npm run test:extensions：创建独立临时 Mock 运行器，登录、额度、key 目录/权限、SDK 两种协议、基础/完整日志、停启与清理；不连接真实上游。
- npm run smoke:extensions：连接已启动本地真实服务，复用项目账号，执行有界官方额度/目录读取与两次 gpt-5.5 生成（Responses 普通、Chat 流式），SDK 零重试；临时 key 撤销、日志设置恢复、测试会话退出。
- node scripts/verify-extensions.mjs --live --reasoning-only：官方能力元数据/非法档位检查，加一次显式思考程度的 Chat 流式生成与正文日志核对；临时 key 和设置清理，不重复 Responses 普通生成。
- node scripts/verify-extensions.mjs --live --read-only：仅管理员状态与一次强制官方额度读取，不生成、不改 key 和日志设置。

真实测试只打印结构化结果、用量和长度，不打印凭据或请求响应全文。测试产生的精简/已启用正文日志遵守保留策略，不清除用户历史数据。

## Cloudflare Access 与账号迁移（Phase-02）

- `GET /access/status`：公开，只返回 `{enabled}`，不公开 Team Domain/AUD。
- `GET/PATCH /admin/access`：管理员读取/保存 `{enabled,teamDomain,applicationAud}`；返回另含 updatedAt。启用必须填写两个参数。
- `GET /admin/access/login`：受 Cloudflare Access 保护的同源登录入口，通过管理员身份校验后跳回根页面；不接受外部 redirect 参数。
- `GET /admin/session`：新增 provider（access/session/bearer/null）及 logoutUrl；Access 每次请求验签，不换成长效管理员 Cookie。
- `POST /admin/account/import`：仅部署时临时启用；HTTPS、管理员 Bearer 及 X-OneAPI-Import-Secret 同时有效；最大 32 KiB，body 严格为 idToken/accessToken/refreshToken。目标账号必须为空，固定官方目录验证成功才加密保存；成功 204，关闭后 404，已有账号 409。没有导出接口。

普通 API key 不能调用上述管理接口。Access 只用于管理，不代替 /v1/* 调用 key；部署和门禁恢复见 [部署说明](DEPLOYMENT.md)。
