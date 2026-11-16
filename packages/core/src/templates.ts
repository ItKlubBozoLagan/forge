export const TEMPLATE_FORMATS = ["ioi", "icpc", "honi", "interactive", "output-only", "empty"] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];

const GENERATOR = `# Generators read their arguments from the first line of stdin and must be
# deterministic: the same arguments always produce the same test.
# N_MAX, A_MAX... come from the constraints in problem.yaml.
import random

args = dict(part.split("=") for part in input().split())
random.seed(int(args.get("seed", 0)))
n = int(args.get("n", N_MAX))
maxv = int(args.get("maxv", A_MAX))
mode = args.get("mode", "random")

if mode == "equal":
    value = random.randint(1, maxv)
    a = [value] * n
else:
    a = [random.randint(1, maxv) for _ in range(n)]

i, j = random.sample(range(n), 2)
print(n, a[i] + a[j])
print(*a)
`;

const VALIDATOR = `# Validators read the test from stdin and exit with a non-zero code (and a message on
# stderr) when it breaks the constraints. They run once per group, with that group's
# effective constraints injected as N_MIN, N_MAX, ...
import sys

def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)

lines = sys.stdin.read().split("\\n")
if lines[-1] != "":
    fail("the file must end with a newline")
if len(lines) != 3:
    fail("expected exactly two lines")
first = lines[0].split(" ")
if len(first) != 2 or not all(token.isdigit() for token in first):
    fail("the first line must be 'N K'")
n, k = map(int, first)
if not N_MIN <= n <= N_MAX:
    fail(f"N={n} is outside [{N_MIN}, {N_MAX}]")
if not K_MIN <= k <= K_MAX:
    fail(f"K={k} is outside [{K_MIN}, {K_MAX}]")
values = lines[1].split(" ")
if len(values) != n or not all(token.isdigit() for token in values):
    fail(f"the second line must hold exactly {n} integers")
for token in values:
    if not A_MIN <= int(token) <= A_MAX:
        fail(f"a_i={token} is outside [{A_MIN}, {A_MAX}]")
`;

const MAIN = `#include <bits/stdc++.h>
using namespace std;

int main() {
    int n;
    long long k;
    scanf("%d %lld", &n, &k);
    vector<long long> a(n);
    for (auto &x : a) scanf("%lld", &x);
    sort(a.begin(), a.end());
    long long pairs = 0;
    for (int i = 0; i < n; i++) {
        auto range = equal_range(a.begin() + i + 1, a.end(), k - a[i]);
        pairs += range.second - range.first;
    }
    printf("%lld\\n", pairs);
}
`;

const BRUTE = `#include <bits/stdc++.h>
using namespace std;

// Quadratic: correct, but too slow for the largest tests.
int main() {
    int n;
    long long k;
    scanf("%d %lld", &n, &k);
    vector<long long> a(n);
    for (auto &x : a) scanf("%lld", &x);
    long long pairs = 0;
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            if (a[i] + a[j] == k) pairs++;
    printf("%lld\\n", pairs);
}
`;

const OVERFLOW = `#include <bits/stdc++.h>
using namespace std;

// Fast, but counts in 32 bits: wrong once the answer exceeds 2^32.
int main() {
    int n;
    long long k;
    scanf("%d %lld", &n, &k);
    vector<long long> a(n);
    for (auto &x : a) scanf("%lld", &x);
    sort(a.begin(), a.end());
    unsigned int pairs = 0;
    for (int i = 0; i < n; i++) {
        auto range = equal_range(a.begin() + i + 1, a.end(), k - a[i]);
        pairs += range.second - range.first;
    }
    printf("%u\\n", pairs);
}
`;

const STATEMENT = (title: string) => `# ${title}

You are given $N$ integers $a_1, \\dots, a_N$ and a target $K$. Count the pairs of indices
$i < j$ with $a_i + a_j = K$.

## Input

The first line contains $N$ and $K$. The second line contains $a_1, \\dots, a_N$.

## Output

Print the number of pairs.

## Constraints

- ${"$"}{{N.min}} \\le N \\le {{N.max}}$
- ${"$"}{{A.min}} \\le a_i \\le {{A.max}}$
- Time limit: {{limits.time}}, memory limit: {{limits.memory}}

{{samples}}
`;

