import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import find_callable, run_and_report, main


def runner(mod):
    name, fn = find_callable(mod, ["shortest_paths", "dijkstra", "sssp"])
    if not fn:
        print('{"passed": 0, "total": 1, "failures": [{"error": "no callable found"}]}')
        return

    def case_simple_chain():
        got = fn(4, [(0, 1, 1), (1, 2, 2), (2, 3, 3)], 0)
        assert got == [0, 1, 3, 6], f"got {got}"

    def case_with_branching():
        edges = [(0, 1, 4), (0, 2, 1), (2, 1, 2), (1, 3, 1), (2, 3, 5)]
        got = fn(4, edges, 0)
        assert got == [0, 3, 1, 4], f"got {got}"

    def case_unreachable():
        got = fn(4, [(0, 1, 1)], 0)
        assert got[0] == 0
        assert got[1] == 1
        assert got[2] == math.inf
        assert got[3] == math.inf

    def case_single_node():
        got = fn(1, [], 0)
        assert got == [0]

    def case_negative_edge_raises():
        try:
            fn(3, [(0, 1, 1), (1, 2, -5)], 0)
        except ValueError:
            return
        raise AssertionError("expected ValueError on negative edge")

    def case_negative_edge_even_unreachable_raises():
        try:
            fn(4, [(0, 1, 1), (2, 3, -1)], 0)
        except ValueError:
            return
        raise AssertionError("expected ValueError even if negative edge unreachable from source")

    def case_empty_graph_raises_value():
        try:
            fn(0, [], 0)
        except ValueError:
            return
        raise AssertionError("expected ValueError on empty graph")

    def case_bad_source_raises_index():
        try:
            fn(3, [(0, 1, 1)], 5)
        except IndexError:
            return
        raise AssertionError("expected IndexError on out-of-range source")

    def case_zero_weight_edge_ok():
        got = fn(3, [(0, 1, 0), (1, 2, 0)], 0)
        assert got == [0, 0, 0]

    def case_multi_edges_takes_min():
        got = fn(3, [(0, 1, 5), (0, 1, 2), (1, 2, 3)], 0)
        assert got == [0, 2, 5], f"got {got}"

    def case_performance_large():
        import time
        import random
        random.seed(11)
        n = 5000
        m = 20000
        edges = []
        for _ in range(m):
            u = random.randint(0, n - 1)
            v = random.randint(0, n - 1)
            if u == v:
                continue
            w = random.randint(1, 1000)
            edges.append((u, v, w))
        start = time.time()
        dist = fn(n, edges, 0)
        elapsed = time.time() - start
        assert elapsed < 3.0, (
            f"too slow: {elapsed:.2f}s for n={n} m={m} — "
            f"likely O(V^2) adjacency-matrix instead of heap-based O((V+E) log V)"
        )
        assert dist[0] == 0
        assert len(dist) == n

    cases = [
        case_simple_chain, case_with_branching, case_unreachable, case_single_node,
        case_negative_edge_raises, case_negative_edge_even_unreachable_raises,
        case_empty_graph_raises_value, case_bad_source_raises_index,
        case_zero_weight_edge_ok, case_multi_edges_takes_min,
        case_performance_large,
    ]

    def check(c):
        c()

    run_and_report(cases, check)


if __name__ == "__main__":
    main(runner)
