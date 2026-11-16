import { BuiltinChecker } from "./manifest";

const HEAD = `import sys
text = sys.stdin.read()
separator = text.split("\\n", 1)[0]
_, test_input, expected, actual, _ = text.split(separator + "\\n")
`;

/**
 * Source of the checkers Forge ships, in the judge's checker protocol (see the package
 * format docs). They are plain Python so the judge needs nothing but the generated file.
 */
const TAIL = `
verdict, reason = judge()
print(reason if EXPLAIN else verdict)
`;

/** With `explain`, the program prints why the output is wrong instead of the verdict. */
export const builtinCheckerSource = (kind: Exclude<BuiltinChecker, "tokens">, eps = 1e-6, explain = false): string => {
    const flag = `EXPLAIN = ${explain ? "True" : "False"}\n`;
    if (kind === "lines")
        return `# Built-in checker "lines": lines must match exactly, ignoring trailing spaces and
# trailing blank lines.
${flag}${HEAD}
def lines(text):
    rows = [row.rstrip() for row in text.split("\\n")]
    while rows and rows[-1] == "":
        rows.pop()
    return rows

def judge():
    want, got = lines(expected), lines(actual)
    for number, (a, b) in enumerate(zip(want, got), start=1):
        if a != b:
            return "WA", f"line {number}: expected {a[:80]!r}, found {b[:80]!r}"
    if len(want) != len(got):
        return "WA", f"expected {len(want)} lines, found {len(got)}"
    return "AC", "ok"
${TAIL}`;
    if (kind === "yesno")
        return `# Built-in checker "yesno": tokens are compared without regard to letter case.
${flag}${HEAD}
def judge():
    want, got = expected.split(), actual.split()
    for number, (a, b) in enumerate(zip(want, got), start=1):
        if a.lower() != b.lower():
            return "WA", f"token {number}: expected {a[:80]!r}, found {b[:80]!r}"
    if len(want) != len(got):
        return "WA", f"expected {len(want)} tokens, found {len(got)}"
    return "AC", "ok"
${TAIL}`;
    return `# Built-in checker "float": numbers may differ by an absolute or relative error of at
# most EPS; everything else must match token by token.
${flag}${HEAD}
EPS = ${eps}

def number(token):
    try:
        value = float(token)
    except ValueError:
        return None
    return value if value == value and abs(value) != float("inf") else None

def same(a, b):
    if a == b:
        return True
    x, y = number(a), number(b)
    if x is None or y is None:
        return False
    return abs(x - y) <= EPS * max(1.0, abs(x))

def judge():
    want, got = expected.split(), actual.split()
    for position, (a, b) in enumerate(zip(want, got), start=1):
        if not same(a, b):
            return "WA", f"token {position}: expected {a[:80]}, found {b[:80]} (allowed error {EPS})"
    if len(want) != len(got):
        return "WA", f"expected {len(want)} tokens, found {len(got)}"
    return "AC", "ok"
${TAIL}`;
};