const COMMON = `constraints:
  N: { min: 2, max: 200000 }
  A: { min: 1, max: 1000000000 }
  K: { min: 2, max: 2000000000 }

validator: validator.py
generators:
  rand: generators/rand.py
`;

const SAMPLES = `  - name: samples
    sample: true
    tests:
      - manual: tests/sample1.in
`;

const LARGE_TESTS = `      - { gen: rand, args: "seed={i}", count: 2 }
      - { gen: rand, args: "mode=equal seed=3" }
      - { gen: rand, args: "maxv=2 seed=4" }
`;

const manifest = (format: TemplateFormat, name: string, title: string): string => {
    const head = `name: ${name}\ntitle: ${JSON.stringify(title)}\ntype: batch\nlimits: { time_ms: 1000, memory_mb: 256 }\n`;
    if (format === "icpc")
        return `${head}scoring: { mode: binary }

${COMMON}
# ICPC style: one secret group, a submission is accepted only if every test passes.
groups:
${SAMPLES}  - name: secret
    depends: [samples]
    tests:
      - { gen: rand, args: "n=1000 seed={i}", count: 3 }
${LARGE_TESTS}
solutions:
  - { path: solutions/main.cpp, role: main }
  - { path: solutions/brute.cpp, expect: { samples: AC, secret: TLE } }
  - { path: solutions/overflow.cpp, expect: { samples: AC, secret: WA } }
`;
    if (format === "honi")
        return `${head}
${COMMON}
# HONI style: independent clusters; a cluster awards its points when all its tests pass.
groups:
${SAMPLES}  - name: cluster1
    points: 20
    constraints: { N: { max: 1000 } }
    tests:
      - { gen: rand, args: "n=1000 seed={i}", count: 3 }
  - name: cluster2
    points: 30
    constraints: { N: { max: 1000 }, A: { max: 2 } }
    tests:
      - { gen: rand, args: "n=1000 maxv=2 seed={i}", count: 2 }
  - name: cluster3
    points: 50
    tests:
${LARGE_TESTS}
solutions:
  - { path: solutions/main.cpp, role: main }
  - { path: solutions/brute.cpp, expect: { samples: AC, cluster1: AC, cluster2: AC, cluster3: TLE } }
  - { path: solutions/overflow.cpp, expect: { samples: AC, cluster1: AC, cluster2: AC, cluster3: WA } }
`;
    return `${head}
${COMMON}
# IOI style: subtasks score all-or-nothing (aggregate: min) and "full" also requires "small".
groups:
${SAMPLES}  - name: small
    points: 30
    constraints: { N: { max: 1000 } }
    tests:
      - { gen: rand, args: "n=1000 seed={i}", count: 3 }
      - { gen: rand, args: "n=1000 mode=equal seed=9" }
  - name: full
    points: 70
    depends: [small]
    tests:
${LARGE_TESTS}
solutions:
  - { path: solutions/main.cpp, role: main }
  - { path: solutions/brute.cpp, expect: { samples: AC, small: AC, full: TLE } }
  - { path: solutions/overflow.cpp, expect: { samples: AC, small: AC, full: WA } }
`;
};

