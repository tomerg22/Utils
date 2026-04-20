#!/usr/bin/env python3
"""
quick_claude_cli_eval.py

Local Claude CLI coding evaluator using `claude -p`.

What this version adds:
- Clean per-run isolation with a generated run_id
- CSV and JSONL rows tagged by run_id
- Optional overwrite mode to start fresh
- Execution results distinguish:
    - passed
    - partial_or_failed
    - harness_failed
    - no_code_block
    - timeout
- Averages only include valid execution runs
- Clear end-of-run summary:
    - valid execution tests
    - passed valid tests
    - inconclusive tests
- Stronger v2 suite with algorithmic, parsing, and stateful tasks

Defaults:
- Uses local Claude login (non-bare)
- Uses model: claude-opus-4-7

Examples:
  python quick_claude_cli_eval.py
  python quick_claude_cli_eval.py --overwrite
  python quick_claude_cli_eval.py --model claude-opus-4-7
  python quick_claude_cli_eval.py --out claude_cli_eval_results.csv --full-out claude_eval_full.jsonl
  python quick_claude_cli_eval.py --bare
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


# ----------------------------
# Test definitions
# ----------------------------

@dataclass
class TestCase:
    name: str
    prompt: str
    expected_signals: List[str]
    bad_signals: List[str]
    language: str = "python"
    exec_mode: Optional[str] = None
    ask_for_code_only: bool = True


TESTS = [
    TestCase(
        name="interval_merge",
        prompt=(
            "Write a Python function that merges overlapping intervals.\n"
            "Requirements:\n"
            "- Input: list[tuple[int, int]]\n"
            "- Return merged intervals sorted by start\n"
            "- Include tests\n"
            "- Briefly explain edge cases handled\n"
        ),
        expected_signals=["empty", "single", "overlap", "sorted", "assert"],
        bad_signals=["class Solution", "leetcode"],
        exec_mode="interval_merge",
    ),
    TestCase(
        name="bugfix_two_sum",
        prompt=(
            "Fix this Python function and explain the bug:\n\n"
            "def two_sum(nums, target):\n"
            "    for i in range(len(nums)):\n"
            "        for j in range(i+1, len(nums)):\n"
            "            if nums[i] + nums[j] == target:\n"
            "                return i\n\n"
            "Then provide a better O(n) version.\n"
            "Requirements:\n"
            "- Return the two indices as a list or tuple\n"
            "- Return None if no solution exists\n"
            "- Include runnable asserts\n"
        ),
        expected_signals=["return", "index", "hash", "dictionary", "o(n)"],
        bad_signals=["works as is"],
        exec_mode="two_sum",
    ),
    TestCase(
        name="lru_cache",
        prompt=(
            "Implement an LRU cache in Python with O(1) get and put.\n"
            "Requirements:\n"
            "- Class name should be LRUCache\n"
            "- Constructor takes capacity\n"
            "- get(key) returns the value if present, otherwise -1\n"
            "- put(key, value) inserts/updates and evicts least recently used when needed\n"
            "- Include runnable asserts\n"
            "- Briefly explain how it works\n"
        ),
        expected_signals=["doubly", "linked", "hash", "o(1)", "get", "put"],
        bad_signals=["o(n)"],
        exec_mode="lru_cache",
    ),
    TestCase(
        name="topological_sort_cycle_detection",
        prompt=(
            "Write a Python function topological_sort(num_nodes, edges) that returns a valid topological ordering.\n"
            "Requirements:\n"
            "- Nodes are integers from 0 to num_nodes-1\n"
            "- edges is a list of (u, v) meaning u -> v\n"
            "- Return a list of all nodes in valid topological order\n"
            "- If the graph has a cycle, return None\n"
            "- Include runnable asserts\n"
            "- Briefly explain the approach and complexity\n"
        ),
        expected_signals=["queue", "indegree", "cycle", "o(", "assert"],
        bad_signals=["dfs only", "leetcode"],
        exec_mode="topological_sort",
    ),
    TestCase(
        name="log_parser_malformed_lines",
        prompt=(
            "Write a Python function parse_logs(lines) that parses application log lines.\n"
            "Requirements:\n"
            "- Each valid line has the format: 'TIMESTAMP LEVEL MESSAGE'\n"
            "- TIMESTAMP has no spaces, LEVEL is one token, MESSAGE is the rest of the line\n"
            "- TIMESTAMP should resemble a real timestamp, not arbitrary text\n"
            "- LEVEL should be uppercase alphabetic such as INFO, WARN, ERROR, DEBUG\n"
            "- Return a list of dicts with keys: timestamp, level, message\n"
            "- Ignore malformed lines gracefully\n"
            "- Accept leading spaces or tabs before TIMESTAMP by treating them as ignorable prefix whitespace\n"
            "- Preserve original message spacing except leading separator spaces\n"
            "- Include runnable asserts covering malformed lines\n"
            "- Briefly explain edge cases handled\n"
        ),
        expected_signals=["malformed", "ignore", "split", "assert", "edge"],
        bad_signals=["regex only", "raise ValueError"],
        exec_mode="log_parser",
    ),
    TestCase(
        name="ttl_cache",
        prompt=(
            "Implement a small in-memory TTL cache in Python.\n"
            "Requirements:\n"
            "- Class name: TTLCache\n"
            "- Constructor takes default_ttl_seconds\n"
            "- Methods: put(key, value, ttl=None), get(key), cleanup()\n"
            "- Expired keys should not be returned\n"
            "- Use time.time() for current time\n"
            "- Include runnable asserts\n"
            "- Briefly explain tradeoffs\n"
        ),
        expected_signals=["ttl", "expire", "time", "cleanup", "assert"],
        bad_signals=["threading", "asyncio"],
        exec_mode="ttl_cache",
    ),
    TestCase(
        name="rate_limiter",
        prompt=(
            "Implement a simple fixed-window rate limiter in Python.\n"
            "Requirements:\n"
            "- Class name: RateLimiter\n"
            "- Constructor takes limit and window_seconds\n"
            "- Method: allow(key) -> bool\n"
            "- A key may be allowed at most `limit` times per window\n"
            "- After the window expires, requests should be allowed again\n"
            "- Use time.time() for current time\n"
            "- Include runnable asserts\n"
            "- Briefly explain tradeoffs\n"
        ),
        expected_signals=["window", "limit", "time", "allow", "assert"],
        bad_signals=["threading", "asyncio"],
        exec_mode="rate_limiter",
    ),
]


# ----------------------------
# Claude CLI invocation
# ----------------------------

def which_claude() -> str:
    path = shutil.which("claude")
    if not path:
        raise SystemExit(
            "Could not find `claude` on PATH.\n"
            "Make sure Claude Code CLI is installed and available."
        )
    return path


def build_eval_prompt(test: TestCase) -> str:
    base = test.prompt.strip()
    if test.ask_for_code_only:
        return (
            f"{base}\n\n"
            "Output requirements:\n"
            "- Return Python code in a single markdown code block\n"
            "- Keep any explanation brief\n"
            "- Do not include multiple alternative implementations unless asked\n"
        )
    return base


def call_claude_cli(
    prompt: str,
    model: Optional[str],
    use_bare: bool,
    timeout: int,
    cwd: Optional[str] = None,
) -> str:
    claude_bin = which_claude()
    cmd = [claude_bin]

    if use_bare:
        cmd.append("--bare")

    if model:
        cmd.extend(["--model", model])

    cmd.extend(["-p", prompt])

    proc = subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        capture_output=True,
        timeout=timeout,
    )

    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        hint = ""

        if use_bare and not os.environ.get("ANTHROPIC_API_KEY"):
            hint = (
                "\n\nHint: --bare disables your normal login."
                "\nSet ANTHROPIC_API_KEY or run without --bare."
            )

        raise RuntimeError(
            "Claude CLI failed.\n"
            f"Command: {' '.join(cmd)}\n"
            f"Exit code: {proc.returncode}\n"
            f"STDERR:\n{stderr}{hint}"
        )

    return proc.stdout.strip()


# ----------------------------
# Heuristic scoring
# ----------------------------

def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def extract_code_blocks(text: str) -> List[Tuple[str, str]]:
    pattern = re.compile(r"```([a-zA-Z0-9_+-]*)\n(.*?)```", re.DOTALL)
    return [(lang.strip().lower(), code) for lang, code in pattern.findall(text)]


def best_python_code_block(text: str) -> Optional[str]:
    blocks = extract_code_blocks(text)
    if not blocks:
        return None

    pythonish = [code for lang, code in blocks if lang in {"python", "py", ""}]
    if pythonish:
        return max(pythonish, key=len)

    return max((code for _, code in blocks), key=len, default=None)


def count_asserts_in_code(code: str) -> int:
    return len(re.findall(r"(?m)^\s*assert\b", code))


def score_response_heuristic(test: TestCase, response: str) -> Dict[str, Any]:
    text = normalize(response)
    code = best_python_code_block(response)
    if code:
        code = sanitize_candidate_code(code) or ""
    else:
        code = ""

    expected_hits = sum(1 for s in test.expected_signals if s in text)
    bad_hits = sum(1 for s in test.bad_signals if s in text)

    has_code_block = "```" in response
    assert_count = count_asserts_in_code(code)
    has_any_assert = assert_count >= 1
    has_real_tests = assert_count >= 2
    word_count = len(response.split())
    reasonable_length = 20 <= word_count <= 1600

    code_lower = code.lower()
    code_lines = [line for line in code.splitlines() if line.strip()]
    non_comment_code_lines = [
        line for line in code_lines
        if not line.lstrip().startswith("#")
    ]
    code_size_ok = len(non_comment_code_lines) >= 6

    structural_signals = 0
    if test.exec_mode in {"interval_merge", "two_sum", "topological_sort", "log_parser"}:
        if re.search(r"(?m)^\s*def\s+\w+\s*\(", code):
            structural_signals += 1
    if test.exec_mode in {"lru_cache", "ttl_cache", "rate_limiter"}:
        if re.search(r"(?m)^\s*class\s+\w+\s*[:\(]", code):
            structural_signals += 1

    if test.exec_mode == "two_sum" and (
        "dict" in code_lower or "{}" in code or "seen" in code_lower or "lookup" in code_lower
    ):
        structural_signals += 1
    if test.exec_mode == "interval_merge" and (
        "sort(" in code_lower or "sorted(" in code_lower or "append(" in code_lower
    ):
        structural_signals += 1
    if test.exec_mode == "lru_cache" and (
        "get(" in code_lower and "put(" in code_lower
    ):
        structural_signals += 1
    if test.exec_mode == "ttl_cache" and all(tok in code_lower for tok in ["put(", "get(", "cleanup("]):
        structural_signals += 1
    if test.exec_mode == "rate_limiter" and "allow(" in code_lower:
        structural_signals += 1
    if test.exec_mode == "log_parser" and (
        "split(" in code_lower or "parse_logs" in code_lower or "timestamp" in code_lower
    ):
        structural_signals += 1
    if test.exec_mode == "topological_sort" and (
        "indegree" in code_lower or "deque" in code_lower or "queue" in code_lower
    ):
        structural_signals += 1

    explanation_hits = expected_hits

    score = 0.0
    score += 38.0 if has_code_block else 0.0
    score += 20.0 if code_size_ok else 0.0
    score += 10.0 if has_any_assert else 0.0
    score += 8.0 if has_real_tests else 0.0
    score += 16.0 if reasonable_length else 0.0
    score += min(structural_signals, 2) * 9.0
    score += min(explanation_hits, 3) * 3.0
    score -= min(bad_hits, 3) * 6.0

    heuristic_score = max(0.0, min(score, 100.0))

    if has_code_block and code_size_ok and min(structural_signals, 2) >= 1:
        heuristic_score = max(heuristic_score, 72.0)
    if has_real_tests and min(structural_signals, 2) >= 2:
        heuristic_score = max(heuristic_score, 80.0)
    if has_real_tests and min(structural_signals, 2) >= 2 and code_size_ok and reasonable_length:
        heuristic_score = max(heuristic_score, 85.0)

    return {
        "heuristic_score": round(min(100.0, heuristic_score), 1),
        "expected_hits": expected_hits,
        "bad_hits": bad_hits,
        "has_code_block": has_code_block,
        "assert_count": assert_count,
        "has_real_tests": has_real_tests,
        "word_count": word_count,
        "structural_signals": structural_signals,
        "non_comment_code_lines": len(non_comment_code_lines),
    }


# ----------------------------
# Minimal execution sandbox
# ----------------------------

def run_python_code_safely(script: str, timeout: int = 10) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="claude_eval_") as tmpdir:
        script_path = os.path.join(tmpdir, "candidate_eval.py")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script)

        proc = subprocess.run(
            [sys.executable, "-I", script_path],
            text=True,
            capture_output=True,
            timeout=timeout,
            cwd=tmpdir,
            env={},
        )

        return {
            "returncode": proc.returncode,
            "stdout": (proc.stdout or "").strip(),
            "stderr": (proc.stderr or "").strip(),
        }


# ----------------------------
# Execution harnesses
# ----------------------------

def build_interval_merge_harness(candidate_code: str) -> str:
    return f"""
