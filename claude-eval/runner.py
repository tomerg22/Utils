from __future__ import annotations

import json
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

from config import MODEL, PERMISSION_MODE, GEN_TIMEOUT_SEC


class ClaudeCallError(RuntimeError):
    pass


def run_claude(
    prompt: str,
    cwd: Optional[Path] = None,
    timeout: int = GEN_TIMEOUT_SEC,
    extra_args: Optional[list[str]] = None,
    model: Optional[str] = None,
) -> dict:
    cmd = [
        "claude",
        "-p",
        "--model", model or MODEL,
        "--permission-mode", PERMISSION_MODE,
        "--output-format", "json",
    ]
    if extra_args:
        cmd.extend(extra_args)
    cmd.append(prompt)

    started = time.time()
    if cwd is None:
        cwd = Path(tempfile.mkdtemp(prefix="claude_eval_"))

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            text=True,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        return {
            "ok": False,
            "error": "timeout",
            "elapsed_sec": timeout,
            "stdout": (e.stdout or "") if isinstance(e.stdout, str) else "",
            "stderr": (e.stderr or "") if isinstance(e.stderr, str) else "",
            "cwd": str(cwd),
        }

    elapsed = time.time() - started

    stdout = (proc.stdout or "").strip()
    payload = None
    if stdout:
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError:
            payload = None

    if payload and payload.get("is_error"):
        status = payload.get("api_error_status")
        err_text = (payload.get("result") or "")[:200]
        return {
            "ok": False,
            "error": f"api_error_{status}",
            "elapsed_sec": elapsed,
            "api_error_status": status,
            "api_error_text": err_text,
            "payload": payload,
            "cwd": str(cwd),
        }

    if proc.returncode != 0:
        return {
            "ok": False,
            "error": f"exit_{proc.returncode}",
            "elapsed_sec": elapsed,
            "stdout": stdout,
            "stderr": proc.stderr,
            "cwd": str(cwd),
        }

    if payload is None:
        return {
            "ok": False,
            "error": "non_json_output",
            "elapsed_sec": elapsed,
            "stdout": stdout,
            "stderr": proc.stderr,
            "cwd": str(cwd),
        }

    return {
        "ok": True,
        "elapsed_sec": elapsed,
        "result": payload.get("result", ""),
        "cost_usd": payload.get("total_cost_usd", 0.0),
        "num_turns": payload.get("num_turns", 0),
        "session_id": payload.get("session_id"),
        "cwd": str(cwd),
        "raw_payload": payload,
    }
