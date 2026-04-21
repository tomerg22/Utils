from pathlib import Path

ROOT = Path(__file__).resolve().parent
TASKS_DIR = ROOT / "tasks"
HARNESSES_DIR = ROOT / "harnesses"
LOGS_DIR = ROOT / "logs"
RAW_LOGS_DIR = LOGS_DIR / "raw"
EVENTS_PATH = LOGS_DIR / "events.jsonl"
REPORTS_DIR = ROOT / "reports"
STATE_DIR = ROOT / "state"
METHODOLOGY_PATH = STATE_DIR / "methodology.json"

MODEL = "claude-opus-4-7[1m]"
JUDGE_MODEL = "haiku"
EDITOR_MODEL = "sonnet"
PERMISSION_MODE = "bypassPermissions"

N_SAMPLES = 2
MAX_WORKERS = 6
GEN_TIMEOUT_SEC = 240
JUDGE_TIMEOUT_SEC = 120
HARNESS_TIMEOUT_SEC = 15

W_CORRECTNESS = 0.7
W_REASONING = 0.3

MIN_ITERATIONS = 5
MAX_ITERATIONS = 20
STABILITY_STDEV_THRESHOLD = 3.0
CONVERGENCE_MEAN_DELTA = 2.0

for d in (LOGS_DIR, RAW_LOGS_DIR, REPORTS_DIR, STATE_DIR):
    d.mkdir(parents=True, exist_ok=True)
