from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from config import (
    ROOT, RAW_LOGS_DIR, REPORTS_DIR, EVENTS_PATH, METHODOLOGY_PATH,
    N_SAMPLES, MAX_WORKERS, HARNESS_TIMEOUT_SEC, MAX_ITERATIONS,
)
from runner import run_claude
from judge import judge_reasoning
from scorer import extract_python_code, combine_scores, mean, stdev
from tasks import load_tasks
from iterate import (
    init_methodology, load_methodology, save_methodology,
)


def log_event(event: dict):
    event["t"] = time.time()
    with open(EVENTS_PATH, "a") as f:
        f.write(json.dumps(event) + "\n")


def run_harness(harness_path: str, solution_path: str) -> dict:
    try:
        proc = subprocess.run(
            [sys.executable, harness_path, solution_path],
            capture_output=True, text=True, timeout=HARNESS_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired:
        return {"passed": 0, "total": 1, "failures": [{"error": "harness_timeout"}]}

    out = proc.stdout.strip().splitlines()
    for line in reversed(out):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return {
        "passed": 0, "total": 1,
        "failures": [{"error": "no_json_from_harness", "stderr": proc.stderr[:300]}],
    }


def execute_sample(task: dict, iter_num: int, sample_idx: int) -> dict:
    raw_dir = RAW_LOGS_DIR / f"iter_{iter_num}"
    raw_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{task['name']}.s{sample_idx}"

    gen_cwd = Path(tempfile.mkdtemp(prefix=f"claude_eval_{task['name']}_"))
    t0 = time.time()
    gen = run_claude(task["prompt"], cwd=gen_cwd)

    (raw_dir / f"{stem}.gen.json").write_text(json.dumps(gen, default=str, indent=2))

    if not gen["ok"]:
        log_event({"iter": iter_num, "task": task["name"], "sample": sample_idx,
                   "phase": "gen", "ok": False, "error": gen.get("error")})
        return {
            "task": task["name"], "sample": sample_idx,
            "correctness": 0.0, "reasoning": 0.0, "combined": 0.0,
            "gen_ok": False, "error": gen.get("error", "unknown"),
            "gen_elapsed": time.time() - t0,
        }

    response = gen.get("result", "")
    code = extract_python_code(response)

    if not code:
        correctness = 0.0
        harness_out = {"passed": 0, "total": 1, "failures": [{"error": "no_code_block"}]}
    else:
        sol_path = gen_cwd / "solution.py"
        sol_path.write_text(code)
        harness_out = run_harness(task["harness_path"], str(sol_path))
        total = max(1, harness_out.get("total", 0))
        correctness = 100.0 * harness_out.get("passed", 0) / total

    (raw_dir / f"{stem}.harness.json").write_text(json.dumps(harness_out, indent=2))

    judge = judge_reasoning(task["prompt"], response, task.get("reasoning_rubric", []))
    (raw_dir / f"{stem}.judge.json").write_text(json.dumps(judge, indent=2, default=str))
    reasoning = judge.get("score", 0.0)

    combined = combine_scores(correctness, reasoning)

    log_event({
        "iter": iter_num, "task": task["name"], "sample": sample_idx,
        "correctness": correctness, "reasoning": reasoning, "combined": combined,
        "gen_cost": gen.get("cost_usd", 0.0),
        "judge_cost": judge.get("cost_usd", 0.0),
    })

    return {
        "task": task["name"], "sample": sample_idx,
        "correctness": correctness, "reasoning": reasoning, "combined": combined,
        "gen_ok": True, "passed": harness_out.get("passed", 0),
        "total": harness_out.get("total", 0),
        "judge_ok": judge.get("ok", False),
        "judge_notes": judge.get("notes", ""),
        "gen_elapsed": time.time() - t0,
        "gen_cost": gen.get("cost_usd", 0.0),
        "judge_cost": judge.get("cost_usd", 0.0),
    }


def run_iteration(iter_num: int, tasks: list[dict], methodology: dict) -> dict:
    disabled = set(methodology.get("disabled_tasks", []))
    active_tasks = [t for t in tasks if t["name"] not in disabled]
    weights = methodology.get("weight_overrides", {})

    print(f"\n=== Iteration {iter_num} | methodology v{methodology['version']} "
          f"| {len(active_tasks)} active tasks ===", flush=True)

    jobs = [(t, s) for t in active_tasks for s in range(N_SAMPLES)]
    results: list[dict] = []

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(execute_sample, t, iter_num, s): (t["name"], s) for t, s in jobs}
        done_count = 0
        total_jobs = len(futures)
        for fut in as_completed(futures):
            tname, sidx = futures[fut]
            try:
                r = fut.result()
            except Exception as e:
                r = {
                    "task": tname, "sample": sidx,
                    "correctness": 0.0, "reasoning": 0.0, "combined": 0.0,
                    "gen_ok": False, "error": f"{type(e).__name__}: {e}",
                }
            results.append(r)
            done_count += 1
            print(f"  [{done_count}/{total_jobs}] {tname}#{sidx}  "
                  f"corr={r['correctness']:.0f}  reas={r['reasoning']:.0f}  "
                  f"comb={r['combined']:.1f}", flush=True)

    per_task: dict[str, dict] = {}
    for t in active_tasks:
        samples = [r for r in results if r["task"] == t["name"]]
        if not samples:
            continue
        corr = [s["correctness"] for s in samples]
        reas = [s["reasoning"] for s in samples]
        comb = [s["combined"] for s in samples]
        per_task[t["name"]] = {
            "mean_correctness": round(mean(corr), 1),
            "mean_reasoning": round(mean(reas), 1),
            "mean_combined": round(mean(comb), 1),
            "stdev_combined": round(stdev(comb), 2),
            "weight": weights.get(t["name"], t.get("weight", 1.0)),
            "samples": samples,
        }

    total_weight = sum(d["weight"] for d in per_task.values()) or 1.0
    weighted_score = sum(d["mean_combined"] * d["weight"] for d in per_task.values()) / total_weight

    gen_ok_count = sum(1 for r in results if r.get("gen_ok"))
    gen_ok_ratio = gen_ok_count / max(1, len(results))

    summary = {
        "iteration": iter_num,
        "methodology_version": methodology["version"],
        "active_tasks": [t["name"] for t in active_tasks],
        "disabled_tasks": sorted(disabled),
        "per_task": per_task,
        "iteration_score": round(weighted_score, 2),
        "gen_ok_ratio": round(gen_ok_ratio, 3),
        "gen_ok_count": gen_ok_count,
        "total_samples": len(results),
        "total_cost_usd": sum(
            s.get("gen_cost", 0) + s.get("judge_cost", 0) for s in results
        ),
    }

    write_iteration_report(summary)
    return summary