import json

{candidate_code}

def _find_merge_callable():
    preferred = ["merge_intervals", "merge", "merge_overlapping_intervals", "merge_ranges"]
    for name in preferred:
        obj = globals().get(name)
        if callable(obj):
            return name, obj

    callables = []
    for name, obj in globals().items():
        if callable(obj) and not name.startswith("_"):
            callables.append((name, obj))

    if not callables:
        raise RuntimeError("No callable found for interval merge")

    return callables[0]

name, fn = _find_merge_callable()

cases = [
    ([], []),
    ([(1, 3)], [(1, 3)]),
    ([(1, 3), (2, 6), (8, 10), (15, 18)], [(1, 6), (8, 10), (15, 18)]),
    ([(1, 4), (4, 5)], [(1, 5)]),
    ([(5, 7), (1, 2), (2, 4)], [(1, 4), (5, 7)]),
    ([(1, 10), (2, 3), (4, 8)], [(1, 10)]),
]

passed = 0
failures = []

def _norm(x):
    return [tuple(i) for i in x]

for idx, (inp, expected) in enumerate(cases):
    try:
        got = fn(inp)
        got = _norm(got)
        expected = _norm(expected)
        assert got == expected, f"input={{inp}} expected={{expected}} got={{got}}"
        passed += 1
    except Exception as e:
        failures.append({{"case_index": idx, "error": str(e)}})

