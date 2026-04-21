from __future__ import annotations

import yaml
from pathlib import Path

from config import TASKS_DIR, HARNESSES_DIR


def load_tasks(task_names: list[str] | None = None) -> list[dict]:
    tasks = []
    files = sorted(TASKS_DIR.glob("*.yaml"))
    for f in files:
        spec = yaml.safe_load(f.read_text())
        if task_names and spec["name"] not in task_names:
            continue
        harness_path = HARNESSES_DIR / f"{spec['name']}.py"
        if not harness_path.exists():
            raise FileNotFoundError(f"Missing harness for task {spec['name']}: {harness_path}")
        spec["harness_path"] = str(harness_path)
        tasks.append(spec)
    return tasks
