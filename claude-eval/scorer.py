import re
import statistics
from typing import Optional

from config import W_CORRECTNESS, W_REASONING


CODE_BLOCK_RE = re.compile(r"```([a-zA-Z0-9_+\-]*)\n(.*?)```", re.DOTALL)


def extract_python_code(text: str) -> Optional[str]:
    blocks = CODE_BLOCK_RE.findall(text or "")
    if not blocks:
        return None
    py = [code for lang, code in blocks if lang.lower() in {"python", "py", ""}]
    pool = py if py else [code for _, code in blocks]
    return max(pool, key=len) if pool else None


def combine_scores(correctness: float, reasoning: float) -> float:
    return W_CORRECTNESS * correctness + W_REASONING * reasoning


def mean(xs):
    return statistics.mean(xs) if xs else 0.0


def stdev(xs):
    return statistics.stdev(xs) if len(xs) > 1 else 0.0
