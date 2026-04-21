import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import find_callable, run_and_report, main


def runner(mod):
    name, fn = find_callable(mod, ["evaluate_expression", "evaluate", "eval_expr"])
    if not fn:
        print('{"passed": 0, "total": 1, "failures": [{"error": "no callable found"}]}')
        return

    source = open(mod.__file__).read() if getattr(mod, "__file__", None) else ""
    banned = ["eval(", "exec(", "compile(", "literal_eval"]
    source_hit = [b for b in banned if b in source]

    def case_banned():
        assert not source_hit, f"used banned primitive(s): {source_hit}"

    def case_simple():
        assert fn("1+2") == 3
        assert fn("10-3") == 7
        assert fn("4*5") == 20

    def case_true_division():
        assert fn("7/2") == 3.5
        assert fn("9/3") == 3.0

    def case_precedence():
        assert fn("2+3*4") == 14
        assert fn("(2+3)*4") == 20
        assert fn("10-2*3") == 4
        assert fn("20/4/5") == 1.0

    def case_unary_minus():
        assert fn("-3") == -3
        assert fn("-3*2") == -6
        assert fn("-(3+2)") == -5
        assert fn("2*-3") == -6
        assert fn("--5") == 5
        assert fn("-(-(5))") == 5

    def case_whitespace():
        assert fn("  2 +  3 * 4 ") == 14
        assert fn("\t1\n+\n2\t") == 3

    def case_div_by_zero():
        try:
            fn("1/0")
        except ZeroDivisionError:
            pass
        else:
            raise AssertionError("expected ZeroDivisionError")
        try:
            fn("1/(2-2)")
        except ZeroDivisionError:
            pass
        else:
            raise AssertionError("expected ZeroDivisionError")

    def case_paren_mismatch():
        for bad in ["(1+2", "1+2)", "(((1+2)", "()"]:
            try:
                fn(bad)
            except ValueError:
                continue
            raise AssertionError(f"expected ValueError on {bad!r}")

    def case_malformed():
        for bad in ["", "   ", "1+", "+1+2", "1++2", "1 2"]:
            try:
                r = fn(bad)
            except ValueError:
                continue
            raise AssertionError(f"expected ValueError on {bad!r}, got {r!r}")

    def case_deep_nested():
        assert fn("((((1+2)*3)-4)/5)") == 1.0

    cases = [
        case_banned, case_simple, case_true_division, case_precedence,
        case_unary_minus, case_whitespace, case_div_by_zero,
        case_paren_mismatch, case_malformed, case_deep_nested,
    ]

    def check(c):
        c()

    run_and_report(cases, check)


if __name__ == "__main__":
    main(runner)
