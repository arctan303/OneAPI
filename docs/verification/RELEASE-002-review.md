# RELEASE-002 维护队列聚焦审查

范围与基线：

- 本轮是同一 reviewer 对前轮唯一 blocker 的聚焦复核，范围限于 WORKER-403-DIAG 的 safeUsage 净化、写盘路径及其新增 sentinel 回归；不重审 SERVER-001，也不扩展 PURE-WORKER-PROBE 的已关闭结论。
- 前轮基线为 Git HEAD efd57b9d96c394c944574fb0cf39daf17e0d3c36。工作树含其他任务的未提交变化；本报告只将当前两个 WORKER probe 文件及本轮证据计入结论。
- 当前脚本 SHA-256：scripts/probe-worker-upstream.mjs 9F50DD5FE2A86704C0955C7CA54FF972ECB0C8FB1DB278845D475C352E7C417A；scripts/test-probe-worker-upstream.mjs BE722F351488248798385951C00EFC2729E7838EDA2896786B08E40AA375900A。
- 未读取真实 .env、.dev.vars、账号库或 Secret，未访问真实上游/云端，未创建资源；本轮仅使用隔离临时目录和合成 fetch fixture。

风险及依据：

WORKER-403-DIAG 会把上游 usage 摘要写入 probe 输出文件。若把响应中的 access token、refresh token 或其他认证材料递归复制到 report，就会造成凭据持久化。修复必须同时约束内存 report 和保存 JSON，并保持原有固定目标、失败计数、单次请求预算和默认禁用边界。

结论：通过

前轮问题及本轮复核：

- 前轮 P1 已关闭。safeUsage 现在只接受精确字段白名单中的有限 number；字符串、非有限 number、数组和其他未列入白名单的叶子均丢弃。
- 对字段名匹配 token、key、secret、password、cookie 或 auth 的对象分支，在递归前直接拒绝，因此嵌套 usage_details.access_token、deeper_usage.refresh_token 和 authorization 不会被复制或继续遍历。
- 非敏感对象仍可递归净化，只有包含至少一个允许字段时才返回；usage 路径和 generate 路径都通过该净化结果写入 target.usage，最终 output 文件序列化同一 report。
- 新增 fixture 以嵌套 token sentinel 复现旧风险并验证修复：prompt/completion/total 数值保留，usage_details.total_tokens 保留，嵌套 access_token、refresh_token、authorization 和 secret 均不出现在返回 report 或保存文件。

验收覆盖与文档核对：

- node --test scripts/test-probe-worker-upstream.mjs：4/4 通过，0 skipped。覆盖健康请求先行且无凭据、usage 失败状态与诊断白名单、HTTP 403 不落原始错误、固定 gpt-5.5 单次生成；新增 usage sentinel fixture 同时检查内存 report 和保存 JSON。
- node --check scripts/probe-worker-upstream.mjs：通过。
- node --check scripts/test-probe-worker-upstream.mjs：通过。
- 本轮没有执行真实 probe 命令，因此没有读取项目实际 .dev.vars.worker，也没有发出真实出站请求。
- 前轮对 PURE-WORKER-PROBE 的 8/8 fixture、输入目标固定、Secret 不输出、失败次数和资源清理证据仍适用于未修改的相邻路径；本轮不重复运行。
- WORKER-403.md、PURE-WORKER-001.md 保留“原上游 403 是外部事实”的边界，没有把探测成功写成上游或生产修复。

本轮关闭/剩余问题、新增证据：

- WORKER-403-DIAG 前轮 P1 已关闭；当前聚焦范围未发现新的可执行问题。
- PURE-WORKER-PROBE 前轮已复查通过并已从 batch 移出。
- 原上游 403、未执行真实出站和未读取真实环境仍是发布边界，不是本轮 blocker，也不能表述为上游修复。
- 当前新增证据为 safeUsage 白名单及敏感递归拒绝的代码核验、4/4 sentinel fixture、两个脚本语法检查和上述当前 SHA-256。

批量复查时：

- 覆盖条目：WORKER-403-DIAG、PURE-WORKER-PROBE；基线与范围见本报告。
- 可关闭项：WORKER-403-DIAG（safeUsage blocker 已修复并由同一 reviewer 聚焦复核通过）；PURE-WORKER-PROBE（此前已通过并移出队列）。
- 回执依据：WORKER fixture 4/4、两个 node --check 通过、sentinel 未出现在内存 report 或保存 JSON；由主会话按共同契约清理剩余队列记录。

残余缺口和恢复条件：

- 本轮刻意没有真实网络、真实环境或云资源验证；若要声明生产/上游行为，需另行获得对应授权并执行独立验收。
- 现有脚本仍只报告有限摘要，不代表修复了上游 403；后续若变更 usage 字段白名单或输出格式，应重新运行本 sentinel fixture 并重新聚焦审查。
