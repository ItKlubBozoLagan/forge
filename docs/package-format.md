# Problem package format

A problem is a directory of files. `problem.yaml` describes it; everything else is referenced
from there. The web editor, the CLI and the build engine all work on this same layout.

```
problem.yaml
statement/en.md          one file per language
generators/rand.py
validator.py
checker.py               optional
solutions/main.cpp
solutions/brute.cpp
tests/sample1.in         manual tests
```

## problem.yaml

```yaml
name: pair-sum                  # lowercase letters, digits, dashes
title: "Pair Sum"               # or { en: "...", hr: "..." }
type: batch                     # batch | interactive | output-only | communication | grader
limits: { time_ms: 1000, memory_mb: 256 }
scoring: { mode: sum }          # sum (points per group) | binary (ICPC: all or nothing)

constraints:                    # the single source of truth for every bound
  N: { min: 2, max: 200000 }
  A: { min: 1, max: 1000000000 }

validator: validator.py
checker: checker.py             # omit to compare tokens; the interactor for interactive tasks
generators:
  rand: generators/rand.py

groups:
  - name: samples
    sample: true                # shown in the statement
    tests:
      - manual: tests/sample1.in
  - name: small
    points: 30
    aggregate: min              # min: all tests must pass | sum: average of the test scores
    constraints: { N: { max: 1000 } }   # overrides the global bound inside this group
    tests:
      - { gen: rand, args: "n=1000 seed={i}", count: 3 }   # {i} = 1..count
  - name: full
    points: 70
    depends: [small]            # scores only if "small" is fully solved; includes its tests
    tests:
      - { gen: rand, args: "seed=1" }

solutions:
  - { path: solutions/main.cpp, role: main }                          # produces the answers
  - { path: solutions/brute.cpp, expect: { samples: AC, small: AC, full: TLE } }
  - { path: solutions/greedy.cpp, expect: WA }                        # same on every group
```

`output-only`, `communication` and `grader` tasks can be described but not built yet; they need
the next runner protocol (see [architecture.md](architecture.md)).

### Formats

| Format | How to express it |
|---|---|
| ICPC | `scoring: { mode: binary }`, a `samples` group and one `secret` group |
| IOI | groups with `aggregate: min`, `points`, and `depends` between subtasks |
| HONI | independent groups (clusters) with `points`; a checker returning partial scores when needed |

### Expectations

Each solution states what should happen per group:

- `AC`: every test passes.
- `WA`, `TLE`, `MLE`, `RE`, `PA` (partial score): at least one test fails, and every failing test
  fails that way. Combine with `|`, e.g. `"TLE|WA"`.
- `FAIL`: at least one test fails, in any way.

A build is **green** only when every test is valid, every solution behaves as declared, and there
are no other errors. Only green revisions can be exported to a judge.

## Constraints are injected, not copied

The bounds in `constraints` are prepended as constants to the validator, the generators and the
checker (C, C++ and Python): `N: { min: 2, max: 200000 }` becomes `N_MIN` and `N_MAX`. Inside a
group the group's own bounds apply, and `GROUP` (Python) / `FORGE_GROUP` (C/C++) holds its name.

Statements read the same values: `{{N.max}}` renders as `2 \cdot 10^{5}` (`{{N.max|raw}}` as
`200000`), `{{group.small.N.max}}` reads a group's bound, `{{limits.time}}` and
`{{limits.memory}}` the limits, and `{{samples}}` is replaced by the sample tests with the main
solution's outputs. Statements are Markdown with KaTeX math.

## Program conventions

These follow what the current kontestis evaluator can do. Programs are single files.

**Generator.** Reads its arguments from the first line of stdin, prints the test to stdout. It
must be deterministic: the same arguments always give the same test.

**Validator.** Reads the test from stdin. Exit code 0 means valid; any other exit code means
invalid, with the reason on stderr. It runs once per group whose test set contains the test,
including groups that inherit it through `depends`, each time with that group's constraints.

**Checker.** Reads one stream from stdin made of four sections, each introduced by the same
random separator line (the first line of the stream): the test input, the expected answer, the
solution's output, and a closing separator. Prints `AC`, `WA`, or `custom:<score>` with a score
in `[0, 1]` for partial credit.

```python
import sys
text = sys.stdin.read()
separator = text.split("\n", 1)[0]
_, test_input, expected, actual, _ = text.split(separator + "\n")
print("AC" if actual.split() == expected.split() else "WA")
```

**Interactor** (`type: interactive`, set as `checker`). Its stdin carries the test, one extra
newline, then everything the solution prints; what it prints goes to the solution. It writes its
verdict (`AC`, `WA` or `custom:<score>`) to the file `interactor_meta.out`. See
[`examples/guess`](../examples/guess).

## Time limits

Solutions run with a measurement limit of three times the time limit, so a slow solution gets a
real time instead of "killed at the limit". The verdict is derived by applying the actual limit.
The build report then shows:

- **headroom**: time limit ÷ slowest run of a solution expected to pass (aim for ≥ 2),
- **separation**: fastest run of a solution expected to be too slow ÷ time limit (aim for ≥ 1.5),
- a suggested limit when one satisfies both.
