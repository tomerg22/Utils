import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import find_callable, run_and_report, main


def _is_valid_topo(order, n, edges):
    if order is None:
        return False
    if len(order) != n or sorted(order) != list(range(n)):
        return False
    pos = {v: i for i, v in enumerate(order)}
    return all(pos[u] < pos[v] for u, v in edges)


def runner(mod):
    name, fn = find_callable(mod, ["topological_sort", "topo_sort", "toposort"])
    if not fn:
        print('{"passed": 0, "total": 1, "failures": [{"error": "no callable found"}]}')
        return

    cases = [
        {"n": 0, "edges": [], "cycle": False},
        {"n": 1, "edges": [], "cycle": False},
        {"n": 3, "edges": [(0, 1), (1, 2)], "cycle": False},
        {"n": 4, "edges": [(0, 1), (0, 2), (1, 3), (2, 3)], "cycle": False},
        {"n": 3, "edges": [(0, 1), (1, 2), (2, 0)], "cycle": True},
        {"n": 5, "edges": [(0, 1), (2, 3)], "cycle": False},
        {"n": 4, "edges": [(0, 1), (1, 2), (2, 3), (3, 1)], "cycle": True},
    ]

    def check(c):
        got = fn(c["n"], list(c["edges"]))
        if c["cycle"]:
            assert got is None, f"expected None for cyclic graph, got {got}"
        else:
            assert _is_valid_topo(got, c["n"], c["edges"]), (
                f"invalid topo: n={c['n']} edges={c['edges']} got={got}"
            )

    run_and_report(cases, check)


if __name__ == "__main__":
    main(runner)
