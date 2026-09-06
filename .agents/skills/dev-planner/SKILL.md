---
name: dev-planner
description: 为明确目标选择短任务或有依赖的 Phase 计划。用户要求阶段计划、多阶段交付或维护任务需要跨阶段协调时使用；已有足够的活跃计划则直接更新，不为每轮小改新建 Phase。
---

# 开发计划

## Purpose

让另一会话能从有效契约、前置成果和验收继续执行，计划规模与任务相称。

## Trigger

用户要求计划；或多个分别验收的阶段存在先后依赖。产品和维护都可能需要计划；单一明确任务可直接开发。

## Required context

用户目标、已确认范围/验收、现状入口、相关需求/设计、当前计划、真实代码与验证命令。

## Workflow

1. 按实际规模选择更新现有短任务或 Phase；用户点名 Phase 时落实，不用口头计划代替文件。
2. 范围对账：核对相关有效决定、非目标、延期和被替代记录。信息足够但缺形式变更记录时补写；只为真正未决选择提问。
3. Phase 在实施前落盘目标、任务、前置 ID 和所需成果、验收及风险理由；小型产品变更只需短任务和需求更新。
4. 索引维护活跃/下一步及历史导航；更新承接关系，不重抄全部历史。

## Output

短任务或 docs/DEV-PLAN.md 与相关 Phase 明细；范围对账、depends_on、必要的 supersedes、验收和分别记录的状态。

## Stop or escalate

只有影响方向/范围/验收的未决项阻塞其依赖阶段；不把缺模板变成用户重新决定的理由。Phase 身份不决定 R2；按具体后果评级。

## References

编写计划时读 [stage-contract.md](references/stage-contract.md)；文档与状态细则读[共同契约](../../../.creator/references/workflow-contract.md)相关章节。
