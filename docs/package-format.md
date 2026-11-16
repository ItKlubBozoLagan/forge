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
checker: checker.py             # omit for the judge's default comparison; the interactor for interactive tasks
judge: kontestis                # optional: warn about what this judge cannot score
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

### Task types

| `type` | What is judged | kontestis `evaluation_variant` |
|---|---|---|
| `batch` | A program reads the test on stdin and prints an answer; compared by the judge's default comparison, or by `checker` | `plain`, `checker` |
| `interactive` | A program talks to the interactor named in `checker` | `interactive` |
| `output-only` | Output files the contestant submits; no program of theirs runs | `output-only` |
| `grader` | The contestant implements functions; the problem's grader holds `main` and calls them | none |
| `communication` | The solution runs twice per test, with the problem's manager turning the first run's output into the second run's input | none |

**Grader tasks.** `grader: { cpp: grader/grader.cpp, python: grader/grader.py, headers:
[grader/task.h] }` names one grader per language (C, C++, Python) and the headers they share
with solutions. The judge compiles a single file, so a solution is judged as its own file
followed by the grader, with each header inlined where it is first included. Compiler messages
keep the original file names and line numbers. Both files end up in one translation unit, so a
helper with the same name in the grader and in a solution clashes: keep the grader's helpers in
a namespace or give them a prefix. A solution in a language without a grader is an error.

**Communication tasks.** `manager: manager.py` names the program that runs between a
solution's two runs:

1. the solution reads `1` on the first line and then the test, and prints a message;
2. the manager reads a stream in the checker's layout (separator line, the test, separator, the
   message, separator) and prints the input of the second run; exiting with an error and a
   reason on stderr rejects the message, which is a wrong answer;
3. the solution reads `2` on the first line and then what the manager printed; its output is
   compared with the main solution's (or given to the checker, which receives the second
   run's input as the test).

Each run has the full time limit and the slower one is reported.

With `communication: { simultaneous: true, processes: 2 }` the instances run at the same time
instead, each in its own sandbox, and talk only through the manager:

- the manager reads the length of the test in bytes and a newline, then the test and a newline;
- from then on it reads one line `K:<text>` for every line instance K prints (instances are
  numbered from 1), and `K!` when instance K closes its output;
- every line `K:<text>` it prints is delivered to instance K as `<text>`; `K!` closes that
  instance's input;
- it writes its verdict (`AC`, `WA` or `custom:partial:<score>`) to `interactor_meta.out`, like
  an interactor. There are no reference answers and no checker.

Each instance has the full time and memory limit; the largest is reported. This needs an
evaluator with the `communication` feature (`EVALUATOR_FEATURES`), which the released
evaluator does not have; without it the build says so.

kontestis judges neither of these two types today; `judge: kontestis` says so in the build.

**Output-only tasks.** A solution is either a program, run like in a batch task to print the
output of each test, or a directory of outputs with one file per test at
`<path>/<group>/<index>.out` (the test ids shown in a build, for example
`solutions/greedy/tests/2.out`). A test with no file is a wrong answer. The main solution may be
either; when it is a directory it must have an output for every test, and those files are the
reference answers. `limits` only bound the programs listed as solutions, so the build reports
no time limit calibration. Files in a solution directory that match no test are reported.

kontestis currently judges an output-only submission as one text against the first test of each
cluster, so a problem meant for kontestis today should have one test per group.

The `interactive` and `output-only` templates (`forge new --template ...`) are complete
examples of both.

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

## Checkers

`checker` decides whether an output is right. It takes one of three forms:

| `checker` | Meaning |
|---|---|
| omitted | The judge's default comparison: every line is trimmed and the lines are joined by a space, then the two texts must be equal. Line breaks and surrounding spaces do not matter; a blank line in the middle or two spaces inside a line do |
| `{ builtin: lines }` | Lines must match, ignoring trailing spaces and trailing blank lines |
| `{ builtin: float, eps: 1e-6 }` | Tokens match; numbers may differ by an absolute or relative error of at most `eps` |
| `{ builtin: yesno }` | Tokens match without regard to letter case |
| `checker.cpp` (a file) | Your own program, see the conventions below; for interactive tasks this is the interactor |

Built-in checkers are generated as Python programs in the judge's checker protocol and are
exported in the judge bundle like any other checker, so the judge needs nothing from Forge.
The build page names the checker and validator a build used.

