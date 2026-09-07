# MARKER-001 独立 R2 审查

范围与基线：

fresh reviewer 未参与 MARKER-001 实施，仅审查 `scripts/probe-local-marker.mjs`、`scripts/test-probe-local-marker.mjs` 与 `docs/tasks/MARKER-001.md`。基线为当前工作区 efd57b9 加历史未提交修改；本轮不纳入范围外实现。审查只读，未读取 `.dev.vars` 内容、未读取 Secret、未访问真实上游。

风险及依据：

该脚本会在同一 Node 进程经既有 `createRuntime.localOutboundFetch` 使用真实 access token，错误可能造成额外请求、refresh、凭据外带或本地状态改变。契约要求固定 models URL/clientVersion，最多 baseline+variant 两次 GET，baseline 非 200 停止并合成 502，预检 token/refresh margin，前后状态稳定，拒绝 refresh 和其他目标，摘要不得包含 token/raw body/original headers，并具备有限时间、响应大小与取消边界。

结论：通过

首轮问题与关闭证据：

1. **baseline 超过 2 MiB 时 clone tee 取消可能永久等待。** 修复后不再使用 `baseline.clone()`；`captureResponse` 单次读取 baseline，限制 2 MiB 和 4.5 秒，超限/超时调用 cancel 但不等待其 Promise，并用已捕获字节重建返回给业务的 Response。fixture 新增超大 body 和永不结束 body 两个回归，均确认取消发生、variant 未启动且调用及时失败。

2. **失败时 report 丢失的首轮描述已精确化并修复。** 普通 synthetic 502 会作为正常 `localAdmin` 返回值继续执行后置 status，因此本身不会触发 catch；首轮真正成立的缺口是 models 请求 timeout、readJson 失败等异常路径会由旧主流程直接输出通用错误而丢失 count/observations。修复后主流程分别捕获 models 与后置 status 异常，尽力执行后置 status；最终 catch 保留 `resourceRequests`、baseline/variant 脱敏摘要和 `statusStable`。baseline 非 200 的正常 synthetic 502 路径也会输出 baseline 摘要和请求计数。

验收覆盖与文档核对：

- `node --check scripts/probe-local-marker.mjs` 通过。
- `node --check scripts/test-probe-local-marker.mjs` 通过。
- `node --test scripts/test-probe-local-marker.mjs`：4/4 通过、无 skip。
- fixture 覆盖 baseline→variant 且仅增加 `CF-Worker`、共享 signal、baseline 401 停止 variant 并合成 502、非 models 目标拒绝、refresh margin 校验、安全摘要、超大 body、永不结束 body、取消与请求计数。
- 静态核对确认 `createRuntime({ requestedPort: 0, localOutboundFetch })`、既有存储锁及 `finally` dispose；models 业务调用使用 5 秒 timedFetch 和固定 URL。新增 capture deadline 及主流程失败报告修复后，原两项证据缺口已关闭。
- 任务文档已声明真实请求待验证；本审查没有把本地 fixture 当成线上证据。实施、验证、审查和发布状态保持分开记录。

本轮关闭/剩余问题、新增证据：

首轮两项问题均已由实质修复和新增回归关闭。本轮没有新的可执行问题；MARKER-001 可进入真实执行前的授权门禁阶段。

残余缺口和恢复条件：

未进行真实上游请求、未使用公网 Tunnel、未读取或上传 cloud Secret；这些是任务明确限制，不构成代码审查失败。真实执行仍需严格遵守任务中的 baseline 非 200 停止、两请求预算和前后 status 稳定条件；如真实运行失败，只记录脱敏摘要，不将本地 fixture 结果当作上游因果结论。
