import type { Client } from "./client";
import { bold, dim, green, info, red, sleep, yellow } from "./util";

export type GroupOutcome = {
    group: string;
    summary: string;
    score: number;
    maxScore: number;
    maxTimeMs: number;
    expected?: string;
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
export type Issue = { severity: "error" | "warning"; code: string; message: string; ref?: string };
export type Calibration = {
    timeLimitMs: number;
    slowestAcceptedMs?: number;
    slowestAccepted?: string;
    fastestRejectedMs?: number;
    fastestRejected?: string;
    headroom?: number;
    separation?: number;
    suggestedMs?: number;
};
export type BuildOutput = {
    report: { status: "green" | "red"; solutions: SolutionReport[]; calibration: Calibration; issues: Issue[] };
    limits?: { time_ms: number; memory_mb: number };
    type?: string;
    checker?: string | null;
    validator?: string | null;
};
export type StressOutput = {
    total: number;
    passed: number;
    failures: Array<{ args: string; verdict: string; message?: string; inputHash: string; inputSize: number; timeMs: number }>;
    invalid: Array<{ args: string; message: string }>;
    errors: string[];
};
export type BuildSummary = {
    id: string;
    kind: string;
    status: "queued" | "running" | "done" | "failed";
    result: "green" | "red" | null;
    progress?: { phase: string; done: number; total: number } | null;
    error?: string | null;
};
export type BuildDetail<T = unknown> = BuildSummary & { output: T | null };

/** One line naming what judges the package: task type, checker and validator. */
export const describeTools = (output: Pick<BuildOutput, "type" | "checker" | "validator">): string =>
    `Judging: ${output.type ?? "batch"} task, checker ${output.checker ?? "default comparison"}, validator ${output.validator ?? "none"}`;

/** Polls until the build is done or failed, with a single-line progress indicator on a TTY. Ctrl-C cancels the build. */
export const waitForBuild = async <T>(client: Client, buildId: string): Promise<BuildDetail<T>> => {
    const tty = Boolean(process.stdout.isTTY);
    let cancelling = false;
    const onSigint = () => {
        if (cancelling) return;
        cancelling = true;
        void client
            .post(`/builds/${buildId}/cancel`)
            .catch(() => undefined)
            .finally(() => {
                info("cancelled");
                process.exit(130);
            });
    };
    process.on("SIGINT", onSigint);
    let lastLength = 0;
    const clear = () => {
        if (tty && lastLength > 0) process.stdout.write(`\r${" ".repeat(lastLength)}\r`);
        lastLength = 0;
    };
    try {
        for (;;) {
            const build = await client.get<BuildDetail<T>>(`/builds/${buildId}`);
            if (build.status === "done" || build.status === "failed") return build;
            if (tty) {
                const p = build.progress;
                const text = `${build.status}${p?.phase ? ` ${p.phase}` : ""}${p && p.total ? ` ${p.done}/${p.total}` : ""} ...`;
                process.stdout.write(`\r${text.padEnd(lastLength)}`);
                lastLength = Math.max(lastLength, text.length);
            }
            await sleep(1000);
        }
    } finally {
        process.off("SIGINT", onSigint);
        clear();
    }
};

const colorSummary = (summary: string, padded: string) => (summary === "AC" ? green(padded) : red(padded));

export const printSolutionMatrix = (solutions: SolutionReport[], withExpectation = true) => {
    if (solutions.length === 0) return;
    const groups = [...new Set(solutions.flatMap((s) => s.groups.map((g) => g.group)))];
    const rows: string[][] = [["solution", ...groups, "score", ...(withExpectation ? ["expected"] : [])]];
    for (const s of solutions) {
        const cells = groups.map((name) => {
            const g = s.groups.find((candidate) => candidate.group === name);
            return g ? `${g.summary} ${g.maxTimeMs}ms` : "-";
        });
        const hasExpect = s.groups.some((g) => g.meets !== undefined);
        const met = s.groups.every((g) => g.meets !== false);
        rows.push([
            `${s.path}${s.main ? " *" : ""}`,
            ...cells,
            `${s.score}/${s.maxScore}`,
            ...(withExpectation ? [!hasExpect ? "-" : met ? "met" : "NOT MET"] : []),
        ]);
    }
    const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? "").length)));
    info(bold(rows[0]!.map((cell, col) => cell.padEnd(widths[col]!)).join("  ").trimEnd()));
    solutions.forEach((s, i) => {
        const row = rows[i + 1]!;
        const out = row.map((cell, col) => {
            const padded = cell.padEnd(widths[col]!);
            const g = col >= 1 && col <= groups.length ? s.groups.find((candidate) => candidate.group === groups[col - 1]) : undefined;
            if (g) return colorSummary(g.summary, padded);
            if (cell === "NOT MET") return red(padded);
            if (cell === "met") return green(padded);
            return padded;
        });
        info(out.join("  ").trimEnd());
    });
    if (solutions.some((s) => s.main)) info(dim("* main solution"));
};

export const printCalibration = (c: Calibration) => {
    const parts = [`time limit ${c.timeLimitMs}ms`];
    if (c.slowestAcceptedMs !== undefined) parts.push(`slowest accepted ${c.slowestAcceptedMs}ms${c.slowestAccepted ? ` (${c.slowestAccepted})` : ""}`);
    if (c.fastestRejectedMs !== undefined) parts.push(`fastest rejected ${c.fastestRejectedMs}ms${c.fastestRejected ? ` (${c.fastestRejected})` : ""}`);
    if (c.headroom !== undefined) parts.push(`headroom ${c.headroom.toFixed(2)}x`);
    if (c.separation !== undefined) parts.push(`separation ${c.separation.toFixed(2)}x`);
    if (c.suggestedMs !== undefined) parts.push(`suggested ${c.suggestedMs}ms`);
    info(`Calibration: ${parts.join(", ")}`);
};

export const printIssues = (issues: Issue[]) => {
    const sorted = [...issues.filter((i) => i.severity === "error"), ...issues.filter((i) => i.severity === "warning")];
    if (sorted.length === 0) return;
    info("Issues:");
    for (const issue of sorted) {
        const tag = issue.severity === "error" ? red("error  ") : yellow("warning");
        info(`  ${tag} ${issue.message}${issue.ref ? dim(` [${issue.ref}]`) : ""} ${dim(`(${issue.code})`)}`);
    }
};

/** Prints a finished build and returns the process exit code (0 green, 1 red, 2 failed). */
export const printBuild = (build: BuildDetail<BuildOutput>): number => {
    if (build.status === "failed" || !build.output) {
        console.error(red(`build ${build.id} failed: ${build.error ?? "unknown error"}`));
        return 2;
    }
    const { report } = build.output;
    info(`Result: ${report.status === "green" ? green("GREEN") : red("RED")}`);
    info(describeTools(build.output));
    printIssues(report.issues);
    info();
    printSolutionMatrix(report.solutions);
    info();
    printCalibration(report.calibration);
    return report.status === "green" ? 0 : 1;
};
