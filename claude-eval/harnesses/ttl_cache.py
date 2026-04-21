import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import find_class, run_and_report, main


def runner(mod):
    name, TTL = find_class(mod, ["TTLCache", "TtlCache"])
    if not TTL:
        print('{"passed": 0, "total": 1, "failures": [{"error": "no class found"}]}')
        return

    def case_basic():
        c = TTL(10)
        c.put("a", 1)
        assert c.get("a") == 1

    def case_expiry():
        c = TTL(0.1)
        c.put("a", 1)
        time.sleep(0.2)
        assert c.get("a") is None

    def case_negative_ttl_raises():
        c = TTL(10)
        try:
            c.put("x", 1, ttl=-1)
        except ValueError:
            return
        raise AssertionError("expected ValueError on negative ttl")

    def case_ttl_zero_expires_immediately():
        c = TTL(10)
        c.put("x", 1, ttl=0)
        assert c.get("x") is None

    def case_get_does_not_extend():
        c = TTL(0.15)
        c.put("a", 1)
        time.sleep(0.08)
        _ = c.get("a")
        time.sleep(0.12)
        assert c.get("a") is None

    def case_get_with_ttl():
        c = TTL(1.0)
        c.put("a", 1, ttl=0.5)
        got = c.get_with_ttl("a")
        assert got is not None, "expected tuple"
        val, remaining = got
        assert val == 1
        assert 0.0 < remaining <= 0.5 + 0.05

    def case_get_with_ttl_missing():
        c = TTL(1.0)
        assert c.get_with_ttl("nope") is None

    def case_cleanup_returns_count():
        c = TTL(0.1)
        c.put("a", 1)
        c.put("b", 2, ttl=10)
        c.put("c", 3)
        time.sleep(0.2)
        n = c.cleanup()
        assert n == 2, f"expected 2 expired, got {n}"
        assert c.get("b") == 2
        assert c.size() == 1

    def case_size_counts_before_cleanup():
        c = TTL(10)
        c.put("a", 1); c.put("b", 2); c.put("c", 3)
        assert c.size() == 3

    cases = [
        case_basic, case_expiry, case_negative_ttl_raises,
        case_ttl_zero_expires_immediately, case_get_does_not_extend,
        case_get_with_ttl, case_get_with_ttl_missing,
        case_cleanup_returns_count, case_size_counts_before_cleanup,
    ]

    def check(c):
        c()

    run_and_report(cases, check)


if __name__ == "__main__":
    main(runner)
