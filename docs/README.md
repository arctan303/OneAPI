# OneAPI：个人 Codex 订阅网关

更新时间：2026-09-07。

## 本地扩展

账号官方额度、管理员按 key 日志、模型权限、有效期/停用、限速/并发已接入本地。真实 SDK 两种协议、显式思考程度、官方七天额度和完整后台流程已通过，fresh R2 独立复核通过；当前结果见 [PHASE-01](verification/PHASE-01.md)。精简日志默认开启，完整正文按需启用。计划为[本地扩展](dev-plan/phase-01.md)后进行[隔离Cloudflare测试](dev-plan/phase-02.md)；后者已部署并验证管理功能，但云端重新授权后模型/额度仍403。

## 当前状态

[LIVE-001](tasks/LIVE-001.md) 已完成本地真实验收：管理员登录和原账户恢复正常，读取 6 个真实模型，新建 API key 经 OpenAI SDK 调用 gpt-5.5 得到 LIVE_OK，后台浏览器流式测试得到 UI_OK。R2 独立复核通过。原 Wrangler 本地方式仍遇到目录 403；当前真实可用入口为用户已接受的 Node 本地方式。Cloudflare 已部署，当前上游调用仍受403阻碍。

管理员登录、7 天会话、后台直接测试、命名 API key 创建/撤销已经由 [AUTH-001](tasks/AUTH-001.md) 实现。账号原有设备码授权和本项目存储继续使用，没有重置数据库或读取其他应用登录文件。

本地业务仍为 TypeScript Worker + SQLite Durable Object。Node 运行器沿用同一业务、页面、Worker name 和持久化路径，本地 HTTP 入口捕获客户端断开，私有绑定负责官方目标出站与对应请求取消。传输差异证据不能单独证明某一请求头导致 403，也不代表纯 Cloudflare Worker 已可用。

## 使用方式

1. 在项目目录运行一次初始化：`npm run setup`（已有 .dev.vars 不覆盖）。
2. 本地真实运行：`npm run dev:node`，后台为 [http://127.0.0.1:8787/](http://127.0.0.1:8787/)。
3. 首次用现有 ADMIN_API_KEY 作为管理员口令登录，浏览器会话有效期内无需重复输入。口令位于项目忽略文件 .dev.vars，不应复制到聊天或日志。
4. 账户已连接时直接点击“加载模型”；未连接时点击“连接 Codex”，在官方网页输入本次设备码完成授权。
5. 模型测试加载目录后选择模型与思考程度（默认使用上游默认档位），填写消息后发送；外部软件则在 API 密钥区域创建命名密钥，选择全部模型或允许清单，并复制当次显示的完整 key。可编辑到期、停用、每分钟请求数与并发上限；留空沿用默认限制。
6. 第三方 Base URL：`http://127.0.0.1:8787/v1`；API key 使用后台创建的值；模型可选真实目录中的 ID，当前验收指定 `gpt-5.5`。

账号区域可刷新官方额度；缺失窗口显示未知。点击每个 key 的日志或“全部日志”，可按模型、结果和时间筛选并下载详情 JSON。默认只记模型、状态、耗时及官方 token usage；需要完整请求/响应时再打开正文记录开关。正文默认 7 天、精简 30 天，已结束日志另有 5000 条容量上限，可能提前淘汰；到期清理需要本地服务运行。

“退出后台”只退出该管理员会话；“断开 Codex”会清除本项目账号连接；“撤销”只撤销指定 API key。不要为修复 403 反复断开或重登。

## 启停与数据

- 停止运行器：启动终端中按 Ctrl+C；本地服务需要该进程保持运行。
- 原 Wrangler 运行命令仍为 `npm run dev`，目前其真实目录仍为 403；切换前先停止正在运行的实例。
- 存储沿用 `.wrangler/state/v3`；不得删除或并发打开。Node 运行器持有 SQLite 独占锁，原 Wrangler 不遵守该锁，不能靠改端口同时运行两种方式。
- 不写死 PID 作为下一次停止依据；停止前核实实际进程与命令。
- Mock 必须使用独立临时存储和测试配置，不能使用真实存储。

## 验证与资料

- `npm run typecheck`：类型检查。
- `npm test`：使用测试配置的业务 Mock 回归。
- `npm run test:dev-node`：运行器、存储兼容、出站和取消隔离验证，不发送真实请求。
- `npm run test:extensions`：独立 Mock HTTP 与 SDK 验证扩展，无真实请求。
- `npm run smoke:extensions`：复用项目自己的账号，创建临时 key，实际执行 gpt-5.5 Responses 普通和 Chat 流式各一次，验证官方额度/权限/日志并清理；会消耗订阅调用。
- `npm run smoke:live`：真实账户验收，每次一次目录、一次 gpt-5.5 普通生成、无 SDK 重试；创建临时 key 并在结束时撤销，会实际消耗订阅调用。
- `npm run build`：Wrangler dry-run 构建，不是真实部署。
- [接口与限制](API.md)、[产品契约](Product-Spec.md)、[开发计划](DEV-PLAN.md)、[LIVE-001 验证](verification/LIVE-001.md)、[403 诊断历史](verification/403-runtime-diagnosis.md)。旧 DEMO/AUTH 证据维持原适用基线，不把 Mock 改写成真实成功。

## 尚未证明

Cloudflare 云端成功调用、自然 token 刷新、全部目录模型逐一生成，以及函数工具的真实上游行为仍待单独验收。Chat 文本流式已有 Phase-01 真实证据；当前未识别到通用 5h 额度窗口，额外模型额度单独显示。真实目录可选不等于每个模型均已测试。

环境：C:\git\OneAPI，Windows PowerShell，Node 24.15.0，npm 11.12.1；已初始化 Git，第一版归档目标为 arctan303/OneAPI，版本 v0.1.0；见 [归档记录](verification/ARCHIVE-001.md)。开发子代理按用户分工使用 gpt-5.6-sol/high，简单任务可用 gpt-5.6-luna；这不改变网关调用模型。

Worker 部署与 Access 配置见 [部署说明](DEPLOYMENT.md)。Phase-02 已部署至 https://api.arcinks.com/，后台管理通过；云端重新登录后模型目录与额度仍返回403，纯Worker调用尚未跑通，见阶段验证记录。
