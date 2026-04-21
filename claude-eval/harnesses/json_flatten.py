import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import find_callable, run_and_report, main


def runner(mod):
    fn_name, flatten = find_callable(mod, ["flatten_json", "flatten", "flatten_dict"])
    unflatten = getattr(mod, "unflatten_json", None) or getattr(mod, "unflatten", None)
    if not flatten or not callable(unflatten):
        print('{"passed": 0, "total": 1, "failures": [{"error": "need both flatten_json and unflatten_json"}]}')
        return

    def case_empty_dict():
        assert flatten({}) == {}

    def case_single_primitive():
        assert flatten({"a": 1}) == {"a": 1}

    def case_nested():
        assert flatten({"a": {"b": 2}}) == {"a.b": 2}

    def case_list_indices():
        assert flatten({"a": [1, 2, 3]}) == {"a.0": 1, "a.1": 2, "a.2": 3}

    def case_mixed_list_dicts():
        want = {"a.0.b": 1, "a.1.c": 2}
        assert flatten({"a": [{"b": 1}, {"c": 2}]}) == want

    def case_empty_containers_preserved():
        out = flatten({"a": {}, "b": []})
        assert out == {"a": {}, "b": []}, f"got {out}"

    def case_separator_collision_raises():
        try:
            flatten({"a.b": {"c": 1}})
        except ValueError:
            return
        raise AssertionError("expected ValueError when key contains separator")

    def case_custom_separator():
        assert flatten({"a": {"b": 1}}, sep="/") == {"a/b": 1}

    def case_roundtrip_nested():
        orig = {"a": {"b": [1, {"c": 3}, 2]}, "d": "hi"}
        assert unflatten(flatten(orig)) == orig

    def case_roundtrip_empty_containers():
        orig = {"a": {}, "b": [], "c": {"d": [], "e": {}}}
        assert unflatten(flatten(orig)) == orig

    def case_unflatten_list_recon():
        assert unflatten({"a.0": 1, "a.1": 2, "a.2": 3}) == {"a": [1, 2, 3]}

    cases = [
        case_empty_dict, case_single_primitive, case_nested, case_list_indices,
        case_mixed_list_dicts, case_empty_containers_preserved,
        case_separator_collision_raises, case_custom_separator,
        case_roundtrip_nested, case_roundtrip_empty_containers,
        case_unflatten_list_recon,
    ]

    def check(c):
        c()

    run_and_report(cases, check)


if __name__ == "__main__":
    main(runner)
