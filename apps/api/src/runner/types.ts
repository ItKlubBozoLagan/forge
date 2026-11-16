import { Language, RawRun } from "@forge/core";

export type Program = { source: string; language: Language };

export type RunInput = {
    id: string;
    stdin: string;
    /** Set instead of `stdin` when the input is not UTF-8 text (needs `binaryInput`). */
    stdinBase64?: string;
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
    /** Aborted when the build was cancelled: work not yet handed to the sandbox is dropped. */
    signal?: AbortSignal;
};

/** Judges outputs that already exist (output-only tasks): nothing of the contestant's runs. */
export type CheckRequest = {
    checking: "tokens" | Program;
    inputs: Array<{ id: string; stdin: string; expected: string; output: string }>;
};

/** Several instances of one program running at once, talking only through the manager. */
export type CommunicationRequest = {
    program: Program;
    manager: Program;
    inputs: RunInput[];
    processes: number;
    timeLimitMs: number;
    memoryLimitMb: number;
    signal?: AbortSignal;
};

/** What a runner can do beyond the evaluator's released protocol. */
export type Capabilities = { binaryInput: boolean; communication: boolean };

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
    readonly capabilities: Capabilities;
    check(request: CheckRequest): Promise<RunResult>;
    /** Simultaneous communication; only called when `capabilities.communication`. */
    communicate(request: CommunicationRequest): Promise<RunResult>;
    /** Whether the runner can take work right now. */
    alive(): Promise<boolean>;
    close(): Promise<void>;
}
