import importlib.util
import json
import sys
import traceback
from typing import Callable


def load_solution(path: str):
    spec = importlib.util.spec_from_file_location("solution", path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        return None, f"import_failed: {type(e).__name__}: {e}"
    return mod, None


def find_callable(mod, preferred_names: list[str]):
    for n in preferred_names:
        obj = getattr(mod, n, None)
        if callable(obj):
            return n, obj
    for n in dir(mod):
        if n.startswith("_"):
            continue
        obj = getattr(mod, n, None)
        if callable(obj):
            return n, obj
    return None, None


def find_class(mod, preferred_names: list[str]):
    for n in preferred_names:
        obj = getattr(mod, n, None)
        if isinstance(obj, type):
            return n, obj
    for n in dir(mod):
        if n.startswith("_"):
            continue
        obj = getattr(mod, n, None)
        if isinstance(obj, type):
            return n, obj
    return None, None


def run_and_report(cases: list, check: Callable):
    passed = 0
    failures = []
    for i, c in enumerate(cases):
        try:
            check(c)
            passed += 1
        except Exception as e:
            failures.append({"case": i, "error": f"{type(e).__name__}: {e}"[:300]})
    print(json.dumps({"passed": passed, "total": len(cases), "failures": failures}))


def main(runner: Callable[[object], None]):
    if len(sys.argv) < 2:
        print(json.dumps({"passed": 0, "total": 0, "failures": [{"error": "no solution path"}]}))
        sys.exit(1)

    mod, err = load_solution(sys.argv[1])
    if err:
        print(json.dumps({"passed": 0, "total": 1, "failures": [{"error": err}]}))
        return

    try:
        runner(mod)
    except Exception as e:
        print(json.dumps({
            "passed": 0, "total": 1,
            "failures": [{"error": f"harness_crash: {type(e).__name__}: {e}"[:400]}],
            "trace": traceback.format_exc()[:500],
        }))
