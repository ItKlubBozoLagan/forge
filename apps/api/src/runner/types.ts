import { Language, RawRun } from "@forge/core";

export type Program = { source: string; language: Language };

export type RunInput = {
    id: string;
    stdin: string;
    /** Expected output handed to the checker. */
    expected?: string;
};

/**
 * `capture` only collects stdout. `tokens` compares stdout to `expected` ignoring
 * whitespace differences. A program is a custom checker (or the interactor).
 */
export type Checking = "capture" | "tokens" | Program;

export type RunRequest = {
    program: Program;
    inputs: RunInput[];
    checking: Checking;
    interactive?: boolean;
    timeLimitMs: number;
    memoryLimitMb: number;
};

/** Judges outputs that already exist (output-only tasks): nothing of the contestant's runs. */
export type CheckRequest = {
    checking: "tokens" | Program;
    inputs: Array<{ id: string; stdin: string; expected: string; output: string }>;
};

export type RunOutcome = RawRun & { id: string; stdout?: string };

export type RunResult = {
    /** Set when the program (or its checker) failed to compile; `runs` is then empty. */
    compileError?: string;
    runs: RunOutcome[];
};

/**
 * The only component that executes code. Today it is backed by the kontestis evaluator's
 * existing protocol; the planned runner protocol (blob references, generic run step, argv,
 * multi-file programs) replaces the adapter without touching the build engine.
 */
export interface Runner {
    readonly pool: string;
    readonly hardwareClass: string;
    run(request: RunRequest): Promise<RunResult>;
    check(request: CheckRequest): Promise<RunResult>;
    close(): Promise<void>;
}
