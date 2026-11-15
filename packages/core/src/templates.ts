export const TEMPLATE_FORMATS = ["ioi", "icpc", "honi", "empty"] as const;
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

/** Starter package for a new problem: a complete, buildable example in the chosen format. */
export const templateFiles = (format: TemplateFormat, name: string, title: string): Record<string, string> => {
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