print(json.dumps({{
    "passed": passed,
    "total": len(cases),
    "function": name,
    "failures": failures
}}))
"""


def build_two_sum_harness(candidate_code: str) -> str:
    return f"""
import json

{candidate_code}

def _candidate_functions():
    preferred = ["two_sum", "twoSum", "two_sum_fixed"]
    funcs = []
    for name in preferred:
        obj = globals().get(name)
        if callable(obj):
            funcs.append((name, obj))

    for name, obj in globals().items():
        if callable(obj) and "two_sum" in name.lower() and (name, obj) not in funcs:
            funcs.append((name, obj))

    for name, obj in globals().items():
        if callable(obj) and not name.startswith("_") and (name, obj) not in funcs:
            funcs.append((name, obj))

    return funcs

cases = [
    (([2, 7, 11, 15], 9), True),
    (([3, 2, 4], 6), True),
    (([3, 3], 6), True),
    (([-1, -2, -3, -4, -5], -8), True),
    (([1, 2, 3], 7), False),
]

funcs = _candidate_functions()
if not funcs:
    raise RuntimeError("No callable found for two_sum")

results = []

for fname, fn in funcs:
    passed = 0
    failures = []

    for idx, ((nums, target), has_solution) in enumerate(cases):
        try:
            got = fn(nums, target)

            if not has_solution:
                assert got is None, f"expected None for no-solution case, got {{got}}"
                passed += 1
                continue

            assert isinstance(got, (list, tuple)), f"expected pair list/tuple, got {{type(got).__name__}}"
            assert len(got) == 2, f"expected 2 indices, got {{got}}"
            i, j = got
            assert isinstance(i, int) and isinstance(j, int), f"indices must be ints: {{got}}"
            assert i != j, f"indices must differ: {{got}}"
            assert 0 <= i < len(nums) and 0 <= j < len(nums), f"indices out of range: {{got}}"
            assert nums[i] + nums[j] == target, f"wrong pair {{got}} for nums={{nums}} target={{target}}"

            passed += 1
        except Exception as e:
            failures.append({{"case_index": idx, "error": str(e)}})

    results.append({{
        "function": fname,
        "passed": passed,
        "total": len(cases),
        "failures": failures
    }})

