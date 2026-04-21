import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import find_callable, run_and_report, main


def _norm(xs):
    return sorted(tuple(i) for i in xs)


def runner(mod):
    name, fn = find_callable(mod, ["merge_intervals", "merge", "merge_ranges"])
    if not fn:
        print('{"passed": 0, "total": 1, "failures": [{"error": "no callable found"}]}')
        return

    cases = [
        ([], []),
        ([(1, 3)], [(1, 3)]),
        ([(1, 3), (2, 6), (8, 10), (15, 18)], [(1, 6), (8, 10), (15, 18)]),
        ([(1, 4), (4, 5)], [(1, 5)]),
        ([(5, 7), (1, 2), (2, 4)], [(1, 4), (5, 7)]),
        ([(1, 10), (2, 3), (4, 8)], [(1, 10)]),
        ([(1, 2), (3, 4), (5, 6)], [(1, 2), (3, 4), (5, 6)]),
        ([(1, 5), (1, 5), (1, 5)], [(1, 5)]),
    ]

    def check(c):
        inp, want = c
        got = fn(list(inp))
        assert _norm(got) == _norm(want), f"in={inp} want={want} got={got}"

    run_and_report(cases, check)


if __name__ == "__main__":
    main(runner)
