import { Issue, Plan } from "./manifest";
import { meetsExpectation, summarize, TestResult, Verdict } from "./verdicts";

export type GroupOutcome = {
    group: string;
    verdicts: Verdict[];
    summary: string;
    score: number;
    maxScore: number;
    maxTimeMs: number;
    maxMemoryKb: number;
    expected?: string;
    /** Undefined when the solution states no expectation for the group. */
    meets?: boolean;
};

export type SolutionReport = {
    path: string;
    main: boolean;
    groups: GroupOutcome[];
    score: number;
    maxScore: number;
    maxTimeMs: number;
    ok: boolean;
};

export type Calibration = {
    timeLimitMs: number;
    /** Slowest test of any solution on a group where it is expected to be accepted. */
    slowestAcceptedMs?: number;
    slowestAccepted?: string;
    /** Fastest "too slow" solution: its slowest test on a group where TLE is expected. */
    fastestRejectedMs?: number;
    fastestRejected?: string;
    /** timeLimit / slowestAccepted. */
    headroom?: number;
    /** fastestRejected / timeLimit. */
    separation?: number;
    suggestedMs?: number;
};

export type KillRow = {
    solution: string;
    /** Tests on which the solution fails, among groups where it is expected to fail. */
    killedBy: string[];
};

export type Report = {
    status: "green" | "red";
    solutions: SolutionReport[];
    calibration: Calibration;
    kills: KillRow[];
    /** Tests that are the only one killing some wrong solution. */
    decisiveTests: string[];
    issues: Issue[];
};

/** `results[solutionPath][testId]`. */
export type Matrix = Record<string, Record<string, TestResult>>;

const niceCeil = (ms: number) => {
    const steps = [100, 200, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10_000, 15_000, 20_000, 30_000, 60_000];
    return steps.find((step) => step >= ms) ?? Math.ceil(ms / 10_000) * 10_000;
};

export const HEADROOM_TARGET = 2;
export const SEPARATION_TARGET = 1.5;

