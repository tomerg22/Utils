import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import find_callable, run_and_report, main


def runner(mod):
    name, fn = find_callable(mod, ["two_sum", "twoSum", "two_sum_fixed"])
    if not fn:
        print('{"passed": 0, "total": 1, "failures": [{"error": "no callable found"}]}')
        return

    cases = [
        {"nums": [2, 7, 11, 15], "target": 9, "has_solution": True},
        {"nums": [3, 2, 4], "target": 6, "has_solution": True},
        {"nums": [3, 3], "target": 6, "has_solution": True},
        {"nums": [-1, -2, -3, -4, -5], "target": -8, "has_solution": True},
        {"nums": [1, 2, 3], "target": 7, "has_solution": False},
        {"nums": [], "target": 0, "has_solution": False},
        {"nums": [1], "target": 2, "has_solution": False},
    ]

    def check(c):
        got = fn(list(c["nums"]), c["target"])
        if not c["has_solution"]:
            assert got is None, f"expected None, got {got}"
            return
        assert isinstance(got, (list, tuple)) and len(got) == 2, f"bad shape {got!r}"
        i, j = got
        assert isinstance(i, int) and isinstance(j, int), f"non-int indices {got!r}"
        assert i != j, f"duplicate indices {got!r}"
        n = len(c["nums"])
        assert 0 <= i < n and 0 <= j < n, f"out-of-range {got!r}"
        assert c["nums"][i] + c["nums"][j] == c["target"], (
            f"wrong pair {got!r} for {c['nums']}"
        )

    run_and_report(cases, check)


if __name__ == "__main__":
    main(runner)
