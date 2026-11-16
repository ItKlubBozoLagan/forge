# Architecture

Forge prepares contest problems: statements, tests, validators, checkers and solutions, with
continuous verification that they agree with each other. It is a standalone application. A
judge such as kontestis consumes its output: a frozen, verified bundle per problem set.

```
 web (React) ─┐                      ┌─ Postgres   problems, revisions, builds, build cache
 CLI ─────────┼── HTTP API ── engine ┼─ S3/MinIO   content-addressed blobs
              │                      └─ Runner ──── kontestis evaluator instances (Redis queue)
 kontestis ◄──┘  OAuth sign-in; judge bundle export
```

| Path | What it is |
|---|---|
| `packages/core` | Pure logic shared by API, web and CLI: manifest schema and planning, constraint injection, verdicts, scoring, the build report, statement rendering, templates |
| `apps/api` | HTTP API, build engine, runner adapters, background worker |
| `apps/web` | Web UI |
| `apps/cli` | `forge` command-line client |
| `e2e` | Playwright tests of the web UI against a real API |

## Problems, working copies and revisions

A problem belongs to a workspace and has one **working copy**: a tree mapping each path to a
blob hash. Edits change the working copy; `If-Match` (web editor) and per-path base hashes (CLI
`sync`) stop one author from silently overwriting another.

A **revision** is an immutable snapshot of the working copy with a message and an author. Creating
one queues its build. Problem sets pin revisions, never working copies.

## The build

Every step is a function of its inputs and is cached under the hash of those inputs
(`build_nodes`), per workspace:

