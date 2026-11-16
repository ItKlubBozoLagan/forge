# Forge

A preparation system for programming-contest problems: write the statement, tests, validator,
checker and solutions, and have the system prove continuously that they agree with each other.
It supports ICPC, IOI and HONI style problems, has a web UI and a CLI over the same package
format, and runs code on kontestis evaluator instances.

What it does that Polygon does not:

- **One source of constraints.** Bounds are written once in `problem.yaml` and injected into
  the validator, generators, checker and statement.
- **Expectations are checked, not eyeballed.** Every solution declares what should happen per
  group (`AC`, `TLE`, `WA`...). A revision is green only when all of them hold and every test
  validates against every group that contains it.
- **Incremental builds.** Each step is cached by the hash of its inputs; editing one solution
  re-runs one solution.
- **Measured time limits.** Solutions run past the limit so slow ones get a real time; the
  report shows headroom, separation and a suggested limit. Samples are tagged with the hardware
  they ran on.
- **Test strength.** A kill matrix shows which tests catch which wrong solution; stress testing
  finds counterexamples and promotes them into the test plan.
- **Review and access.** Immutable revisions, review threads, blind testers, audit log, and
  problems that are private inside a workspace.

Documentation: [package format](docs/package-format.md), [architecture](docs/architecture.md),
[HTTP API](docs/api.md).

## Running it locally

Requirements: Node 22, pnpm 9, and Postgres, Redis, S3-compatible storage and a kontestis
evaluator. The defaults in `.env.example` use the kontestis development stack on the same
machine; `docker-compose.yml` starts separate infrastructure instead.

```sh
pnpm install
cp .env.example .env

# once: a database in the kontestis dev Postgres
docker exec kontestis-postgres-1 psql -U kontestis -d postgres -c 'CREATE DATABASE forge'

# an evaluator on its own queue (image built from the evaluator-v2 repository)
docker run -d --name forge-evaluator --privileged \
    --env RUN_WITH_CGROUPS=true --env RUN_WITH_QUOTAS=false \
    --env REDIS_QUEUE_KEY=forge_evaluator_queue \
    --add-host=host.docker.internal:host-gateway \
    --env REDIS_URL=redis://host.docker.internal:6379 kontestis-evaluator-v2:latest

pnpm dev        # API on :8090, web on http://localhost:3200
```

Sign in with the development login, create a problem from a template and press **Build**.

To run without the kontestis stack, `docker compose up -d` starts Postgres, Redis, MinIO and an
evaluator of Forge's own on other ports. Put these in `.env`:

```sh
DATABASE_URL=postgresql://forge:forge@localhost:5433/forge
REDIS_URL=redis://localhost:6380
S3_PORT=9002
```

and give the tests the same infrastructure (after creating the databases `forge_test` and
`forge_e2e` in it):

```sh
export REDIS_URL=redis://localhost:6380 S3_PORT=9002
export TEST_DATABASE_URL=postgresql://forge:forge@localhost:5433/forge_test
export E2E_DATABASE_URL=postgresql://forge:forge@localhost:5433/forge_e2e
```

To run on the same evaluator instances a judge uses, set `EVALUATOR_QUEUE_KEY` to the judge's
queue (`evaluator_msg_queue` for kontestis) and `RUNNER_HARDWARE_CLASS` to a name for that
hardware.

`RUNNER=local` runs programs on the host without a sandbox. It exists for development and tests
and is refused in production.

### Sign in with kontestis

Register Forge as an OAuth client in kontestis (`OAUTH_PROVIDER_CLIENTS`, kontestis PR #146)
with the redirect URI `<PUBLIC_API_URL>/auth/callback`, then set `OAUTH_CLIENT_ID`,
`OAUTH_CLIENT_SECRET`, `OAUTH_AUTHORIZE_URL`, `OAUTH_TOKEN_URL` and `OAUTH_USERINFO_URL`.

## CLI

```sh
alias forge="node $PWD/apps/cli/bin/forge.js"

forge login                                   # opens the browser
forge new sums --title "Sums" --template ioi  # create on the server and clone into ./sums
cd sums
forge status                                  # local and remote changes
forge push                                    # upload local changes
forge pull                                    # conflicts keep your file and write <path>.remote
forge build                                   # exit 0 green, 1 red, 2 failed
forge commit -m "Tighten the time limit"      # push, create a revision, wait for its build
forge invoke ~/try/fast.cpp                   # run a solution that is not in the package
forge stress --generator rand --solution solutions/brute.cpp --group small \
    --args "n=8 maxv=5 seed={seed}" --count 200
```

Configuration lives in `~/.config/forge/config.json` (`FORGE_API_URL` and `FORGE_TOKEN`
override it). A checkout keeps its state in `.forge/state.json`; `.forgeignore` lists files to
skip.

## Tests

```sh
pnpm typecheck
pnpm test          # unit tests, and API integration tests on the local runner
pnpm e2e           # Playwright tests of the web UI against a real API

FORGE_TEST_EVALUATOR=1 pnpm --filter @forge/api test   # also test the evaluator adapter
FORGE_E2E_RUNNER=evaluator pnpm e2e                    # browser tests on a real evaluator
```

The integration and e2e tests need the databases `forge_test` and `forge_e2e` and reset them on
every run.

## Status

Working end to end: packages, builds, revisions, stress testing, invocations, review, access
control, problem sets and judge bundle export, Polygon import, OAuth sign-in, web UI and CLI.

Not done, and why:

- **Simultaneous communication.** Grader tasks and two-phase communication tasks (two runs
  with a manager in between) build. Two contestant processes talking to each other at the same
  time do not: the evaluator runs one program per evaluation
  ([architecture.md](docs/architecture.md#the-runner)). kontestis itself judges neither grader
  nor communication tasks yet, and the Structure tab edits `grader` and `manager` as text only.
- **Comments from hand-written checkers.** The evaluator returns only a verdict. Forge still
  shows why an output was rejected for the default comparison, built-in checkers and testlib
  checkers (it runs those once more to print their comment); a checker written to Forge's own
  protocol has no channel for a comment.
- **Binary and very large tests.** Test data travels to the evaluator inline as JSON text, so
  tests must be UTF-8 text, and sets of hundreds of megabytes are untested.
- **kontestis import.** The judge bundle is exported; kontestis does not import it yet. Set
  `judge: kontestis` in `problem.yaml` to be warned about what kontestis cannot score today
  (summed groups, group dependencies, fractional points, binary scoring, output-only groups
  with several tests).
- **Polygon import** converts packages with groups or with one testset per subtask, including
  per-testset solution tags and testlib interactors. It was checked against a real package
  from a public contest archive for the conversion; statements are converted from TeX only
  roughly, a solution tagged "time-limit-exceeded-or-accepted" without per-testset tags is
  skipped, and resource files other than testlib.h are not imported.
- **Reference hardware.** Builds warn when measured off the reference class but do not block a
  green result on it.
- **One working copy per problem.** Authors share it, with conflict detection per file; there
  are no per-author branches. Review comments keep their line number when the file changes.
- **One API process.** Builds are run by the API process itself; on start it re-queues builds
  that were running, so a second API process against the same database is not supported.
- **Deployment.** No production deployment configuration.
