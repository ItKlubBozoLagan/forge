/** Response shapes of the Forge API (see docs/api.md). */
import type { Constraints, Issue, Language, Report, TestResult } from "@forge/core";

export type WorkspaceRole = "owner" | "member";
export type ProblemRole = "owner" | "author" | "viewer" | "tester";

export type Workspace = {
    id: string;
    name: string;
    role: WorkspaceRole;
    kontestisOrgId: string | null;
    referenceClass: string | null;
};

export type Me = {
    user: { id: string; name: string; email: string | null; picture: string | null };
    workspaces: Workspace[];
};

export type AuthConfig = { devLogin: boolean; oauth: boolean };

export type Token = { id: string; name: string; createdAt: string; lastUsedAt: string | null };

export type Member = { id: string; name: string; email: string | null; role: string };

export type AuditEntry = {
    id: string;
    action: string;
    detail: Record<string, unknown> | null;
    at: string;
    userName: string | null;
    problemId: string | null;
    problemName: string | null;
};

export type ProblemSummary = {
    id: string;
    name: string;
    title: string;
    createdAt: string;
    role: ProblemRole;
    revisions: number;
    lastResult: "green" | "red" | null;
};

export type Problem = {
    id: string;
    name: string;
    title: string;
    role: ProblemRole;
    workspace: { id: string; name: string; referenceClass: string | null };
    draftVersion: number;
    head: { id: string; number: number } | null;
    dirty?: boolean;
};

export type TreeFile = { path: string; hash: string; size: number };
export type Tree = { version: number; files: TreeFile[] };

export type Revision = {
    id: string;
    number: number;
    message: string;
    createdAt: string;
    author: string;
    build: { id: string; status: BuildStatus; result: BuildResult } | null;
};

export type BuildStatus = "queued" | "running" | "done" | "failed";
export type BuildResult = "green" | "red" | null;
export type BuildKind = "build" | "invocation" | "stress";

export type BuildSummary = {
    id: string;
    kind: BuildKind;
    revisionId: string | null;
    status: BuildStatus;
    result: BuildResult;
    progress: { phase: string; done: number; total: number } | null;
    error: string | null;
    createdBy: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    name?: string;
};

/** Re-declared from apps/api/src/engine/engine.ts. */
export type BuildTest = {
    id: string;
    group: string;
    index: number;
    source: string;
    inputHash?: string;
    inputSize?: number;
    answerHash?: string;
    error?: string;
    validation: Record<string, string | null>;
    /** The author's note on the test. */
    desc?: string;
    /** Set when the answer is a hand-written file instead of the main solution's output. */
    answerFile?: string;
};

export type BuildGroup = {
    name: string;
    points: number;
    aggregate: "min" | "sum";
    sample: boolean;
    depends: string[];
    constraints: Constraints;
    tests: string[];
    closure: string[];
};

export type BuildOutput = {
    report: Report;
    tests: BuildTest[];
    matrix: Record<string, Record<string, TestResult>>;
    runKeys: Record<string, Record<string, string>>;
    groups: BuildGroup[];
    limits?: { time_ms: number; memory_mb: number };
    type?: string;
    scoring?: string;
    checker?: string;
    validator?: string;
    runner: { pool: string; hardwareClass: string };
};

/** What a blind tester gets back for their own invocation. */
export type RedactedOutput = {
    report: Pick<Report, "status" | "solutions" | "issues"> & {
        calibration: { timeLimitMs: number };
    };
    groups: Array<{ name: string; points: number; sample: boolean }>;
    limits?: { time_ms: number; memory_mb: number };
};

/** Re-declared from apps/api/src/engine/stress.ts. */
export type StressOutput = {
    total: number;
    passed: number;
    failures: Array<{
        args: string;
        verdict: string;
        message?: string;
        inputHash: string;
        inputSize: number;
        timeMs: number;
        answerHash?: string;
        outputHash?: string;
    }>;
    invalid: Array<{ args: string; message: string }>;
    errors: string[];
};

export type StressParams = {
    generator: string;
    args: string;
    count: number;
    seedStart: number;
    solution: string;
    group: string;
};

export type BuildDetail<O = BuildOutput | RedactedOutput | StressOutput> = BuildSummary & {
    params?: Record<string, unknown>;
    name?: string;
    output: O | null;
};

export type TimingStat = {
    hardwareClass: string;
    count: number;
    min: number;
    median: number;
    max: number;
};
export type Timing = {
    referenceClass: string | null;
    samples: Record<string, Record<string, TimingStat[]>>;
};

export type Statement = {
    languages: string[];
    language: string | null;
    markdown: string;
    unresolved: string[];
    samplesBuilt: boolean;
    limits?: { time_ms: number; memory_mb: number };
    groups?: Array<{ name: string; points: number; sample: boolean }>;
    /** The statement file and its raw Markdown (not sent to blind testers). */
    path?: string;
    source?: string;
};

export type StatementPreview = { markdown: string; unresolved: string[]; samplesBuilt: boolean };

export type Health = {
    ok: boolean;
    runner: { kind: string; pool: string; hardwareClass: string; alive?: boolean };
};

export type Comment = {
    id: string;
    body: string;
    author: string;
    authorId: string;
    createdAt: string;
};
export type Thread = {
    id: string;
    path: string | null;
    line: number | null;
    resolved: boolean;
    revisionId: string | null;
    createdAt: string;
    comments: Comment[];
};

export type ProblemSetSummary = { id: string; name: string; createdAt: string; problems: number };
export type SetEntry = {
    label: string;
    problemId: string;
    revisionId: string;
    name?: string;
    title?: string;
    number?: number;
    result?: BuildResult;
    status?: BuildStatus | null;
};
export type ProblemSet = { id: string; name: string; workspaceId: string; entries: SetEntry[] };
export type ExportBlocker = {
    label: string;
    problem: string;
    revision: number | string;
    result: string | null;
};

export type { Issue, Language };