def write_iteration_report(summary: dict):
    lines = [
        f"# Iteration {summary['iteration']}",
        "",
        f"- Methodology version: {summary['methodology_version']}",
        f"- Active tasks: {len(summary['active_tasks'])}",
        f"- Disabled: {summary['disabled_tasks'] or 'none'}",
        f"- **Iteration score (weighted): {summary['iteration_score']}/100**",
        f"- Healthy samples: {summary['gen_ok_count']}/{summary['total_samples']} "
        f"(gen_ok_ratio={summary['gen_ok_ratio']})",
        f"- Total cost: ${summary['total_cost_usd']:.3f}",
        "",
        "## Per-task",
        "",
        "| task | weight | correctness | reasoning | combined | stdev |",
        "|------|-------:|------------:|----------:|---------:|------:|",
    ]
    for name in sorted(summary["per_task"]):
        d = summary["per_task"][name]
        lines.append(
            f"| {name} | {d['weight']:.2f} | {d['mean_correctness']:.1f} | "
            f"{d['mean_reasoning']:.1f} | {d['mean_combined']:.1f} | {d['stdev_combined']:.2f} |"
        )
    lines.append("")
    lines.append("## Outliers (high stdev)")
    high = [(n, d) for n, d in summary["per_task"].items() if d["stdev_combined"] >= 15]
    if not high:
        lines.append("_none_")
    else:
        for n, d in sorted(high, key=lambda kv: -kv[1]["stdev_combined"]):
            lines.append(f"- {n}: stdev={d['stdev_combined']:.1f}")

    (REPORTS_DIR / f"iteration_{summary['iteration']}.md").write_text("\n".join(lines))