best = max(results, key=lambda r: r["passed"])
print(json.dumps({{
    "passed": best["passed"],
    "total": best["total"],
    "function": best["function"],
    "failures": best["failures"],
    "all_results": results
}}))
"""


def build_lru_cache_harness(candidate_code: str) -> str:
    return f"""
import json

{candidate_code}

def _find_lru_class():
    obj = globals().get("LRUCache")
    if isinstance(obj, type):
        return "LRUCache", obj

    for name, obj in globals().items():
        if isinstance(obj, type) and "lru" in name.lower():
            return name, obj

    for name, obj in globals().items():
        if isinstance(obj, type) and not name.startswith("_"):
            return name, obj

    raise RuntimeError("No class found for LRU cache")

name, LRU = _find_lru_class()

def case_1():
    c = LRU(2)
    c.put(1, 1)
    c.put(2, 2)
    assert c.get(1) == 1
    c.put(3, 3)
    assert c.get(2) == -1
    c.put(4, 4)
    assert c.get(1) == -1
    assert c.get(3) == 3
    assert c.get(4) == 4

def case_2():
    c = LRU(1)
    c.put(10, 20)
    assert c.get(10) == 20
    c.put(30, 40)
    assert c.get(10) == -1
    assert c.get(30) == 40

def case_3():
    c = LRU(2)
    c.put(1, 1)
    c.put(2, 2)
    c.put(1, 10)
    c.put(3, 3)
    assert c.get(1) == 10
    assert c.get(2) == -1
    assert c.get(3) == 3

cases = [case_1, case_2, case_3]
passed = 0
failures = []

for idx, case in enumerate(cases):
    try:
        case()
        passed += 1
    except Exception as e:
        failures.append({{"case_index": idx, "error": str(e)}})

print(json.dumps({{
    "passed": passed,
    "total": len(cases),
    "class": name,
    "failures": failures
}}))
"""


def build_topological_sort_harness(candidate_code: str) -> str:
    return f"""
import json

{candidate_code}

def _find_callable():
    preferred = ["topological_sort", "toposort", "topo_sort"]
    for name in preferred:
        obj = globals().get(name)
        if callable(obj):
            return name, obj
    for name, obj in globals().items():
        if callable(obj) and "top" in name.lower() and "sort" in name.lower():
            return name, obj
    for name, obj in globals().items():
        if callable(obj) and not name.startswith("_"):
            return name, obj
    raise RuntimeError("No callable found for topological_sort")

