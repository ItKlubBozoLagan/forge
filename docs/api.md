# HTTP API

Base path `/api`. JSON in and out unless noted. IDs are decimal strings.

Errors: `{ "error": { "code", "message", "detail"? } }` with status 400 / 401 / 403 / 404 / 409.
Unknown and inaccessible resources both answer 404.

## Authentication

- Web: session cookie `forge_session` (httpOnly). Every non-GET request made with the cookie must
  send the header `X-Forge-Csrf: 1`.
- CLI: `Authorization: Bearer fpat_...` (personal access token). No CSRF header needed.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/auth/config` | | `{ devLogin: boolean, oauth: boolean }` |
| GET | `/auth/login?redirect=/path` | | 302 to the identity provider (when `oauth`) |
| GET | `/auth/callback` | | OAuth callback; sets the cookie, 302 to the web app (`/login?error=...` on failure) |
| POST | `/auth/dev-login` | `{ name }` | `{ ok }`, sets the cookie (only when `devLogin`) |
| POST | `/auth/logout` | | `{ ok }` |
| GET | `/me` | | `{ user: { id, name, email, picture }, workspaces: [{ id, name, role: "owner"\|"member", kontestisOrgId, referenceClass }] }` |
| GET | `/tokens` | | `[{ id, name, createdAt, lastUsedAt }]` |
| POST | `/tokens` | `{ name }` | `{ id, name, token }` (the token is shown once) |
| DELETE | `/tokens/:id` | | `{ ok }` |
| GET | `/health` | | `{ ok, runner: { kind, pool, hardwareClass } }` |

## Workspaces

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/workspaces` | `{ name }` | `{ id, name, role }` |
| PATCH | `/workspaces/:id` | `{ name?, referenceClass? }` | `{ ok }` (owner) |
| GET | `/workspaces/:id/members` | | `[{ id, name, email, role }]` |
| POST | `/workspaces/:id/members` | `{ email, role? }` | `{ id, name, role }` (owner; user must have signed in once) |
| DELETE | `/workspaces/:id/members/:userId` | | `{ ok }` (owner) |
| GET | `/workspaces/:id/audit` | | `[{ id, action, detail, at, userName, problemId, problemName }]` (owner) |

## Problems

Roles on a problem: `owner`, `author`, `viewer`, `tester`. Workspace owners are owners of every
problem. Capabilities: *participate* (all roles), *read* (owner, author, viewer), *write* (owner,
author), *manage* (owner). Testers are blind: they cannot read files, builds or revisions.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/workspaces/:id/problems` | | `[{ id, name, title, createdAt, role, revisions, lastResult: "green"\|"red"\|null }]` (only problems the caller can access) |
| POST | `/workspaces/:id/problems` | `{ name, title, template: "ioi"\|"icpc"\|"honi"\|"interactive"\|"output-only"\|"empty" }` | `{ id, name, title }` |
| GET | `/problems/:id` | | `{ id, name, title, role, workspace: { id, name, referenceClass }, draftVersion, head: { id, number } \| null, dirty? }` |
| PATCH | `/problems/:id` | `{ title }` | `{ ok }` (write) |
| DELETE | `/problems/:id` | | `{ ok }` (manage) |
| GET | `/problems/:id/access` | | `[{ id, name, email, role }]` (read) |
| PUT | `/problems/:id/access/:userId` | `{ role }` | `{ ok }` (manage; user must be a workspace member) |
| DELETE | `/problems/:id/access/:userId` | | `{ ok }` (manage) |

### Files (the working copy)

`?revision=<revisionId>` on the read endpoints reads a revision instead of the working copy.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/problems/:id/tree` | | `{ version, files: [{ path, hash, size }] }` (read) |
| GET | `/problems/:id/file?path=` | | raw bytes, `ETag: <hash>` (read) |
| PUT | `/problems/:id/file?path=` | raw bytes, `Content-Type: application/octet-stream`, optional `If-Match: <hash loaded>` | `{ hash, size, version }`; 409 when the file changed since `If-Match` (write) |
| DELETE | `/problems/:id/file?path=` | | `{ version }` (write) |
| POST | `/problems/:id/rename` | `{ from, to }` | `{ version }` (write) |
| GET | `/problems/:id/blobs/:hash` | | raw bytes (read). Test inputs and answers of a build are read this way |
| POST | `/problems/:id/blobs` | raw bytes | `{ hash, size }` (write); uploads content without changing the working copy |
| POST | `/problems/:id/sync` | `{ changes: [{ path, base: hash\|null, hash: hash\|null }], force? }` | `{ version, files }`; 409 with `detail: [{ path, current }]` when a path moved on the server (write) |

`sync` applies all changes atomically. `base` is the hash the client last saw (`null` = did not
exist); `hash: null` deletes. Contents must be uploaded with `POST /blobs` first.

`GET /problems/:id/archive` (optional `?revision=`, read) returns the package as a zip.
`outputHash` in a build's matrix is what the solution printed on that test (or the submitted
file of an output-only solution), readable through the blob route below.
`GET /problems/:id/blobs/:hash` serves content that belongs to the problem: files of its working
copy and revisions, what its builds produced, and what was uploaded for it through
`POST /problems/:id/blobs`. `sync` accepts the same set of hashes.

`POST /workspaces/:id/import/polygon` takes a Polygon package (zip, `application/octet-stream`,
up to 256 MB) and returns `{ id, name, title, notes }`.

