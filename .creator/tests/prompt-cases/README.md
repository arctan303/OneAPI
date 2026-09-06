# Prompt 行为用例

`cases.json` 是 creator.skill 的稳定行为契约，覆盖路由、追问、审查收敛、中断恢复、自进化和发布权限。

运行静态契约与用例结构检查：

```powershell
python .creator/scripts/evaluate_prompt_cases.py
```

对 Agent 的结构化响应字段评分时，传入 JSON：

```powershell
python .creator/scripts/evaluate_prompt_cases.py --responses path/to/responses.json
```

响应文件格式：

```json
{
  "responses": [
    {
      "case_id": "route-maintenance-docs",
      "route": "维护执行",
      "risk": "R0",
      "primary_skill": "dev-builder",
      "question_count": 0,
      "escalation": false,
      "status": "continue",
      "new_reviewers": 0
    }
  ]
}
```

评测响应应来自 fresh Agent，只提供该用例的原始输入和当前发布包，不提供期望答案。没有响应文件时，脚本只验证用例集、Prompt 结构和界面元数据，不声称完成模型行为评测。

响应评分默认要求覆盖全部用例，适合回归门禁。只做探索性抽样时必须显式使用：

```powershell
python .creator/scripts/evaluate_prompt_cases.py --responses path/to/responses.json --allow-partial
```

字段约定：`escalation` 只表示是否需要把当前路线或风险向上升级；等待用户授权、记录观察或把无限 Goal 改写成有界 Goal 不算升级。`status=needs-input` 表示必须等用户回答才能继续，`status=interrupted` 表示外部容量或宿主条件中断但检查点可恢复。可选字段 `deferred`（仅批处理类用例要求）：`true` 表示该小改应进入 `docs/maintenance/batch.md` 待复查队列，`false` 表示即时验证、不入队。

## 1.5 校准与测试边界

用例新增风险、Phase 规模、文档生命周期和有进展复核的边界。`risk=待定` 只用于尚无具体变更的收敛阶段；实施前要给出实际风险依据。可选 `plan_kind` 为 none/task/phase，`doc_action` 为 none/reuse/update-current/migrate；存在预期字段才评分。`new_reviewers` 记录该次动作新增数量，不表示整个任务的累计配额。

静态通过只证明结构、字段和本地引用有效。响应字段正确也不证明 Agent 实际修改了文档、保留了旧证据或遵守只读限制；实际任务需结合文件 diff、命令记录、范围边界和人工判断核验。不得复制 expected 生成响应充当模型测试。

1.5 本轮只维护用例与脚本，由用户后续运行真实任务并反馈，不启动跨模型试跑。后续反馈记录实际版本/模型、任务范围、相关 diff 与证据，再合并进对应案例；不预先声称问题已在所有模型消失。

批量复查收尾用例增加可选 `batch_action`：prune-closed（仅移出已关闭项）、reset-empty（全部关闭后重置）、retain-open（保留尚未被有效审查覆盖的项）。实际文件清理仍由后续任务验证，字段评分不代替 diff 核验。