name, fn = _find_callable()

def is_valid_topo(order, num_nodes, edges):
    if not isinstance(order, list):
        return False
    if len(order) != num_nodes:
        return False
    if set(order) != set(range(num_nodes)):
        return False
    pos = {{node: i for i, node in enumerate(order)}}
    return all(pos[u] < pos[v] for u, v in edges)

cases = [
    (4, [(0,1),(0,2),(1,3),(2,3)], "valid"),
    (3, [], "valid"),
    (3, [(0,1),(1,2)], "valid"),
    (3, [(0,1),(1,2),(2,0)], "cycle"),
    (4, [(0,1),(2,3)], "valid"),
]

passed = 0
failures = []

for idx, (n, edges, expected) in enumerate(cases):
    try:
        got = fn(n, edges)
        if expected == "cycle":
            assert got is None, f"expected None for cycle, got {{got}}"
        else:
            assert is_valid_topo(got, n, edges), f"invalid topological order: {{got}}"
        passed += 1
    except Exception as e:
        failures.append({{"case_index": idx, "error": str(e)}})

print(json.dumps({{
    "passed": passed,
    "total": len(cases),
    "function": name,
    "failures": failures
}}))
"""


def build_log_parser_harness(candidate_code: str) -> str:
    return f"""
import json

{candidate_code}

def _find_callable():
    preferred = ["parse_logs", "parse_log_lines", "parse"]
    for name in preferred:
        obj = globals().get(name)
        if callable(obj):
            return name, obj
    for name, obj in globals().items():
        if callable(obj) and "parse" in name.lower():
            return name, obj
    for name, obj in globals().items():
        if callable(obj) and not name.startswith("_"):
            return name, obj
    raise RuntimeError("No callable found for parse_logs")

name, fn = _find_callable()

cases = [
    (
        [
            "2026-01-01T10:00:00Z INFO service started",
            "2026-01-01T10:00:01Z ERROR disk full",
        ],
        [
            {{"timestamp": "2026-01-01T10:00:00Z", "level": "INFO", "message": "service started"}},
            {{"timestamp": "2026-01-01T10:00:01Z", "level": "ERROR", "message": "disk full"}},
        ],
    ),
    (
        [
            "bad line",
            "malformed line without level",
            "",
            "2026-01-01T10:00:02Z WARN extra spaces kept",
            "2026-01-01T10:00:03Z DEBUG x",
            None,
        ],
        [
            {{"timestamp": "2026-01-01T10:00:02Z", "level": "WARN", "message": "extra spaces kept"}},
            {{"timestamp": "2026-01-01T10:00:03Z", "level": "DEBUG", "message": "x"}},
        ],
    ),
    (
        [
            "maybe malformed",
            "2026-01-01T10:00:07Z WARN usable message",
        ],
        [
            {{"timestamp": "2026-01-01T10:00:07Z", "level": "WARN", "message": "usable message"}},
        ],
    ),
]

def _normalize(records):
    assert isinstance(records, list), f"expected list, got {{type(records).__name__}}"
    out = []
    for i, rec in enumerate(records):
        assert isinstance(rec, dict), f"record {{i}} is not a dict: {{type(rec).__name__}}"
        out.append({{
            "timestamp": rec.get("timestamp"),
            "level": rec.get("level"),
            "message": rec.get("message"),
        }})
    return out

passed = 0
failures = []

for idx, (lines, expected) in enumerate(cases):
    try:
        got = _normalize(fn(lines))
        assert got == expected, f"expected {{expected}}, got {{got}}"
        passed += 1
    except Exception as e:
        failures.append({{"case_index": idx, "error": str(e)}})

print(json.dumps({{
    "passed": passed,
    "total": len(cases),
    "function": name,
    "failures": failures
}}))
"""


def build_ttl_cache_harness(candidate_code: str) -> str:
    return f"""
import json

{candidate_code}

def _find_class():
    obj = globals().get("TTLCache")
    if isinstance(obj, type):
        return "TTLCache", obj
    for name, obj in globals().items():
        if isinstance(obj, type) and "ttl" in name.lower() and "cache" in name.lower():
            return name, obj
    for name, obj in globals().items():
        if isinstance(obj, type) and not name.startswith("_"):
            return name, obj
    raise RuntimeError("No TTLCache class found")

name, TTL = _find_class()

passed = 0
failures = []

try:
    c = TTL(10)
    c.put("a", 1)
    assert c.get("a") == 1
    passed += 1
except Exception as e:
    failures.append({{"case_index": 0, "error": str(e)}})

try:
    fake_now = [1000.0]
    _orig_time = __import__("time").time
    __import__("time").time = lambda: fake_now[0]
    try:
        c = TTL(5)
        c.put("x", 10)
        assert c.get("x") == 10
        fake_now[0] = 1006.0
        assert c.get("x") is None, "expired key should not be returned"
        passed += 1
    finally:
        __import__("time").time = _orig_time