### Revisions

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/problems/:id/revisions` | | `[{ id, number, message, createdAt, author, build: { id, status, result } \| null }]` (read) |
| POST | `/problems/:id/revisions` | `{ message }` | `{ id, number, buildId }`; freezes the working copy and queues its build; 409 when nothing changed (write) |
| POST | `/problems/:id/revisions/:revisionId/restore` | | `{ version }`; copies the revision back into the working copy (write) |

### Builds

A build has `status`: `queued`, `running`, `done`, `failed`, and once done a `result`: `green` or
`red`. Poll `GET /builds/:id` (about once a second) until `done` or `failed`.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/problems/:id/builds` | `{ revision?, remeasure?, clean? }` | `{ id }`; builds the working copy, or a revision; `clean` ignores every cached step (write) |
| GET | `/problems/:id/builds?kind=build\|invocation\|stress` | | `[BuildSummary]`, newest first |
| GET | `/builds/:id` | | `BuildSummary & { params, name?, output }` |
| GET | `/builds/:id/timing` | | `{ referenceClass, samples: { [solution]: { [testId]: [{ hardwareClass, count, min, median, max }] } } }` |
| POST | `/problems/:id/invocations` | `{ name, language, source, revision? }` | `{ id }`; runs a solution that is not in the package (participate) |
| POST | `/problems/:id/stress` | `{ generator, args, count, seedStart?, solution, group }` | `{ id }` (write); `args` must contain `{seed}` |
| POST | `/builds/:id/promote` | `{ args }` | `{ version }`; adds a failing stress case to problem.yaml (write) |
| GET | `/problems/:id/statement?lang=&revision=` | | `{ languages, language, markdown, unresolved, samplesBuilt, limits, groups }`, plus `path` and `source` (the file and its raw Markdown) for users who can read the package (participate) |
| GET | `/problems/:id/statement/asset?path=&revision=` | | A non-Markdown file under `statement/` (figures), with an image content type; blind testers get the latest revision's (participate) |

`BuildSummary`: `{ id, kind, revisionId, status, result, progress: { phase, done, total }, error, createdBy, createdAt, startedAt, finishedAt, name? }`.

`output` of a `build` or `invocation`:

```ts
{
  report: {
    status: "green" | "red",
    solutions: [{
      path, main, score, maxScore, maxTimeMs, ok,
      groups: [{ group, verdicts: Verdict[], summary, score, maxScore, maxTimeMs, maxMemoryKb, expected?, meets? }]
    }],
    calibration: { timeLimitMs, slowestAcceptedMs?, slowestAccepted?, fastestRejectedMs?, fastestRejected?, headroom?, separation?, suggestedMs? },
    kills: [{ solution, killedBy: testId[] }],
    decisiveTests: testId[],
    issues: [{ severity: "error" | "warning", code, message, ref? }]
  },
  tests: [{ id, group, index, source, desc?, answerFile?, inputHash?, inputSize?, answerHash?, error?, validation: { [group]: string | null } }],
  matrix: { [solutionPath]: { [testId]: { verdict, score, timeMs, memoryKb, message?, outputHash? } } },
  runKeys: { [solutionPath]: { [testId]: string } },
  groups: [{ name, points, aggregate, sample, depends, constraints, tests: testId[], closure: testId[] }],
  limits: { time_ms, memory_mb }, type, scoring, checker?, validator?, runner: { pool, hardwareClass }
}
```

`tests[].validation` holds what the validator said about the test for each group whose constraints
it must satisfy (its own group and every group depending on it): `null` when valid, otherwise the
validator's message. It is empty when the package has no validator.

`Verdict` is one of `AC PA WA TLE MLE RE CE JE`. For an invocation, `report.solutions` holds the
single ad-hoc solution. Blind testers get a redacted output for their own invocations:
`{ report: { status, solutions, calibration: { timeLimitMs }, issues }, groups: [{ name, points, sample }], limits }`.
Its `issues` hold only the tester's own compiler output (`solution.compile`) and judge failures
(`run.*`).

`output` of a `stress` run:

```ts
{ total, passed,
  failures: [{ args, verdict, message?, inputHash, inputSize, timeMs, answerHash?, outputHash? }],
  invalid: [{ args, message }],   // generated tests the validator rejected
  errors: string[] }
```

More build routes:

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/builds/:id/cancel` | | (write, or the build's creator) Stops a queued or running build; it ends `failed` with `error: "Cancelled by <name>"` (409 once finished) |
| GET | `/builds/:id/tests.zip` | | (read) Inputs and answers as `<group>/<index>.in` / `.out` |
| POST | `/problems/:id/statement/preview` | `{ markdown }` | (read) `{ markdown, unresolved, samplesBuilt }` rendered against the working copy |
| GET | `/health?runner=1` | | (signed in) Adds `runner.alive`: results arrived recently, work is in flight, or a probe was answered |

`POST /problems/:id/invocations` runs against the working copy unless `revision` is given
(blind testers always run against the latest revision).

## Review

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/problems/:id/threads` | | `[{ id, path, line, resolved, revisionId, createdAt, comments: [{ id, body, author, authorId, createdAt }] }]` |
| POST | `/problems/:id/threads` | `{ body, path?, line?, revision? }` | `{ id }` |
| POST | `/threads/:id/comments` | `{ body }` | `{ ok }` |
| PATCH | `/threads/:id` | `{ resolved }` | `{ ok }` |

## Problem sets

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/workspaces/:id/sets` | | `[{ id, name, createdAt, problems }]` |
| POST | `/workspaces/:id/sets` | `{ name }` | `{ id, name }` |
| GET | `/sets/:id` | | `{ id, name, workspaceId, entries: [{ label, problemId, revisionId, name, title, number, result, status }] }` |
| PUT | `/sets/:id/entries` | `{ entries: [{ label, problemId, revisionId }] }` | `{ entries }` (replaces all) |
| DELETE | `/sets/:id` | | `{ ok }` |
| GET | `/sets/:id/export` | | zip (the judge bundle); 409 with `detail: [{ label, problem, revision, result }]` unless every pinned revision is green (workspace owner) |
