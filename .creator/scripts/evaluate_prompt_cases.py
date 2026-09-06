#!/usr/bin/env python3
"""验证 creator.skill Prompt 契约，并可对结构化 Agent 响应评分。"""

import argparse
import json
import re
from urllib.parse import urlsplit, unquote
from pathlib import Path
from typing import Dict, List
from check_docs import markdown_links, contained


ASSET_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW_ROOT = ASSET_ROOT.parent
CASES_PATH = ASSET_ROOT / "tests" / "prompt-cases" / "cases.json"
if (WORKFLOW_ROOT / ".agents" / "skills").exists():
    SKILLS_ROOT = WORKFLOW_ROOT / ".agents" / "skills"
    INSTRUCTION_PATH = WORKFLOW_ROOT / "AGENTS.md"
    REQUIRE_OPENAI_YAML = True
elif (WORKFLOW_ROOT / ".claude" / "skills").exists():
    SKILLS_ROOT = WORKFLOW_ROOT / ".claude" / "skills"
    INSTRUCTION_PATH = WORKFLOW_ROOT / "CLAUDE.md"
    REQUIRE_OPENAI_YAML = False
else:
    SKILLS_ROOT = WORKFLOW_ROOT / ".agents" / "skills"
    INSTRUCTION_PATH = WORKFLOW_ROOT / "AGENTS.md"
    REQUIRE_OPENAI_YAML = True

VALID_ROUTES = {"0→1 产品", "产品变更", "维护执行"}
VALID_RISKS = {"R0", "R1", "R2", "待定"}
VALID_STATUSES = {
    "continue",
    "needs-input",
    "blocked",
    "interrupted",
    "observe",
    "pending",
}
REQUIRED_CATEGORIES = {
    "routing",
    "questioning",
    "visual-routing",
    "review-convergence",
    "interruption-recovery",
    "evolution",
    "release-boundary",
    "scope-reconciliation",
    "batch-review",
    "risk-calibration",
    "docs-lifecycle",
    "plan-sizing",
}
REQUIRED_AGENT_HEADINGS = {
    "# Identity",
    "# Goals",
    "# Decision flow",
    "# Instructions",
    "# Output contracts",
    "# Boundaries",
    "# Examples",
    "# Runtime context",
}
REQUIRED_SKILL_HEADINGS = {
    "## Purpose",
    "## Trigger",
    "## Required context",
    "## Workflow",
    "## Output",
    "## Stop or escalate",
    "## References",
}
EXAMPLE_REQUIRED_SKILLS = {
    "bug-fixer",
    "goal-writer",
    "product-spec-builder",
    "reviewer",
    "self-evolver",
}


def load_json(path: Path) -> Dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SystemExit("无法读取 JSON {}: {}".format(path, exc))


def extract_frontmatter_name(text: str) -> str:
    match = re.search(r"(?m)^name:\s*([^\s]+)\s*$", text)
    return match.group(1) if match else ""


def extract_yaml_scalar(text: str, key: str) -> str:
    match = re.search(
        r"(?m)^\s*{}:\s*[\"'](.*)[\"']\s*$".format(re.escape(key)), text
    )
    return match.group(1) if match else ""


