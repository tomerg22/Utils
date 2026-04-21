from __future__ import annotations

import json
import re
from typing import Optional

from runner import run_claude
from config import JUDGE_TIMEOUT_SEC, JUDGE_MODEL


JUDGE_SYSTEM = (
    "You are an EXACTING code-review judge. Score a candidate answer against a "
    "rubric. For each rubric point, it is HIT only if the candidate explicitly "
    "and concretely addresses it — not merely implies it, not merely mentions the "
    "topic. Evidence must be a specific sentence or code pattern. If the point "
    "is about complexity, the exact big-O must appear (e.g. 'O(log n)'). If the "
    "point names a technique, the technique name must appear (e.g. 'lazy "
    "propagation', 'Kahn's algorithm'). A point is MISSED if the evidence is "
    "vague, hand-wavy, or inferred. Default to MISSED when uncertain. Respond "
    "with a single JSON object and nothing else."
)


def _build_judge_prompt(task_prompt: str, response: str, rubric: list[str]) -> str:
    rubric_lines = "\n".join(f"- {p}" for p in rubric)
    return (
        f"{JUDGE_SYSTEM}\n\n"
        f"TASK GIVEN TO CANDIDATE:\n{task_prompt}\n\n"
        f"CANDIDATE RESPONSE:\n<<<\n{response}\n>>>\n\n"
        f"RUBRIC POINTS (each either hit or missed):\n{rubric_lines}\n\n"
        f"Return JSON only, matching this schema exactly:\n"
        f'{{"points_hit": ["<rubric_point_key>", ...], '
        f'"points_missed": ["<rubric_point_key>", ...], '
        f'"notes": "<=200 chars terse justification"}}\n'
        f"Keys in points_hit and points_missed MUST be drawn from the rubric above. "
        f"Together they must cover every rubric point exactly once."
    )


JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_judge_output(text: str) -> Optional[dict]:
    if not text:
        return None
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass
    m = JSON_OBJECT_RE.search(text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def judge_reasoning(task_prompt: str, response: str, rubric: list[str]) -> dict:
    if not response or not response.strip():
        return {
            "score": 0.0,
            "points_hit": [],
            "points_missed": list(rubric),
            "notes": "empty response",
            "ok": False,
        }

    prompt = _build_judge_prompt(task_prompt, response, rubric)
    result = run_claude(prompt, timeout=JUDGE_TIMEOUT_SEC, model=JUDGE_MODEL)

    if not result["ok"]:
        return {
            "score": 0.0,
            "points_hit": [],
            "points_missed": list(rubric),
            "notes": f"judge_call_failed:{result.get('error')}",
            "ok": False,
            "raw": result,
        }

    parsed = _parse_judge_output(result.get("result", ""))
    if not parsed or not isinstance(parsed, dict):
        return {
            "score": 0.0,
            "points_hit": [],
            "points_missed": list(rubric),
            "notes": "judge_json_parse_failed",
            "ok": False,
            "raw_text": result.get("result", ""),
        }

    hit = [p for p in parsed.get("points_hit", []) if p in rubric]
    missed = [p for p in rubric if p not in hit]
    score = 100.0 * len(hit) / len(rubric) if rubric else 0.0

    return {
        "score": round(score, 1),
        "points_hit": hit,
        "points_missed": missed,
        "notes": (parsed.get("notes") or "")[:200],
        "ok": True,
        "cost_usd": result.get("cost_usd", 0.0),
    }