const INTERACTIVE = (name: string, title: string): Record<string, string> => ({
    "problem.yaml": `name: ${name}
title: ${JSON.stringify(title)}
type: interactive
limits: { time_ms: 1000, memory_mb: 256 }
scoring: { mode: binary }

constraints:
  N: { min: 1, max: 1000000 }
  Q: { max: 20 }

validator: validator.py
# For interactive tasks the checker is the interactor.
checker: interactor.py

groups:
  - name: samples
    sample: true
    tests:
      - manual: tests/sample1.in
  - name: secret
    depends: [samples]
    tests:
      - manual: tests/one.in
      - manual: tests/max.in
      - manual: tests/mid.in

solutions:
  - { path: solutions/binary.py, role: main }
  # After the interactor gives up, the judge can leave the solution waiting for input until
  # the wall clock runs out, so a wrong interaction may also surface as TLE.
  - { path: solutions/linear.py, expect: { samples: AC, secret: "WA|TLE" } }
`,
    "statement/en.md": `# ${title}

The judge has chosen a secret integer between $1$ and $N$. Find it with at most {{Q.max}}
questions.

## Interaction

First read $N$ ($N \\le {{N.max}}$). Then repeatedly print a guess and flush. The judge answers
\`<\` when the secret is smaller than your guess, \`>\` when it is larger, and \`=\` when you found
it, after which your program must stop.
`,
    "validator.py": `import sys

lines = sys.stdin.read().split("\\n")
if len(lines) != 2 or lines[1] != "" or not lines[0].isdigit():
    sys.exit("expected a single integer and a newline")
if not N_MIN <= int(lines[0]) <= N_MAX:
    sys.exit(f"N={lines[0]} is outside [{N_MIN}, {N_MAX}]")
`,
    "interactor.py": `# The interactor receives the test on stdin, then one extra newline, then everything the
# solution prints. Read the solution's output token by token so blank lines do not matter.
# What it prints goes to the solution. Its verdict (AC, WA or custom:<score>) is written to
# interactor_meta.out. N_MAX and Q_MAX come from the constraints in problem.yaml.
import sys

def finish(verdict):
    with open("interactor_meta.out", "w") as meta:
        meta.write(verdict)
    sys.exit(0)

def tokens():
    for line in sys.stdin:
        yield from line.split()

reader = tokens()
secret = int(next(reader))
print(N_MAX, flush=True)
for _ in range(Q_MAX):
    token = next(reader, None)
    if token is None or not token.isdigit():
        finish("WA")
    guess = int(token)
    if guess == secret:
        print("=", flush=True)
        finish("AC")
    print("<" if secret < guess else ">", flush=True)
finish("WA")
`,
    "solutions/binary.py": `low, high = 1, int(input())
while True:
    middle = (low + high) // 2
    print(middle, flush=True)
    answer = input()
    if answer == "=":
        break
    if answer == "<":
        high = middle - 1
    else:
        low = middle + 1
`,
    "solutions/linear.py": `# Asks 1, 2, 3, ... and runs out of questions.
limit = int(input())
for guess in range(1, limit + 1):
    print(guess, flush=True)
    if input() == "=":
        break
`,
    "tests/sample1.in": "7\n",
    "tests/one.in": "1\n",
    "tests/max.in": "1000000\n",
    "tests/mid.in": "31337\n",
});