export const buildReport = (plan: Plan, matrix: Matrix, upstream: Issue[] = []): Report => {
    const issues: Issue[] = [...upstream];
    const timeLimitMs = plan.manifest.limits.time_ms;
    const groupByName = new Map(plan.groups.map((group) => [group.name, group]));

    const solutions: SolutionReport[] = [];
    const calibration: Calibration = { timeLimitMs };
    const kills: KillRow[] = [];

    for (const solution of plan.solutions) {
        const results = matrix[solution.path];
        if (!results) continue;
        const outcomes: GroupOutcome[] = [];
        const fullyPassed = new Set<string>();

        for (const group of plan.groups) {
            const own = group.closure.map((id) => results[id]).filter((r): r is TestResult => !!r);
            const verdicts = own.map((result) => result.verdict);
            const scores = own.map((result) => result.score);
            let fraction = 0;
            if (scores.length > 0)
                fraction =
                    group.aggregate === "min"
                        ? Math.min(...scores)
                        : scores.reduce((sum, value) => sum + value, 0) / scores.length;
            const passed = verdicts.length > 0 && verdicts.every((verdict) => verdict === "AC");
            if (passed) fullyPassed.add(group.name);
            const expected = solution.expect[group.name];
            const meets =
                expected === undefined || verdicts.length === 0
                    ? undefined
                    : meetsExpectation(expected, verdicts);
            const maxTimeMs = Math.max(0, ...own.map((result) => result.timeMs));
            outcomes.push({
                group: group.name,
                verdicts,
                summary: verdicts.length === 0 ? "-" : summarize(verdicts),
                score: Math.round(group.points * fraction * 100) / 100,
                maxScore: group.points,
                maxTimeMs,
                maxMemoryKb: Math.max(0, ...own.map((result) => result.memoryKb)),
                expected,
                meets,
            });

            if (meets === false)
                issues.push({
                    severity: "error",
                    code: "expectation.unmet",
                    message: `${solution.path} is expected to be ${expected} on "${group.name}" but got ${summarize(verdicts)}`,
                    ref: solution.path,
                });

            // time limit calibration uses real measurements of solutions behaving as intended
            if (expected === "AC" && meets && maxTimeMs > 0) {
                if (calibration.slowestAcceptedMs === undefined || maxTimeMs > calibration.slowestAcceptedMs) {
                    calibration.slowestAcceptedMs = maxTimeMs;
                    calibration.slowestAccepted = solution.path;
                }
            }
            if (expected !== undefined && expected.split("|").map((p) => p.trim()).includes("TLE") && meets) {
                const slow = Math.max(
                    0,
                    ...own.filter((result) => result.verdict === "TLE").map((result) => result.timeMs),
                );
                if (slow > 0 && (calibration.fastestRejectedMs === undefined || slow < calibration.fastestRejectedMs)) {
                    calibration.fastestRejectedMs = slow;
                    calibration.fastestRejected = solution.path;
                }
            }
        }

        // a group only scores when every group it depends on is fully solved
        for (const outcome of outcomes) {
            const group = groupByName.get(outcome.group)!;
            if (group.depends.some((dependency) => !fullyPassed.has(dependency))) outcome.score = 0;
        }

        const maxScore = plan.groups.reduce((sum, group) => sum + group.points, 0);
        let score = outcomes.reduce((sum, outcome) => sum + outcome.score, 0);
        if (plan.manifest.scoring.mode === "binary") {
            const all = outcomes.every((outcome) => outcome.verdicts.every((verdict) => verdict === "AC"));
            score = all ? 1 : 0;
        }
        solutions.push({
            path: solution.path,
            main: solution.main,
            groups: outcomes,
            score: Math.round(score * 100) / 100,
            maxScore: plan.manifest.scoring.mode === "binary" ? 1 : maxScore,
            maxTimeMs: Math.max(0, ...outcomes.map((outcome) => outcome.maxTimeMs)),
            ok: outcomes.every((outcome) => outcome.meets !== false),
        });

        // kill matrix: which tests catch this solution where it is supposed to be caught
        const failGroups = plan.groups.filter((group) => {
            const expected = solution.expect[group.name];
            return expected !== undefined && expected !== "AC";
        });
        if (failGroups.length > 0) {
            const killedBy = new Set<string>();
            for (const group of failGroups)
                for (const id of group.closure) {
                    const result = results[id];
                    if (result && result.verdict !== "AC") killedBy.add(id);
                }
            kills.push({ solution: solution.path, killedBy: [...killedBy] });
        }
    }

    const decisive = new Set<string>();
    for (const row of kills) {
        if (row.killedBy.length === 1) {
            decisive.add(row.killedBy[0]!);
            issues.push({
                severity: "warning",
                code: "tests.fragile",
                message: `${row.solution} is caught by a single test (${row.killedBy[0]}); one more test of that kind would make the set less fragile`,
                ref: row.solution,
            });
        }
    }

    if (calibration.slowestAcceptedMs !== undefined) {
        calibration.headroom = Math.round((timeLimitMs / calibration.slowestAcceptedMs) * 100) / 100;
        calibration.suggestedMs = niceCeil(calibration.slowestAcceptedMs * HEADROOM_TARGET);
        if (calibration.headroom < HEADROOM_TARGET)
            issues.push({
                severity: "warning",
                code: "limits.tight",
                message: `The time limit is only ${calibration.headroom}x the slowest accepted run (${calibration.slowestAcceptedMs} ms, ${calibration.slowestAccepted}); aim for at least ${HEADROOM_TARGET}x`,
            });
    }
    if (calibration.fastestRejectedMs !== undefined) {
        calibration.separation = Math.round((calibration.fastestRejectedMs / timeLimitMs) * 100) / 100;
        if (calibration.separation < SEPARATION_TARGET)
            issues.push({
                severity: "warning",
                code: "limits.thin-margin",
                message: `${calibration.fastestRejected} is meant to be too slow but runs in ${calibration.fastestRejectedMs} ms, only ${calibration.separation}x the limit; a faster machine or a small optimisation could get it accepted`,
            });
        if (
            calibration.suggestedMs !== undefined &&
            calibration.suggestedMs * SEPARATION_TARGET > calibration.fastestRejectedMs
        )
            calibration.suggestedMs = undefined;
    }

    return {
        status: issues.some((issue) => issue.severity === "error") ? "red" : "green",
        solutions,
        calibration,
        kills,
        decisiveTests: [...decisive],
        issues,
    };
};