def validate_cases(data: Dict, errors: List[str]) -> List[Dict]:
    if data.get("schema_version") != 1:
        errors.append("cases.json schema_version 必须为 1")
    cases = data.get("cases")
    if not isinstance(cases, list) or not cases:
        errors.append("cases.json 必须包含非空 cases 列表")
        return []

    ids = set()
    known_skills = {
        path.name for path in SKILLS_ROOT.iterdir() if path.is_dir()
    } if SKILLS_ROOT.exists() else set()
    categories = set()
    for index, case in enumerate(cases):
        prefix = "cases[{}]".format(index)
        case_id = case.get("id")
        if not case_id or case_id in ids:
            errors.append("{} id 缺失或重复: {!r}".format(prefix, case_id))
        ids.add(case_id)
        categories.add(case.get("category"))
        if not case.get("input") or not case.get("rationale"):
            errors.append("{} 必须包含 input 和 rationale".format(prefix))

        expected = case.get("expected", {})
        if expected.get("route") not in VALID_ROUTES:
            errors.append("{} route 不合法".format(prefix))
        if expected.get("risk") not in VALID_RISKS:
            errors.append("{} risk 不合法".format(prefix))
        if expected.get("status") not in VALID_STATUSES:
            errors.append("{} status 不合法".format(prefix))
        if expected.get("primary_skill") not in known_skills:
            errors.append(
                "{} primary_skill 不属于已发现 Skill: {!r}".format(
                    prefix, expected.get("primary_skill")
                )
            )
        question_min = expected.get("question_min")
        question_max = expected.get("question_max")
        if not isinstance(question_min, int) or not isinstance(question_max, int):
            errors.append("{} question_min/question_max 必须为整数".format(prefix))
        elif question_min < 0 or question_max < question_min or question_max > 2:
            errors.append("{} 追问范围必须满足 0 <= min <= max <= 2".format(prefix))
        if not isinstance(expected.get("escalation"), bool):
            errors.append("{} escalation 必须为布尔值".format(prefix))
        if "max_new_reviewers" in expected:
            value = expected["max_new_reviewers"]
            if not isinstance(value, int) or value < 0 or value > 1:
                errors.append("{} max_new_reviewers 必须为 0 或 1".format(prefix))
        if "deferred" in expected:
            if not isinstance(expected["deferred"], bool):
                errors.append("{} deferred 必须为布尔值".format(prefix))

        for field, allowed in (("plan_kind", {"none", "task", "phase"}), ("doc_action", {"none", "reuse", "update-current", "migrate"}), ("batch_action", {"prune-closed", "reset-empty", "retain-open"})):
            if field in expected and expected[field] not in allowed:
                errors.append("{} {} 不合法".format(prefix, field))

    missing_categories = sorted(REQUIRED_CATEGORIES - categories)
    if missing_categories:
        errors.append("用例缺少类别: {}".format(", ".join(missing_categories)))
    return cases


def validate_prompt_sources(errors: List[str]) -> None:
    agents_text = INSTRUCTION_PATH.read_text(encoding="utf-8")
    agents_headings = {line.strip() for line in agents_text.splitlines()}
    missing = sorted(REQUIRED_AGENT_HEADINGS - agents_headings)
    if missing:
        errors.append("AGENTS.md 缺少统一章节: {}".format(", ".join(missing)))
    # Validate assets and navigable references, not a magic phrase proving behavior.
    for relative in ("references/workflow-contract.md", "references/docs-migration-1.5.md", "scripts/check_docs.py"):
        if not (ASSET_ROOT / relative).is_file():
            errors.append("缺少运行时资产: " + relative)

    skill_names = []
    for skill_dir in sorted(path for path in SKILLS_ROOT.iterdir() if path.is_dir()):
        skill_path = skill_dir / "SKILL.md"
        if not skill_path.exists():
            continue
        text = skill_path.read_text(encoding="utf-8")
        name = extract_frontmatter_name(text)
        skill_names.append(name)
        if name != skill_dir.name:
            errors.append("{} frontmatter name 与目录不一致".format(skill_dir.name))
        headings = {line.strip() for line in text.splitlines()}
        missing_headings = sorted(REQUIRED_SKILL_HEADINGS - headings)
        if missing_headings:
            errors.append(
                "{} 缺少统一章节: {}".format(
                    skill_dir.name, ", ".join(missing_headings)
                )
            )
        if "references/stage-contract.md" not in text:
            errors.append("{} 未直接引用 stage-contract.md".format(skill_dir.name))

        contract_path = skill_dir / "references" / "stage-contract.md"
        if not contract_path.exists():
            errors.append("{} 缺少 references/stage-contract.md".format(skill_dir.name))
        elif skill_dir.name in EXAMPLE_REQUIRED_SKILLS:
            contract_text = contract_path.read_text(encoding="utf-8")
            if "## Examples" not in contract_text:
                errors.append("{} stage-contract 缺少 ## Examples".format(skill_dir.name))

        yaml_path = skill_dir / "agents" / "openai.yaml"
        if REQUIRE_OPENAI_YAML and not yaml_path.exists():
            errors.append("{} 缺少 agents/openai.yaml".format(skill_dir.name))
        elif REQUIRE_OPENAI_YAML:
            yaml_text = yaml_path.read_text(encoding="utf-8")
            short_description = extract_yaml_scalar(yaml_text, "short_description")
            default_prompt = extract_yaml_scalar(yaml_text, "default_prompt")
            if not 25 <= len(short_description) <= 64:
                errors.append(
                    "{} short_description 长度必须为 25..64，实际 {}".format(
                        skill_dir.name, len(short_description)
                    )
                )
            if "$" + skill_dir.name not in default_prompt:
                errors.append("{} default_prompt 未显式引用 Skill".format(skill_dir.name))
            if not default_prompt or "\n" in default_prompt:
                errors.append("{} default_prompt 必须为单行非空提示".format(skill_dir.name))

    sources = [INSTRUCTION_PATH] + list(SKILLS_ROOT.rglob("*.md")) + list((ASSET_ROOT / "references").glob("*.md"))
    for source in sources:
        for target in markdown_links(source.read_text(encoding="utf-8")):
            url = urlsplit(target)
            if url.scheme or url.netloc or not url.path:
                continue
            resolved = source.parent / unquote(url.path)
            if not contained(WORKFLOW_ROOT, resolved) or not resolved.exists():
                errors.append("无效本地引用: {} -> {}".format(source.relative_to(WORKFLOW_ROOT), target))

    if len(skill_names) != len(set(skill_names)):
        errors.append("Skill frontmatter name 存在重复")


