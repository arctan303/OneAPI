#!/usr/bin/env python3
"""Read-only Markdown inventory and migration-state validation; no semantic migration."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

DOCS_SCHEMA = 1
ACTIONS = {"keep", "update", "split", "merge", "archive", "pending"}


def contained(root, path):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def local_file(root, value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("expected a non-empty repository-relative POSIX path")
    if value.startswith("/") or urlsplit(value).scheme:
        raise ValueError("absolute paths and URLs are not allowed")
    path = root / value
    if not contained(root, path):
        raise ValueError("path leaves repository")
    return path


def markdown_links(text):
    # Exclude examples in fenced/inline code. File links only; fragments are not validated.
    text = re.sub(r"(?ms)^\s*(`{3,}|~{3,})[^\n]*\n.*?^\s*\1\s*$", "", text)
    text = re.sub(r"`+[^`\n]*`+", "", text)
    for match in re.finditer(r"\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+)(?:\s+\"[^\"]*\")?)\)", text):
        yield match.group(1) or match.group(2)
    for match in re.finditer(r"(?m)^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))", text):
        yield match.group(1) or match.group(2)


def inspect(root, require_complete=False):
    root = Path(root).resolve()
    report = {"root": str(root), "status": "unregistered", "documents": [],
              "warnings": [], "errors": [], "limitations": [
                  "file links only; fragments, product semantics and historical completeness require review"]}
    errors = report["errors"]
    if not root.is_dir():
        errors.append("repository root does not exist")
        return report
    state_path = root / ".creator" / "docs-state.json"
    state = None
    if not contained(root, state_path):
        errors.append("docs-state path leaves repository")
    elif state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8-sig"))
            if not isinstance(state, dict):
                raise ValueError("state must be an object")
        except (OSError, UnicodeError, ValueError) as exc:
            errors.append("invalid docs-state: " + str(exc))
            state = None
    elif require_complete:
        errors.append("docs-state is missing; installation does not prove migration")

    extra_files = []
    if state is not None:
        report["status"] = state.get("status")
        for key in ("schema_version", "docs_schema_version"):
            if type(state.get(key)) is not int or state[key] != DOCS_SCHEMA:
                errors.append("unsupported " + key)
        if state.get("status") not in ("pending", "partial", "complete"):
            errors.append("invalid migration status")
        if not isinstance(state.get("workflow_version"), str) or not re.fullmatch(r"\d+\.\d+\.\d+", state["workflow_version"]):
            errors.append("workflow_version must be semantic version, not installation date")
        entries = state.get("entrypoints")
        if not isinstance(entries, dict):
            errors.append("entrypoints must be an object")
            entries = {}
        for key, value in entries.items():
            try:
                path = local_file(root, value)
                if not path.is_file():
                    raise ValueError("file is missing")
                extra_files.append(path)
            except (ValueError, OSError) as exc:
                errors.append("entrypoint {}: {}".format(key, exc))
        mappings = state.get("mappings")
        if not isinstance(mappings, list):
            errors.append("mappings must be a list")
            mappings = []
        for index, item in enumerate(mappings):
            try:
                if not isinstance(item, dict):
                    raise ValueError("mapping must be an object")
                local_file(root, item.get("source"))  # source may have been moved
                action = item.get("action")
                if action not in ACTIONS:
                    raise ValueError("invalid action")
                targets = item.get("targets")
                if not isinstance(targets, list) or (not targets and action != "pending"):
                    raise ValueError("targets must be a list, non-empty except for pending")
                if not isinstance(item.get("reason"), str) or not item["reason"].strip():
                    raise ValueError("reason is required")
                if state.get("status") == "complete" and action == "pending":
                    raise ValueError("complete state contains pending mapping")
                for value in targets:
                    path = local_file(root, value)
                    if not path.is_file():
                        raise ValueError("missing target: " + value)
                    extra_files.append(path)
            except (ValueError, OSError, TypeError) as exc:
                errors.append("mapping {}: {}".format(index, exc))
        pending = state.get("pending")
        if not isinstance(pending, list) or any(not isinstance(x, str) for x in pending):
            errors.append("pending must be a list of strings")
        if state.get("status") == "complete":
            if pending != []:
                errors.append("complete state must have no pending items")
            if not entries.get("context"):
                errors.append("complete state requires context entrypoint")
            if not isinstance(state.get("verified_at"), str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", state["verified_at"]):
                errors.append("complete state requires verified_at date")
            evidence = state.get("evidence")
            if not isinstance(evidence, list) or not evidence or any(not isinstance(x, str) or not x.strip() for x in evidence):
                errors.append("complete state requires evidence descriptions")
        if require_complete and state.get("status") != "complete":
            errors.append("docs migration is not complete")

    docs = root / "docs"
    paths = set(extra_files)
    if not contained(root, docs):
        errors.append("docs directory leaves repository")
    elif docs.exists():
        paths.update(docs.rglob("*.md"))
    for path in sorted(paths):
        if not contained(root, path):
            errors.append("document leaves repository: " + str(path))
            continue
        if path.suffix.lower() != ".md":
            continue
        rel = path.relative_to(root).as_posix()
        try:
            raw = path.read_bytes()
            text = raw.decode("utf-8-sig")
        except (OSError, UnicodeError) as exc:
            errors.append("cannot read {}: {}".format(rel, exc))
            continue
        lines = text.splitlines()
        size = {"path": rel, "bytes": len(raw), "lines": len(lines),
                "longest_line": max((len(line) for line in lines), default=0)}
        report["documents"].append(size)
        context = (state or {}).get("entrypoints", {})
        is_context = isinstance(context, dict) and context.get("context") == rel
        if len(raw) > (8192 if is_context else 20480) or len(lines) > (150 if is_context else 300) or size["longest_line"] > 500:
            report["warnings"].append("consider splitting or reducing density: " + rel)
        for target in markdown_links(text):
            try:
                url = urlsplit(target)
                if url.scheme or url.netloc or not url.path:
                    continue
                name = unquote(url.path)
                dest = root / name.lstrip("/") if name.startswith("/") else path.parent / name
                if not contained(root, dest):
                    raise ValueError("link leaves repository")
                if not dest.exists():
                    raise ValueError("missing file link")
            except (ValueError, OSError) as exc:
                errors.append("{} -> {}: {}".format(rel, target, exc))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()
    result = inspect(args.root, args.require_complete)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
