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
control, problem sets and judge bundle export, OAuth sign-in, web UI and CLI.

Not done yet:

- **Runner protocol.** Forge speaks the evaluator's current protocol, so it builds every task
  type kontestis judges today: batch (token comparison or a checker), interactive and
  output-only. Communication and grader tasks can be described but not built; they need
  multi-process runs and multi-file compilation in the evaluator. See
  [architecture.md](docs/architecture.md#the-runner).
- **kontestis import.** The judge bundle is exported; kontestis does not import it yet. Forge
  can express things kontestis cannot score today: `aggregate: sum`, group `depends`,
  fractional points, binary scoring and output-only groups with several tests. Nothing warns
  about them yet.
- **Editing the manifest.** `problem.yaml` is edited as text with live validation; there are no
  forms for tests, groups, solutions or expectations, and renaming a file does not update
  references to it.
- **Bulk files.** Files are uploaded one at a time (16 MB each); there is no zip upload and no
  download of a package or of its generated tests as an archive.
- **Long jobs.** A runner job that takes more than `RUNNER_JOB_TIMEOUT_MS` (15 minutes,
  counted from when it is queued) is reported as a judge error, and builds cannot be cancelled.
  Up to 64 tests go in one job at three times the time limit, so slow solutions on large
  groups with limits near 5 s can hit this.
- **Timing.** Verdicts and calibration use the latest measurement of a run, not a statistic
  over its samples, and there is no rebuild that ignores the cache of generators and answers.
- **Large tests.** Test data is held in memory as text and sent inline to the evaluator; sets
  of hundreds of megabytes are untested and binary tests are not supported.
- **Revisions and review.** Revisions can be restored but not browsed or compared, and review
  comments are not anchored in the editor.
- **Checkers.** No built-in checkers beyond token comparison (no float tolerance), no testlib
  compatibility, no hand-written answer files for manual tests, no import from Polygon.
- **Checker messages.** The evaluator discards what a checker prints to stderr, so a wrong
  answer has no explanation beyond the solution's output.
- **Reference hardware.** Builds warn when measured off the reference class but do not block a
  green result on it.
- **One working copy per problem.** Authors share it, with conflict detection per file; there
  are no per-author branches.
- **Deployment.** No production deployment configuration.
