export const VERDICTS = ["AC", "PA", "WA", "TLE", "MLE", "RE", "CE", "JE"] as const;
/**
 * AC accepted, PA partial score, WA wrong answer, TLE/MLE limits, RE runtime error,
 * CE compilation error, JE judge error (checker or sandbox failure).
 */
export type Verdict = (typeof VERDICTS)[number];

export type TestResult = {
    verdict: Verdict;
    /** Score in [0, 1]. */
    score: number;
    timeMs: number;
    memoryKb: number;
    message?: string;
};

/** Raw outcome of one sandboxed run, before the problem's time limit is applied. */
export type RawRun = {
    status: "accepted" | "wrong_answer" | "custom" | "time_limit_exceeded" | "memory_limit_exceeded" | "runtime_error" | "compilation_error" | "judge_error";
    /** Checker payload for `custom`: a score in [0, 1]. */
    data?: string;
    timeMs: number;
    memoryKb: number;
    message?: string;
};

/**
 * Programs run with a measurement limit above the real time limit so slow solutions get a
 * real time, not just "killed at the limit". The verdict is derived here by applying the
 * actual limit, which also means changing the limit does not need a re-run.
 */
export const judge = (raw: RawRun, timeLimitMs: number): TestResult => {
    const base = { timeMs: raw.timeMs, memoryKb: raw.memoryKb, message: raw.message };
    switch (raw.status) {
        case "compilation_error":
            return { ...base, verdict: "CE", score: 0 };
        case "judge_error":
            return { ...base, verdict: "JE", score: 0 };
        case "time_limit_exceeded":
            return { ...base, verdict: "TLE", score: 0 };
        case "memory_limit_exceeded":
            return { ...base, verdict: "MLE", score: 0 };
        case "runtime_error":
            return { ...base, verdict: "RE", score: 0 };
    }
    if (raw.timeMs > timeLimitMs) return { ...base, verdict: "TLE", score: 0 };
    if (raw.status === "accepted") return { ...base, verdict: "AC", score: 1 };
    if (raw.status === "wrong_answer") return { ...base, verdict: "WA", score: 0 };
    const score = Number(raw.data);
    if (!Number.isFinite(score) || score < 0 || score > 1)
        return {
            ...base,
            verdict: "JE",
            score: 0,
            message: `checker returned an invalid score "${raw.data ?? ""}"`,
        };
    if (score >= 1) return { ...base, verdict: "AC", score: 1 };
    if (score <= 0) return { ...base, verdict: "WA", score: 0 };
    return { ...base, verdict: "PA", score };
};

/** How far above the time limit programs are allowed to run so their real time is measured. */
export const MEASUREMENT_FACTOR = 3;
export const measurementLimitMs = (timeLimitMs: number) =>
    Math.min(Math.ceil(timeLimitMs * MEASUREMENT_FACTOR), 120_000);

const FAILING: readonly Verdict[] = ["PA", "WA", "TLE", "MLE", "RE", "CE", "JE"];

/**
 * `AC` means every test passes. Anything else means at least one test fails and every
 * failing test has one of the listed verdicts (`FAIL` allows any failure).
 */
export const meetsExpectation = (expected: string, verdicts: readonly Verdict[]): boolean => {
    const failing = verdicts.filter((verdict) => verdict !== "AC");
    const allowed = expected.split("|").map((part) => part.trim());
    if (allowed.includes("AC")) return failing.length === 0;
    if (failing.length === 0) return false;
    if (allowed.includes("FAIL")) return failing.every((verdict) => FAILING.includes(verdict) && verdict !== "CE" && verdict !== "JE");
    return failing.every((verdict) => allowed.includes(verdict));
};

/** Short description of a group's outcome, e.g. "AC" or "TLE, WA". */
export const summarize = (verdicts: readonly Verdict[]): string => {
    const failing = [...new Set(verdicts.filter((verdict) => verdict !== "AC"))].sort();
    return failing.length === 0 ? "AC" : failing.join(", ");
};