const OUTPUT_ONLY = (name: string, title: string): Record<string, string> => ({
    "problem.yaml": `name: ${name}
title: ${JSON.stringify(title)}
# Contestants download the inputs and submit one output file per test; no program of theirs
# is run. The limits below only bound the programs you list as solutions.
type: output-only
limits: { time_ms: 5000, memory_mb: 256 }

constraints:
  N: { min: 1, max: 20 }
  A: { min: 1, max: 1000 }
  S: { min: 1, max: 20000 }

validator: validator.py
# Scores an output by how close its sum is to the best one (see checker.py).
checker: checker.py

groups:
  - name: samples
    sample: true
    tests:
      - manual: tests/sample1.in
  - name: tests
    points: 100
    # each test contributes its own share of the points
    aggregate: sum
    tests:
      - manual: tests/a.in
      - manual: tests/b.in

# A solution is either a program that prints the output for a test, or a directory holding
# one output per test at <directory>/<group>/<index>.out. A missing file scores as WA.
solutions:
  - { path: solutions/main.py, role: main }
  - { path: solutions/greedy, expect: { samples: AC, tests: PA } }
  - { path: solutions/unfinished, expect: { samples: AC, tests: WA } }
`,
    "statement/en.md": `# ${title}

This is an output-only task: you are given the input files and submit one output file for
each of them.

Each input holds $N$ ($N \\le {{N.max}}$) positive integers and a limit $S$. Choose some of the
numbers so that their sum is as large as possible without exceeding $S$.

## Input

The first line contains $N$ and $S$. The second line contains the $N$ numbers.

## Output

On the first line print $K$, how many numbers you chose. On the second line print their
positions (the first number has position 1).

## Scoring

An output whose sum is $X$ scores $X / B$ of the points of its test, where $B$ is the best
possible sum. An invalid output scores nothing.

{{samples}}
`,
    "validator.py": `import sys

lines = sys.stdin.read().split("\\n")
if len(lines) != 3 or lines[2] != "":
    sys.exit("expected exactly two lines")
head = lines[0].split(" ")
if len(head) != 2 or not all(part.isdigit() for part in head):
    sys.exit("the first line must be: N S")
n, s = map(int, head)
if not N_MIN <= n <= N_MAX:
    sys.exit(f"N={n} is outside [{N_MIN}, {N_MAX}]")
if not S_MIN <= s <= S_MAX:
    sys.exit(f"S={s} is outside [{S_MIN}, {S_MAX}]")
numbers = lines[1].split(" ")
if len(numbers) != n or not all(part.isdigit() for part in numbers):
    sys.exit(f"expected {n} numbers on the second line")
if not all(A_MIN <= int(part) <= A_MAX for part in numbers):
    sys.exit(f"a number is outside [{A_MIN}, {A_MAX}]")
`,
    "checker.py": `# The checker reads one stream: a separator line, the test input, the separator, the
# reference answer, the separator, the contestant's output and the separator again.
# It prints AC, WA or custom:<score between 0 and 1>.
import sys

text = sys.stdin.read()
separator = text.split("\\n", 1)[0]
_, test_input, expected, actual, _ = text.split(separator + "\\n")

head, numbers = test_input.split("\\n")[:2]
limit = int(head.split()[1])
numbers = [int(part) for part in numbers.split()]

def total(output):
    tokens = output.split()
    if not tokens or not all(token.isdigit() for token in tokens):
        return None
    count, picks = int(tokens[0]), [int(token) for token in tokens[1:]]
    if len(picks) != count or len(set(picks)) != count:
        return None
    if any(not 1 <= pick <= len(numbers) for pick in picks):
        return None
    chosen = sum(numbers[pick - 1] for pick in picks)
    return chosen if chosen <= limit else None

best, got = total(expected), total(actual)
if not got:
    print("WA")
elif got >= best:
    print("AC")
else:
    print(f"custom:{got / best:.4f}")
`,
    "solutions/main.py": `n, limit = map(int, input().split())
numbers = list(map(int, input().split()))
reach = {0: []}
for position, value in enumerate(numbers, start=1):
    for total, chosen in list(reach.items()):
        if total + value <= limit and total + value not in reach:
            reach[total + value] = chosen + [position]
best = reach[max(reach)]
print(len(best))
print(*best)
`,
    // takes numbers in order while they fit
    "solutions/greedy/samples/1.out": "2\n1 2\n",
    "solutions/greedy/tests/1.out": "2\n1 2\n",
    "solutions/greedy/tests/2.out": "2\n1 2\n",
    // solved the first test by hand and never got to the second
    "solutions/unfinished/samples/1.out": "2\n1 2\n",
    "solutions/unfinished/tests/1.out": "2\n3 4\n",
    "tests/sample1.in": "3 10\n3 7 5\n",
    "tests/a.in": "4 10\n3 5 4 6\n",
    "tests/b.in": "5 20\n9 8 7 6 5\n",
});

/** Starter package for a new problem: a complete, buildable example in the chosen format. */
export const templateFiles = (format: TemplateFormat, name: string, title: string): Record<string, string> => {
    if (format === "interactive") return INTERACTIVE(name, title);
    if (format === "output-only") return OUTPUT_ONLY(name, title);
    if (format === "empty")
        return {
            "problem.yaml": `name: ${name}\ntitle: ${JSON.stringify(title)}\ntype: batch\nlimits: { time_ms: 1000, memory_mb: 256 }\n\ngroups:\n  - name: samples\n    sample: true\n    tests: []\n`,
            "statement/en.md": `# ${title}\n\nDescribe the task here.\n\n{{samples}}\n`,
        };
    return {
        "problem.yaml": manifest(format, name, title),
        "statement/en.md": STATEMENT(title),
        "generators/rand.py": GENERATOR,
        "validator.py": VALIDATOR,
        "solutions/main.cpp": MAIN,
        "solutions/brute.cpp": BRUTE,
        "solutions/overflow.cpp": OVERFLOW,
        "tests/sample1.in": "5 6\n1 5 3 3 2\n",
    };
};
