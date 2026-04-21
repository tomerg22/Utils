from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

from config import (
    ROOT, METHODOLOGY_PATH, MIN_ITERATIONS, STABILITY_STDEV_THRESHOLD,
    CONVERGENCE_MEAN_DELTA, EDITOR_MODEL,
)
from runner import run_claude
from scorer import stdev


PROTECTED_FILES = [
    ROOT / "runner.py",
    ROOT / "judge.py",
    ROOT / "scorer.py",
    ROOT / "run.py",
    ROOT / "config.py",
    ROOT / "iterate.py",
    ROOT / "tasks" / "__init__.py",
    ROOT / "harnesses" / "_common.py",
]


def init_methodology(all_task_names: list[str]) -> dict:
    m = {
        "version": 0,
        "active_tasks": list(all_task_names),
        "disabled_tasks": [],
        "weight_overrides": {},
        "history": [],
    }
    METHODOLOGY_PATH.write_text(json.dumps(m, indent=2))
    return m


def load_methodology() -> dict:
    return json.loads(METHODOLOGY_PATH.read_text())


def save_methodology(m: dict):
    METHODOLOGY_PATH.write_text(json.dumps(m, indent=2))


def should_stop(history: list[dict]) -> tuple[bool, str]:
    if len(history) < MIN_ITERATIONS:
        return False, f"min_iterations_not_met ({len(history)}/{MIN_ITERATIONS})"

    recent = history[-3:]
    for h in recent:
        if h.get("gen_ok_ratio", 0) < 0.8:
            return False, f"iter_{h['iteration']}_unhealthy gen_ok_ratio={h.get('gen_ok_ratio'):.2f}"

    scores = [h["iteration_score"] for h in recent]
    sd = stdev(scores)
    if sd >= STABILITY_STDEV_THRESHOLD:
        return False, f"stdev_last3={sd:.2f} >= {STABILITY_STDEV_THRESHOLD}"

    delta = abs(history[-1]["iteration_score"] - history[-2]["iteration_score"])
    if delta >= CONVERGENCE_MEAN_DELTA:
        return False, f"delta={delta:.2f} >= {CONVERGENCE_MEAN_DELTA}"

    return True, f"stable: stdev_last3={sd:.2f}, delta={delta:.2f}"


EDITOR_PROMPT = """You evolve the benchmark suite. Your FIRST tool call MUST be an Edit or Write call — do NOT Read anything first.

Root: {root}

The report below lists tasks with their mean_combined scores. Pick one task at >=95 (saturated, no signal) and make it harder in ONE of these ways:

OPTION A — Tighten the YAML prompt (fastest):
  Use Edit on {root}/tasks/<name>.yaml. Change the `prompt:` block to add ONE stricter requirement like "Solution must use algorithm X" or "Must be O(log n) in-place". That's it.

OPTION B — Add a harder harness case:
  Use Edit on {root}/harnesses/<name>.py. Append 1-2 hard adversarial cases to the existing `cases` list. Do not touch the printing logic.

Pick ONE option. ONE file. ONE Edit call. Then stop.

HARD RULES:
- First tool call = Edit or Write. No Read first.
- Exactly one file edited.
- Do NOT modify: runner.py, judge.py, scorer.py, run.py, config.py, iterate.py, tasks/__init__.py, harnesses/_common.py (auto-reverted).
- Keep YAML keys intact: name, entry_point, weight, prompt, reasoning_rubric.
- Keep harness printing its final JSON line with keys passed, total.

REPORT:
{reports}

Edit one file now. Then output one line: "Changed <filename>: <brief>".
"""


def _file_hashes(paths: list[Path]) -> dict:
    out = {}
    for p in paths:
        if p.exists():
            out[str(p)] = hashlib.sha256(p.read_bytes()).hexdigest()
        else:
            out[str(p)] = None
    return out


