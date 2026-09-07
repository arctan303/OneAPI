# SPARK-CATALOG-001：Codex 订阅模型目录错误过滤 Spark

日期：2026-09-07。路线：维护，短任务，R1（修正目录筛选；仍由上游账号授权与现有key模型白名单控制访问，不扩大key权限）。基线：66191e9 / v0.2.0-dev.2，与ACCESS-RETURN-001独立文件范围，按用户要求分批实施。

## 目标与证据

用户询问模型列表中为何没有 GPT-5.3-Codex-Spark。OneAPI只接Codex OAuth订阅账号，目录应保留该账号上游列出的可选模型，并与调用key白名单求交集。src/account-core.ts parseModelCatalog当前跳过supported_in_api=false，另外保留visibility=hide过滤。

本机官方Codex models_cache.json（fetched_at 2026-09-07T14:36:02.570955700Z，仅读取模型字段，未读取CLI凭据）包含gpt-5.3-codex-spark：visibility=list、supported_in_api=false，支持low/medium/high/xhigh。本地OneAPI一次/admin/test/models真实只读请求200、6模型，不含Spark；没有发出生成请求。该缓存不证明远端Node所登录账号相同或远端必有Spark，远端仍以上游实际目录为准。

[OpenAI官方速度文档](https://learn.chatgpt.com/zh-Hans/docs/agent-configuration/speed)确认Spark是独立模型，研究预览面向ChatGPT Pro，有独立用量限制。结合官方Codex目录可选却API标记false和当前代码，可确认该筛选能错误排除订阅模型；不能将Platform API支持标志一概当作Codex订阅目录授权。

## 范围、验证与状态

最小修复：Codex订阅目录不再单凭supported_in_api=false排除模型，继续要求有效模型条目并尊重visibility=hide；不硬编码Spark、不伪造不存在的账号模型、不更改每key模型白名单或上游授权。新增合成目录回归：false/list可见且保留reasoning能力，hide仍隐藏，key白名单仍裁剪且拒绝越权调用。

状态：已实现并冻结，进入登录路由第三批。复用既有Mock目录与运行测试，不消费真实生成配额。无远端更新、无版本标签或附件覆盖。

验证：新增订阅目录用例修复前15项中仅该项失败（预期可见模型但实际空目录）；修复后Worker extensions/gateway共34/34、Node runtime9/9、typecheck与定向diff检查通过。合成目录单独配置，默认fixtures未改变；验证false/list可见、reasoning保留、hide隐藏及key白名单调用拒绝且未到上游。RELEASE-004独立复核已通过并随v0.2.0-dev.3发布；本地真实目录已返回Spark及low/medium/high/xhigh，远端实际目录仍待更新后确认。
