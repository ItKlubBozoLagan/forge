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
export const builtinCheckerSource = (kind: Exclude<BuiltinChecker, "tokens">, eps = 1e-6): string => {
    if (kind === "lines")
        return `# Built-in checker "lines": lines must match exactly, ignoring trailing spaces and
# trailing blank lines.
${HEAD}
def lines(text):
    rows = [row.rstrip() for row in text.split("\\n")]
    while rows and rows[-1] == "":
        rows.pop()
    return rows

print("AC" if lines(expected) == lines(actual) else "WA")
`;
    if (kind === "yesno")
        return `# Built-in checker "yesno": tokens are compared without regard to letter case.
${HEAD}
print("AC" if [t.lower() for t in expected.split()] == [t.lower() for t in actual.split()] else "WA")
`;
    return `# Built-in checker "float": numbers may differ by an absolute or relative error of at
# most EPS; everything else must match token by token.
${HEAD}
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

want, got = expected.split(), actual.split()
print("AC" if len(want) == len(got) and all(same(a, b) for a, b in zip(want, got)) else "WA")
`;
};