def evaluate_responses(
    cases: List[Dict], path: Path, errors: List[str], allow_partial: bool
) -> int:
    data = load_json(path)
    responses = data.get("responses")
    if not isinstance(responses, list):
        errors.append("响应文件必须包含 responses 列表")
        return 0

    case_map = {case["id"]: case for case in cases}
    seen = set()
    for response in responses:
        case_id = response.get("case_id")
        if case_id not in case_map:
            errors.append("响应包含未知 case_id: {!r}".format(case_id))
            continue
        if case_id in seen:
            errors.append("响应 case_id 重复: {}".format(case_id))
            continue
        seen.add(case_id)
        expected = case_map[case_id]["expected"]
        for field in ("route", "risk", "primary_skill", "escalation", "status", "plan_kind", "doc_action", "batch_action"):
            if field not in expected:
                continue
            if response.get(field) != expected.get(field):
                errors.append(
                    "{} {} 不匹配: expected={!r}, actual={!r}".format(
                        case_id, field, expected.get(field), response.get(field)
                    )
                )
        question_count = response.get("question_count")
        if not isinstance(question_count, int) or not (
            expected["question_min"] <= question_count <= expected["question_max"]
        ):
            errors.append(
                "{} question_count 不在 {}..{}".format(
                    case_id, expected["question_min"], expected["question_max"]
                )
            )
        if "max_new_reviewers" in expected:
            actual = response.get("new_reviewers")
            if (
                not isinstance(actual, int)
                or actual < 0
                or actual > expected["max_new_reviewers"]
            ):
                errors.append(
                    "{} new_reviewers 超过上限 {}: {!r}".format(
                        case_id, expected["max_new_reviewers"], actual
                    )
                )
        if "deferred" in expected and response.get("deferred") != expected["deferred"]:
            errors.append(
                "{} deferred 不匹配: expected={!r}, actual={!r}".format(
                    case_id, expected["deferred"], response.get("deferred")
                )
            )
    if not allow_partial:
        missing = sorted(set(case_map) - seen)
        if missing:
            errors.append(
                "响应未覆盖全部用例；缺少 {} 个: {}".format(
                    len(missing), ", ".join(missing)
                )
            )
    return len(seen)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--responses", type=Path, help="结构化 Agent 响应 JSON")
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="仅用于探索性抽样；允许响应不覆盖全部用例",
    )
    args = parser.parse_args()

    errors = []
    cases = validate_cases(load_json(CASES_PATH), errors)
    validate_prompt_sources(errors)
    evaluated = 0
    if args.responses:
        evaluated = evaluate_responses(
            cases, args.responses, errors, args.allow_partial
        )

    if errors:
        print("Prompt 契约验证失败:")
        for error in errors:
            print("- " + error)
        return 1

    print("Prompt 契约验证通过: {} 个行为用例".format(len(cases)))
    if args.responses:
        print("Agent 响应字段评分通过: {} 个响应；实际文件行为须另行核验".format(evaluated))
    else:
        print("未提供 responses；本次仅验证用例和 Prompt 结构。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