except Exception as e:
    failures.append({{"case_index": 1, "error": str(e)}})

try:
    fake_now = [2000.0]
    _orig_time = __import__("time").time
    __import__("time").time = lambda: fake_now[0]
    try:
        c = TTL(100)
        c.put("a", 1, ttl=1)
        c.put("b", 2, ttl=50)
        fake_now[0] = 2002.0
        c.cleanup()
        assert c.get("a") is None
        assert c.get("b") == 2
        passed += 1
    finally:
        __import__("time").time = _orig_time
except Exception as e:
    failures.append({{"case_index": 2, "error": str(e)}})

print(json.dumps({{
    "passed": passed,
    "total": 3,
    "class": name,
    "failures": failures
}}))
"""


def build_rate_limiter_harness(candidate_code: str) -> str:
    return f"""
import json

{candidate_code}

def _find_class():
    obj = globals().get("RateLimiter")
    if isinstance(obj, type):
        return "RateLimiter", obj
    for name, obj in globals().items():
        if isinstance(obj, type) and "rate" in name.lower() and "limit" in name.lower():
            return name, obj
    for name, obj in globals().items():
        if isinstance(obj, type) and not name.startswith("_"):
            return name, obj
    raise RuntimeError("No RateLimiter class found")

name, RateLimiter = _find_class()

passed = 0
failures = []

try:
    fake_now = [1000.0]
    _orig_time = __import__("time").time
    __import__("time").time = lambda: fake_now[0]
    try:
        rl = RateLimiter(limit=2, window_seconds=10)

        assert rl.allow("a") is True
        assert rl.allow("a") is True
        assert rl.allow("a") is False

        passed += 1
    finally:
        __import__("time").time = _orig_time
except Exception as e:
    failures.append({{"case_index": 0, "error": str(e)}})

try:
    fake_now = [2000.0]
    _orig_time = __import__("time").time
    __import__("time").time = lambda: fake_now[0]
    try:
        rl = RateLimiter(limit=2, window_seconds=5)

        assert rl.allow("x") is True
        assert rl.allow("x") is True
        assert rl.allow("x") is False

        fake_now[0] = 2005.1
        assert rl.allow("x") is True

        passed += 1
    finally:
        __import__("time").time = _orig_time
except Exception as e:
    failures.append({{"case_index": 1, "error": str(e)}})

try:
    fake_now = [3000.0]
    _orig_time = __import__("time").time
    __import__("time").time = lambda: fake_now[0]
    try:
        rl = RateLimiter(limit=1, window_seconds=10)

        assert rl.allow("u1") is True
        assert rl.allow("u1") is False
        assert rl.allow("u2") is True
        assert rl.allow("u2") is False

        passed += 1
    finally:
        __import__("time").time = _orig_time
except Exception as e:
    failures.append({{"case_index": 2, "error": str(e)}})

