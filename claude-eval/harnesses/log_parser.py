import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import find_callable, run_and_report, main


def runner(mod):
    name, fn = find_callable(mod, ["parse_logs", "parse_log_lines", "parse"])
    if not fn:
        print('{"passed": 0, "total": 1, "failures": [{"error": "no callable found"}]}')
        return

    def _entries_and_count(out):
        assert isinstance(out, tuple) and len(out) == 2, f"expected tuple(entries, count), got {out!r}"
        entries, cnt = out
        assert isinstance(entries, list), f"entries must be list, got {type(entries).__name__}"
        assert isinstance(cnt, int), f"count must be int, got {type(cnt).__name__}"
        return entries, cnt

    def case_basic():
        out = fn(["2024-01-01T00:00:00 INFO started"])
        es, c = _entries_and_count(out)
        assert es == [{"timestamp": "2024-01-01T00:00:00", "level": "INFO", "message": "started"}]
        assert c == 0

    def case_multi_with_one_malformed():
        out = fn([
            "2024-01-01T00:00:00 INFO started",
            "garbage line here",
            "2024-01-01T00:00:01 ERROR boom",
        ])
        es, c = _entries_and_count(out)
        assert len(es) == 2
        assert c == 1

    def case_unknown_level_malformed():
        out = fn(["2024-01-01 FOO oops"])
        es, c = _entries_and_count(out)
        assert es == []
        assert c == 1

    def case_empty_line_not_malformed():
        out = fn(["", "   ", "\t", "2024-01-01 INFO ok"])
        es, c = _entries_and_count(out)
        assert len(es) == 1
        assert c == 0, f"empty/ws lines must not count malformed, got {c}"

    def case_leading_ws_stripped_but_message_inner_preserved():
        out = fn(["   2024-01-01 WARN  hello   world  "])
        es, c = _entries_and_count(out)
        assert len(es) == 1 and c == 0
        assert es[0]["level"] == "WARN"
        assert es[0]["timestamp"] == "2024-01-01"
        assert es[0]["message"] == " hello   world  ", f"got {es[0]['message']!r}"

    def case_level_case_sensitive():
        out = fn(["2024-01-01 info lowercase"])
        es, c = _entries_and_count(out)
        assert es == []
        assert c == 1

    def case_missing_message_malformed():
        out = fn(["2024-01-01 INFO"])
        es, c = _entries_and_count(out)
        assert es == []
        assert c == 1

    def case_returns_tuple_on_empty():
        out = fn([])
        es, c = _entries_and_count(out)
        assert es == [] and c == 0

    cases = [
        case_basic, case_multi_with_one_malformed, case_unknown_level_malformed,
        case_empty_line_not_malformed, case_leading_ws_stripped_but_message_inner_preserved,
        case_level_case_sensitive, case_missing_message_malformed, case_returns_tuple_on_empty,
    ]

    def check(c):
        c()

    run_and_report(cases, check)


if __name__ == "__main__":
    main(runner)
