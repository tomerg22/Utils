import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import find_callable, run_and_report, main


def runner(mod):
    name, fn = find_callable(mod, ["leftmost_binary_search", "bisect_left_index", "leftmost"])
    if not fn:
        print('{"passed": 0, "total": 1, "failures": [{"error": "no callable found"}]}')
        return

    cases = [
        ([], 5, -1),
        ([1], 1, 0),
        ([1], 2, -1),
        ([1, 2, 3, 4, 5], 3, 2),
        ([1, 2, 2, 2, 3], 2, 1),
        ([1, 1, 1, 1], 1, 0),
        ([1, 2, 3], 4, -1),
        ([1, 2, 3], 0, -1),
        (list(range(100)), 50, 50),
        ([1, 1, 2, 2, 3, 3], 3, 4),
    ]

    def check(c):
        arr, target, want = c
        got = fn(list(arr), target)
        assert got == want, f"arr={arr} target={target} want={want} got={got}"

    run_and_report(cases, check)


if __name__ == "__main__":
    main(runner)