| Step | Cache key |
|---|---|
| generate | generator source (with injected constraints), language, arguments |
| validate | validator source (with the group's constraints), language, input hash |
| answer | main solution source, language, input hash, limits |
| run | solution source, language, input hash, answer hash, checker, limits, task type |
| check | submitted output hash, input hash, answer hash, checker (output-only tasks) |

Editing one solution re-runs that solution only. Editing a generator regenerates its tests and
everything downstream of the tests that actually changed. Runner failures are never cached.

The report (`packages/core/src/report.ts`) is computed from the solution × test matrix: scores per
group, whether each solution met its expectations, time-limit calibration, and the kill matrix
(which tests catch which wrong solution).

### Run time is a measurement

Verdicts are cached; run time is not treated as a fact. Each fresh run adds a row to
`timing_samples` tagged with the runner pool and hardware class it ran on. A workspace can name
a **reference hardware class** (the machines its contests are judged on); builds measured on any
other class carry a warning that calibration is indicative only. "Re-measure" re-runs every
solution and adds another sample per run.

## The runner

`apps/api/src/runner/types.ts` defines the only interface that executes code: run one program on
a list of inputs, optionally with a checker or as an interaction with an interactor, and return
the status, time, memory and output of each run. A second operation, `check`, judges outputs that
already exist (output-only tasks) without running anything of the contestant's.

| Adapter | Use |
|---|---|
| `EvaluatorRunner` | Production path. Speaks the existing kontestis evaluator protocol over Redis, unchanged. Set `EVALUATOR_QUEUE_KEY` to the judge's queue to run on the same instances the contest is judged on |
| `LocalRunner` | Runs programs directly on the host with no sandbox. Development and tests only; refused when `NODE_ENV=production` |

A scheduler in front of the runner caps jobs in flight in total and per workspace and serves
waiting workspaces round-robin, so one tenant's stress run cannot starve the others.

The evaluator on `master` takes evaluation ids as unsigned integers, which is what kontestis
sends, and drops messages it cannot parse without answering. Its `feat/string-evaluation-id`
branch takes strings instead. `EVALUATOR_ID_FORMAT` selects `number` or `string`; the default
`auto` sends one probe of each form with the first job and keeps the one that is answered.

One message carries at most 64 tests, 6 MB of data and four minutes of worst-case run time
(tests × measurement limit); larger work is split. A job's timeout is `RUNNER_JOB_TIMEOUT_MS`
for waiting in the queue plus its own worst-case run time. A cancelled build stops sending
work; jobs already on the runner finish.

A run's time is the median of its samples on the build's hardware class once it has more than
one, so re-measuring steadies a borderline verdict.

### What the current evaluator protocol limits

- Test data travels inline in the message, so batches are split and very large tests are slow.
- Programs are a single file and get no command-line arguments; generators read their arguments
  from stdin.
- One single-file program per evaluation. Grader tasks are built by joining the solution and
  the grader into one source, and two-phase communication tasks by chaining ordinary runs; two
  contestant processes running at once cannot be expressed.
- An output-only evaluation carries one output and one test, so every submitted file is its own
  message.
- Results do not say which instance ran a job, so timing samples are attributed to the
  configured pool, not to a machine.
- When an interactor exits early the solution is left blocked until the wall-clock limit.
- Jobs have no priority, so prep work on a shared queue waits in line with judging and vice versa.

### Evaluator branch `feat/forge-runner`

Two things the released protocol cannot do are implemented on a local branch of evaluator-v2
and used when `EVALUATOR_FEATURES` names them:

- `binary-input`: a testcase may carry `input_encoding: "base64"`, and the program receives the
  decoded bytes.
- `communication`: a `Communication` evaluation runs the manager and N instances of the
  program, each in its own sandbox, relaying lines between them (the protocol is in the package
  format docs). It needs N + 1 sandboxes, so `EVALUATOR_MAX_EVALUATIONS` must be at least 3; an
  evaluation that can never fit is answered with a system error instead of being dropped, and
  one that has to wait for sandboxes waits.

### Planned runner protocol

The build engine already works in terms of hashed blobs, so the adapter is the only thing that
changes:

1. **Blob references** instead of inline data (the direction of kontestis PR #133, which moves
   testcase files to object references).
2. **A generic run step**: program + argv + input blobs → output blobs + resource usage. This
   covers generators, validators, checkers and solutions with one job type.
3. **Multi-file programs and several processes**: graders without source joining, and communication tasks whose processes run at the same time.
4. **Instance identity and priority classes** in the protocol: per-machine timing samples, and
   judging that pre-empts prep work on shared instances.

## Tenancy and access

- One hosted instance, many **workspaces**. A workspace mirrors a kontestis organisation
  (`kontestis_org_id`) or is created locally; every user also gets a personal one.
- **Problems are private inside a workspace.** Members see only problems they were added to;
  workspace owners see all.
- Problem roles: `owner`, `author`, `viewer`, and `tester`. Testers are blind: they read the
  statement, run their own solutions against the latest revision and see per-group outcomes, but
  cannot read files, tests, builds or revisions.
- **Blobs are content addressed but read through a workspace's reference.** Knowing a hash from
  another tenant gives nothing.
- Unknown and inaccessible resources both answer 404.
- Sensitive actions are written to an audit log per workspace.

## Sign-in

Identity comes from kontestis through its OAuth 2.0 provider (kontestis PR #146). Forge is one
registered client. At login it exchanges the code, reads `userinfo` once, upserts the user,
mirrors their organisations as workspaces (organisation admins become workspace owners), and
from then on runs its own session. Roles on problems are Forge's own and are not derived from
kontestis permissions.

The CLI cannot be a kontestis client (clients are confidential), so it signs in through the
Forge web app: a loopback redirect hands it a personal access token.

`AUTH_DEV_LOGIN=true` enables a password-less login for local development and tests.

## Judge bundle

`GET /api/sets/:id/export` produces a zip for a problem set whose pinned revisions are all green:

```
bundle.json                       { format: "forge-bundle/1", name, problems }
A/problem.json                    limits, scoring, groups (with points, dependencies, test ids), checker
A/tests/<group>-<nnn>.in / .out   inputs and reference answers
A/statement/<lang>.md             statements with constraints and samples filled in
A/checker.<ext>                   checker with the constraints already injected
```

This is the integration point for kontestis: importing a bundle replaces authoring problems
inside the judge.