def write_final_report(history: list[dict], stop_reason: str):
    lines = [
        "# Final Report — claude-eval",
        "",
        f"- Iterations run: {len(history)}",
        f"- Stop reason: {stop_reason}",
        "",
        "## Iteration scores",
        "",
        "| iter | methodology_v | score | active_tasks | cost |",
        "|-----:|--------------:|------:|-------------:|-----:|",
    ]
    total_cost = 0.0
    for h in history:
        total_cost += h["total_cost_usd"]
        lines.append(
            f"| {h['iteration']} | {h['methodology_version']} | "
            f"{h['iteration_score']:.2f} | {len(h['active_tasks'])} | "
            f"${h['total_cost_usd']:.2f} |"
        )
    lines.append("")
    lines.append(f"- **Total cost: ${total_cost:.2f}**")
    lines.append("")

    lines.append("## Convergence (ASCII)")
    lines.append("")
    scores = [h["iteration_score"] for h in history]
    if scores:
        lo, hi = min(scores), max(scores)
        span = max(1.0, hi - lo)
        for i, s in enumerate(scores):
            bar = "█" * int((s - lo) / span * 40)
            lines.append(f"  iter{i:02d} {s:6.2f} |{bar}")
    lines.append("")

    lines.append("## Final score")
    lines.append("")
    if len(history) >= 3:
        tail = [h["iteration_score"] for h in history[-3:]]
        lines.append(f"- Mean of last 3 iterations: **{mean(tail):.2f}/100**")
        lines.append(f"- Stdev of last 3: {stdev(tail):.2f}")
    else:
        lines.append(f"- Score: {scores[-1]:.2f}/100 (insufficient iterations for CI)")

    (REPORTS_DIR / "final.md").write_text("\n".join(lines))


def build_methodology_brief(history: list[dict]) -> str:
    parts = []
    for h in history[-3:]:
        parts.append(f"### Iteration {h['iteration']} (score {h['iteration_score']})")
        for name in sorted(h["per_task"]):
            d = h["per_task"][name]
            parts.append(
                f"- {name}: weight={d['weight']:.2f} correct={d['mean_correctness']:.0f} "
                f"reason={d['mean_reasoning']:.0f} comb={d['mean_combined']:.0f} "
                f"stdev={d['stdev_combined']:.1f}"
            )
    return "\n".join(parts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                        help="Run 1 task, 1 sample (fast smoke test)")
    parser.add_argument("--single-task", type=str, default=None,
                        help="Run only the named task (for debugging)")
    parser.add_argument("--run-id", type=str, default=None,
                        help="Tag for this run (default: next integer)")
    args = parser.parse_args()

    all_tasks = load_tasks(
        [args.single_task] if args.single_task else None
    )
    if not all_tasks:
        print("No tasks found", file=sys.stderr)
        sys.exit(1)

    task_names = [t["name"] for t in all_tasks]

    if METHODOLOGY_PATH.exists():
        methodology = load_methodology()
    else:
        methodology = init_methodology(task_names)

    if args.dry_run:
        single = [all_tasks[0]]
        import config as cfg
        cfg.N_SAMPLES = 1
        summary = run_iteration(0, single, methodology)
        write_final_report([summary], "dry_run")
        print(f"\nDry run done. Score: {summary['iteration_score']}")
        return

    existing = sorted(REPORTS_DIR.glob("iteration_*.md"))
    run_idx = args.run_id if args.run_id else len(existing)
    try:
        run_idx = int(run_idx)
    except (TypeError, ValueError):
        pass

    summary = run_iteration(run_idx, all_tasks, methodology)

    print(f"\n[run {run_idx}] score={summary['iteration_score']:.2f}  "
          f"gen_ok={summary['gen_ok_ratio']:.2f}", flush=True)

    if summary["gen_ok_ratio"] < 0.5:
        print(f"⛔ {summary['gen_ok_count']}/{summary['total_samples']} healthy — "
              f"likely rate limit. Check logs/raw/iter_{run_idx}/")

    write_final_report([summary], f"single_run_{run_idx}")


if __name__ == "__main__":
    main()