print(json.dumps({{
    "passed": passed,
    "total": 3,
    "class": name,
    "failures": failures
}}))
"""

def build_exec_harness(exec_mode: str, candidate_code: str) -> str:
    if exec_mode == "interval_merge":
        return build_interval_merge_harness(candidate_code)
    if exec_mode == "two_sum":
        return build_two_sum_harness(candidate_code)
    if exec_mode == "lru_cache":
        return build_lru_cache_harness(candidate_code)
    if exec_mode == "topological_sort":
        return build_topological_sort_harness(candidate_code)
    if exec_mode == "log_parser":
        return build_log_parser_harness(candidate_code)
    if exec_mode == "ttl_cache":
        return build_ttl_cache_harness(candidate_code)
    if exec_mode == "rate_limiter":
        return build_rate_limiter_harness(candidate_code)
    raise ValueError(f"Unknown exec_mode: {exec_mode}")


# ----------------------------
# Execution scoring
# ----------------------------



def sanitize_candidate_code(code: str) -> str:
    lines = code.splitlines()
    future_lines = []
    body_lines = []

    for line in lines:
        if line.strip().startswith("from __future__ import "):
            future_lines.append(line)
        else:
            body_lines.append(line)

    sanitized: List[str] = []
    skip_main_block = False
    main_indent = 0

    for line in body_lines:
        stripped = line.strip()
        indent = len(line) - len(line.lstrip(" "))

        if skip_main_block:
            if stripped and indent <= main_indent:
                skip_main_block = False
            else:
                continue

        if re.match(r'^\s*if\s+__name__\s*==\s*["\']__main__["\']\s*:\s*$', line):
            skip_main_block = True
            main_indent = indent
            continue

        if indent == 0 and stripped.startswith("assert "):
            continue

        sanitized.append(line)

    if future_lines:
        return "\n".join(future_lines + ([""] if sanitized else []) + sanitized)
    return "\n".join(sanitized)
def score_response_execution(test, response: str) -> Dict[str, Any]:
    code = best_python_code_block(response) or ""
    if not code.strip():
        return {
            "execution_score": None,
            "exec_cases_passed": 0,
            "exec_cases_total": 0,
            "exec_valid": False,
            "exec_passed": False,
            "exec_reason": "no_code_block",
            "failures": [],
        }

    code = sanitize_candidate_code(code)
    harness = build_exec_harness(test.exec_mode, code)

    result = run_python_code_safely(harness, timeout=10)
    stdout = (result.get("stdout") or "").strip()
    stderr = (result.get("stderr") or "").strip()
    returncode = int(result.get("returncode", 1))

    if returncode != 0:
        return {
            "execution_score": None,
            "exec_cases_passed": 0,
            "exec_cases_total": 0,
            "exec_valid": False,
            "exec_passed": False,
            "exec_reason": "harness_failed",
            "failures": [],
            "stdout": stdout,
            "stderr": stderr,
            "error": stderr or stdout or f"subprocess exited with code {returncode}",
        }

    try:
        stdout_lines = [line for line in stdout.splitlines() if line.strip()]
        payload_text = stdout_lines[-1] if stdout_lines else ""
        payload = json.loads(payload_text)
    except Exception as e:
        return {
            "execution_score": None,
            "exec_cases_passed": 0,
            "exec_cases_total": 0,
            "exec_valid": False,
            "exec_passed": False,
            "exec_reason": "bad_harness_output",
            "failures": [],
            "stdout": stdout,
            "stderr": stderr,
            "error": f"Failed to parse harness JSON from last stdout line: {e}",
        }

    passed = int(payload.get("passed", 0))
    total = int(payload.get("total", 0))
    score = round((passed / total) * 100, 1) if total else None

    out = {
        "execution_score": score,
        "exec_cases_passed": passed,
        "exec_cases_total": total,
        "exec_valid": True,
        "exec_passed": total > 0 and passed == total,
        "exec_reason": "passed" if total > 0 and passed == total else "partial_or_failed",
        "failures": payload.get("failures", []),
    }

    for k in ("function", "class", "all_results"):
        if k in payload:
            out[k] = payload[k]
    if stdout:
        out["stdout"] = stdout
    if stderr:
        out["stderr"] = stderr

    return out


def combine_scores(
    heuristic_score: float,
    execution_score: Optional[float],
    exec_valid: bool,
    has_execution: bool,
) -> float:
    if has_execution and exec_valid and execution_score is not None:
        return round((0.35 * heuristic_score) + (0.65 * execution_score), 1)
    return round(heuristic_score, 1)


# ----------------------------
# Output helpers
# ----------------------------

CSV_FIELDNAMES = [
    "run_id",
    "timestamp",
    "model",
    "test_name",
    "combined_score",
    "heuristic_score",
    "execution_score",
    "exec_passed",
    "exec_valid",
    "exec_reason",
    "exec_cases_passed",
    "exec_cases_total",
    "expected_hits",
    "bad_hits",
    "assert_count",
    "word_count",
]

def initialize_output_file(path: str, fieldnames: List[str], overwrite: bool) -> None:
    if not path:
        return
    if overwrite or not os.path.exists(path):
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()


def append_csv(path: str, rows: List[Dict[str, Any]]) -> None:
    if not path:
        return
    exists = os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDNAMES)
        if not exists:
            writer.writeheader()
        writer.writerows(rows)


def initialize_jsonl(path: str, overwrite: bool) -> None:
    if not path:
        return
    if overwrite or not os.path.exists(path):
        with open(path, "w", encoding="utf-8"):
            pass


def append_jsonl(path: str, rows: List[Dict[str, Any]]) -> None:
    if not path:
        return
    with open(path, "a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def format_execution_line(execution: Dict[str, Any]) -> str:
    if not execution["exec_valid"]:
        return f"N/A ({execution['exec_reason']})"
    return (
        f"{execution['execution_score']} "
        f"(passed={execution['exec_cases_passed']}/{execution['exec_cases_total']})"
    )


def print_test_result(name: str, heuristic: Dict[str, Any], execution: Dict[str, Any], combined: float) -> None:
    print(f"→ {name}")
    print(f"  heuristic: {heuristic['heuristic_score']}")
    print(f"  execution: {format_execution_line(execution)}")
    if not execution["exec_valid"]:
        detail = execution.get("error") or execution.get("stderr") or execution.get("stdout")
        if detail:
            lines = [line for line in str(detail).splitlines() if line.strip()]
            preview = " | ".join(lines[:3])[:400]
            print(f"    detail : {preview}")
    print(f"  combined : {combined}")


# ----------------------------
# Main
# ----------------------------

# Defensive aliases for local-edit / stale-buffer issues.
# If the helper definitions above are present, these assignments are no-ops.
initialize_output_file = globals().get("initialize_output_file")
append_csv = globals().get("append_csv")
initialize_jsonl = globals().get("initialize_jsonl")
append_jsonl = globals().get("append_jsonl")

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate local Claude CLI coding quality with heuristic + execution scoring."
    )
    parser.add_argument(
        "--model",
        default="claude-opus-4-7",
        help="Claude model name (default: claude-opus-4-7)",
    )
    parser.add_argument(
        "--bare",
        action="store_true",
        help="Use Claude bare mode. Requires ANTHROPIC_API_KEY or other explicit bare-mode auth.",
    )
    parser.add_argument(
        "--out",
        default="claude_cli_eval_results.csv",
        help="Summary CSV output path",
    )
    parser.add_argument(
        "--full-out",
        default="claude_eval_full.jsonl",
        help="Optional JSONL file for full prompts, responses, and diagnostics",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite output files at the start of the run instead of appending",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=180,
        help="Timeout in seconds per Claude request",
    )
    args = parser.parse_args()

    run_id = uuid.uuid4().hex[:12]
    timestamp = datetime.now(timezone.utc).isoformat()

    if args.out:
        initialize_output_file(args.out, CSV_FIELDNAMES, args.overwrite)
    if args.full_out:
        initialize_jsonl(args.full_out, args.overwrite)

    print(f"Running eval on model: {args.model}")
    print("Mode: bare" if args.bare else "Mode: normal local login")
    print(f"Run ID: {run_id}")
    print()

    csv_rows: List[Dict[str, Any]] = []
    full_rows: List[Dict[str, Any]] = []

    combined_total = 0.0
    heuristic_total = 0.0
    valid_execution_total = 0.0

    valid_execution_tests = 0
    passed_valid_execution_tests = 0
    inconclusive_tests = 0

    for test in TESTS:
        eval_prompt = build_eval_prompt(test)
        response = call_claude_cli(
            prompt=eval_prompt,
            model=args.model,
            use_bare=args.bare,
            timeout=args.timeout,
        )

        heuristic = score_response_heuristic(test, response)
        execution = score_response_execution(test, response)
        combined = combine_scores(
            heuristic_score=heuristic["heuristic_score"],
            execution_score=execution["execution_score"],
            exec_valid=execution["exec_valid"],
            has_execution=test.exec_mode is not None,
        )

        heuristic_total += heuristic["heuristic_score"]
        combined_total += combined

        if execution["exec_valid"]:
            valid_execution_tests += 1
            assert execution["execution_score"] is not None
            valid_execution_total += execution["execution_score"]
            if execution["exec_passed"]:
                passed_valid_execution_tests += 1
        else:
            inconclusive_tests += 1

        print_test_result(test.name, heuristic, execution, combined)

        csv_rows.append({
            "run_id": run_id,
            "timestamp": timestamp,
            "model": args.model,
            "test_name": test.name,
            "combined_score": combined,
            "heuristic_score": heuristic["heuristic_score"],
            "execution_score": execution["execution_score"],
            "exec_passed": execution["exec_passed"],
            "exec_valid": execution["exec_valid"],
            "exec_reason": execution["exec_reason"],
            "exec_cases_passed": execution["exec_cases_passed"],
            "exec_cases_total": execution["exec_cases_total"],
            "expected_hits": heuristic["expected_hits"],
            "bad_hits": heuristic["bad_hits"],
            "assert_count": heuristic["assert_count"],
            "word_count": heuristic["word_count"],
        })

        full_rows.append({
            "run_id": run_id,
            "timestamp": timestamp,
            "model": args.model,
            "test_name": test.name,
            "prompt": eval_prompt,
            "response": response,
            "heuristic": heuristic,
            "execution": execution,
            "combined_score": combined,
        })

    append_csv(args.out, csv_rows)
    append_jsonl(args.full_out, full_rows)

    n = len(TESTS)
    avg_heuristic = round(heuristic_total / n, 1)
    avg_combined = round(combined_total / n, 1)
    avg_execution_valid_only = (
        round(valid_execution_total / valid_execution_tests, 1)
        if valid_execution_tests > 0
        else None
    )

    print("\n---")
    print(f"Average heuristic score      : {avg_heuristic}")
    if avg_execution_valid_only is None:
        print("Average execution score      : N/A")
    else:
        print(f"Average execution score      : {avg_execution_valid_only} (valid tests only)")
    print(f"Average combined score       : {avg_combined}")
    print(f"Valid execution tests        : {valid_execution_tests}/{n}")
    print(f"Passed valid execution tests : {passed_valid_execution_tests}/{valid_execution_tests}")
    print(f"Inconclusive tests           : {inconclusive_tests}")
    if args.out:
        print(f"Saved summary to             : {args.out}")
    if args.full_out:
        print(f"Saved full results to        : {args.full_out}")
    print(f"Run ID                       : {run_id}")


if __name__ == "__main__":
    main()