### testlib

C++ generators, validators and checkers that `#include "testlib.h"` work as they are; do not
add the header to the package, Forge inlines it at build time and adapts testlib's entry
points to the evaluator:

- a generator's arguments (`{ gen: rand, args: "100 7" }`) reach `registerGen` as `argv`;
- a validator reads the test from stdin and fails with testlib's message;
- a checker gets the input, output and answer as files; `_ok` is `AC`, `_wa` and `_pe` are
  `WA`, `quitp(x)` is `custom:partial:x` with `x` in `[0, 1]`, and `_fail` is a judge error;
- an interactor (`registerInteraction`) reads the test from `inf` and talks to the solution
  through `ouf` and stdout as usual. The evaluator sends the test and the solution's output on
  one stream, so Forge sends the test prefixed with its length in bytes and a newline; the
  judge bundle exports the inputs of such a problem in the same form
  (`inputFraming: "length-prefixed"` in `problem.json`). What the interactor writes to `tout`
  is not passed to a checker: the interactor's own verdict is final.

When an output is rejected, the build shows why: the first differing line for the default
comparison, the position and values for built-in checkers, and testlib's own comment
(`quitf(_wa, "expected %d, found %d", ...)`) for testlib checkers. `forge import-polygon package.zip` (or "Import from
Polygon" in the web UI) converts a Polygon package: tools, tests, groups, solutions with their
tags and statements, and lists what it could not carry over.

## Tests

```yaml
tests:
  - { manual: tests/tricky.in, answer: tests/tricky.ans, desc: "all numbers equal" }
  - { gen: rand, args: "n=1000 seed={i}", count: 3, desc: "random, small" }
```

A test does not have to be text. A file that is not UTF-8 is delivered byte for byte when the
evaluator has the `binary-input` feature (`EVALUATOR_FEATURES`); otherwise the build refuses it
(`test.binary`), because the released evaluator can only pass text. Generated tests are always
text.

`answer` names a hand-written answer file for a manual test; without it the main solution
produces the answer. `desc` is a note shown next to the test in builds. A build's inputs and
answers can be downloaded as a zip from the build page.

## Statements

`statement/<language>.md` is Markdown with KaTeX math. `{{N.max}}`, `{{N.min}}` (append `|raw`
to skip the `2 \cdot 10^5` formatting), `{{group.small.N.max}}`, `{{limits.time}}` and
`{{limits.memory}}` are filled from `problem.yaml`; `{{samples}}` places every sample test and
`{{sample.2}}` a single one, so an explanation can follow each. A placeholder that cannot be
filled makes the build red, as does `{{sample.3}}` when the package has fewer samples; write
`\{{` for a literal `{{` in TeX. Images are files of the package referenced relative to the
statement (`![](figure.png)` for `statement/figure.png`) and are exported with it. The
Statement tab edits a statement with a live preview and prints it.

## Program conventions

These follow what the current kontestis evaluator can do. Programs are single files.

**Generator.** Reads its arguments from the first line of stdin, prints the test to stdout. It
must be deterministic: the same arguments always give the same test.

**Validator.** Reads the test from stdin. Exit code 0 means valid; any other exit code means
invalid, with the reason on stderr. It runs once per group whose test set contains the test,
including groups that inherit it through `depends`, each time with that group's constraints.

**Checker.** Reads one stream from stdin made of four sections, each introduced by the same
random separator line (the first line of the stream): the test input, the expected answer, the
solution's output, and a closing separator. Prints `AC`, `WA`, or `custom:partial:<score>` with a score
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
verdict (`AC`, `WA` or `custom:partial:<score>`) to the file `interactor_meta.out`. See
[`examples/guess`](../examples/guess). A verdict other than `AC` written by the interactor decides
the run even when the solution then crashes on its closed input; on the current evaluator such a
run can instead surface as `TLE`, so expect `"WA|TLE"` from solutions the interactor rejects.

## Time limits

Solutions run with a measurement limit of three times the time limit, so a slow solution gets a
real time instead of "killed at the limit". The verdict is derived by applying the actual limit.
The build report then shows:

- **headroom**: time limit ÷ slowest run of a solution expected to pass (aim for ≥ 2),
- **separation**: fastest run of a solution expected to be too slow ÷ time limit (aim for ≥ 1.5),
- a suggested limit when one satisfies both.
