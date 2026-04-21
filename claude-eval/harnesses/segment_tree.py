import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import find_class, run_and_report, main


def runner(mod):
    name, ST = find_class(mod, ["SegmentTree", "SegTree", "LazySegTree"])
    if not ST:
        print('{"passed": 0, "total": 1, "failures": [{"error": "no class found"}]}')
        return

    def case_build_and_query():
        t = ST([1, 2, 3, 4, 5])
        assert t.query(0, 4) == 15
        assert t.query(0, 0) == 1
        assert t.query(2, 4) == 12
        assert t.query(1, 3) == 9

    def case_single_range_update():
        t = ST([0, 0, 0, 0, 0])
        t.update(1, 3, 5)
        assert t.query(0, 0) == 0
        assert t.query(1, 1) == 5
        assert t.query(2, 2) == 5
        assert t.query(3, 3) == 5
        assert t.query(4, 4) == 0
        assert t.query(0, 4) == 15

    def case_overlapping_updates():
        t = ST([0] * 6)
        t.update(0, 2, 1)
        t.update(1, 4, 2)
        t.update(3, 5, 3)
        assert t.query(0, 0) == 1
        assert t.query(1, 1) == 3
        assert t.query(2, 2) == 3
        assert t.query(3, 3) == 5
        assert t.query(4, 4) == 5
        assert t.query(5, 5) == 3

    def case_point_set_after_lazy():
        t = ST([0] * 5)
        t.update(0, 4, 10)
        t.point_set(2, 0)
        assert t.query(2, 2) == 0
        assert t.query(0, 0) == 10
        assert t.query(0, 4) == 40

    def case_point_set_then_range_update():
        t = ST([0] * 4)
        t.point_set(1, 100)
        t.update(0, 3, 5)
        assert t.query(1, 1) == 105
        assert t.query(0, 3) == 120

    def case_oob_raises():
        t = ST([1, 2, 3])
        raised = 0
        for call in (
            lambda: t.query(-1, 2),
            lambda: t.query(0, 3),
            lambda: t.update(-1, 0, 1),
            lambda: t.point_set(5, 0),
        ):
            try:
                call()
            except IndexError:
                raised += 1
        assert raised == 4, f"expected 4 IndexErrors, got {raised}"

    def case_empty_array():
        t = ST([])
        raised = 0
        for call in (
            lambda: t.query(0, 0),
            lambda: t.update(0, 0, 1),
            lambda: t.point_set(0, 1),
        ):
            try:
                call()
            except IndexError:
                raised += 1
        assert raised == 3, f"expected 3 IndexErrors on empty, got {raised}"

    def case_stress_consistency():
        import random
        random.seed(42)
        n = 50
        arr = [random.randint(-10, 10) for _ in range(n)]
        t = ST(list(arr))
        for _ in range(30):
            op = random.choice(["u", "p", "q"])
            lo = random.randint(0, n - 1)
            hi = random.randint(lo, n - 1)
            if op == "u":
                d = random.randint(-5, 5)
                for i in range(lo, hi + 1):
                    arr[i] += d
                t.update(lo, hi, d)
            elif op == "p":
                v = random.randint(-20, 20)
                arr[lo] = v
                t.point_set(lo, v)
            else:
                want = sum(arr[lo:hi + 1])
                got = t.query(lo, hi)
                assert got == want, f"mismatch lo={lo} hi={hi} want={want} got={got}"

    def case_performance_large():
        import time
        import random
        random.seed(7)
        n = 20000
        t = ST([0] * n)
        ops = 5000
        ranges = [(random.randint(0, n-1), None) for _ in range(ops)]
        ranges = [(a, random.randint(a, n-1)) for a, _ in ranges]
        deltas = [random.randint(-5, 5) for _ in range(ops)]
        start = time.time()
        for (lo, hi), d in zip(ranges, deltas):
            t.update(lo, hi, d)
        for lo, hi in ranges[:1000]:
            _ = t.query(lo, hi)
        elapsed = time.time() - start
        assert elapsed < 3.0, (
            f"too slow: {elapsed:.2f}s for n={n} ops={ops} — "
            f"likely O(n) update instead of O(log n) lazy"
        )

    cases = [
        case_build_and_query, case_single_range_update, case_overlapping_updates,
        case_point_set_after_lazy, case_point_set_then_range_update,
        case_oob_raises, case_empty_array, case_stress_consistency,
        case_performance_large,
    ]

    def check(c):
        c()

    run_and_report(cases, check)


if __name__ == "__main__":
    main(runner)