def _task_harness_pairs_consistent() -> tuple[bool, list[str]]:
    tasks_dir = ROOT / "tasks"
    harnesses_dir = ROOT / "harnesses"
    task_names = {f.stem for f in tasks_dir.glob("*.yaml")}
    harness_names = {f.stem for f in harnesses_dir.glob("*.py") if f.stem != "_common"}
    missing_harnesses = sorted(task_names - harness_names)
    orphan_harnesses = sorted(harness_names - task_names)
    issues = []
    for n in missing_harnesses:
        issues.append(f"task '{n}' has no harness")
    for n in orphan_harnesses:
        issues.append(f"orphan harness '{n}' has no task")
    return not issues, issues


def evolve_methodology(iter_num: int, reports_text: str) -> dict:
    """Spawn a file-editing Claude agent to improve the suite.

    Returns: {'ok': bool, 'violations': [paths restored], 'issues': [...], 'summary': str}
    """
    protected_snapshot = {p: (p.read_bytes() if p.exists() else None) for p in PROTECTED_FILES}

    tasks_before = _file_hashes(list((ROOT / "tasks").glob("*.yaml")))
    harnesses_before = _file_hashes([
        p for p in (ROOT / "harnesses").glob("*.py") if p.name != "_common.py"
    ])

    prompt = EDITOR_PROMPT.format(root=str(ROOT), reports=reports_text)

    extra = ["--add-dir", str(ROOT)]
    result = run_claude(prompt, cwd=ROOT, timeout=120, extra_args=extra, model=EDITOR_MODEL)

    violations = []
    for p, original in protected_snapshot.items():
        current = p.read_bytes() if p.exists() else None
        if current != original:
            if original is None:
                p.unlink(missing_ok=True)
            else:
                p.write_bytes(original)
            violations.append(str(p))

    ok_consistency, issues = _task_harness_pairs_consistent()

    tasks_after = _file_hashes(list((ROOT / "tasks").glob("*.yaml")))
    harnesses_after = _file_hashes([
        p for p in (ROOT / "harnesses").glob("*.py") if p.name != "_common.py"
    ])

    changed_tasks = sorted(set(tasks_after) ^ set(tasks_before)) + \
        sorted(k for k in tasks_after if k in tasks_before and tasks_after[k] != tasks_before[k])
    changed_harnesses = sorted(set(harnesses_after) ^ set(harnesses_before)) + \
        sorted(k for k in harnesses_after if k in harnesses_before and harnesses_after[k] != harnesses_before[k])

    summary = (result.get("result") or "").strip().splitlines()[-1:]
    summary_text = summary[0][:400] if summary else "(no summary)"

    log_path = ROOT / "state" / f"iter_{iter_num}_editor.json"
    log_path.write_text(json.dumps({
        "iter": iter_num,
        "ok": result["ok"],
        "error": result.get("error"),
        "violations": violations,
        "consistency_ok": ok_consistency,
        "issues": issues,
        "changed_tasks": changed_tasks,
        "changed_harnesses": changed_harnesses,
        "summary": summary_text,
        "cost_usd": result.get("cost_usd", 0.0),
        "elapsed_sec": result.get("elapsed_sec", 0),
        "t": time.time(),
    }, indent=2))

    return {
        "ok": result["ok"] and ok_consistency and not violations,
        "violations": violations,
        "issues": issues,
        "summary": summary_text,
        "changed_tasks": changed_tasks,
        "changed_harnesses": changed_harnesses,
        "editor_error": result.get("error"),
    }


def bump_methodology_version(m: dict, evolution: dict) -> dict:
    m["version"] = m.get("version", 0) + 1
    m.setdefault("history", []).append({
        "version": m["version"],
        "evolution": {
            "changed_tasks": evolution.get("changed_tasks", []),
            "changed_harnesses": evolution.get("changed_harnesses", []),
            "summary": evolution.get("summary", ""),
            "violations": evolution.get("violations", []),
            "issues": evolution.get("issues", []),
        },
    })
    save_methodology(m)
    return m
