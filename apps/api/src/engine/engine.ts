import {
    buildReport,
    builtinCheckerSource,
    Constraints,
    Issue,
    judge,
    Language,
    languageOf,
    Matrix,
    MANIFEST_PATH,
    measurementLimitMs,
    parseManifest,
    Plan,
    planBuild,
    PlannedGroup,
    RawRun,
    renderStatement,
    Report,
    withPrelude,
} from "@forge/core";

import { BlobStore, keyOf, sha256, Tree } from "../blobs";
import { Sql } from "../db";
import { Scheduler } from "../runner/scheduler";
import { frameInput, usesTestlib, withTestlib } from "./testlib";
import { CheckRequest, Program, Runner, RunRequest, RunResult } from "../runner/types";

export type Progress = { phase: string; done: number; total: number };

export type EngineContext = {
    workspaceId: string;
    tree: Tree;
    blobs: BlobStore;
    sql: Sql;
    runner: Runner;
    scheduler: Scheduler;
    /** Hardware class the workspace's contests are judged on, when it has named one. */
    referenceClass?: string | null;
    onProgress?: (progress: Progress) => void;
    /** Aborted when the build is cancelled. */
    signal?: AbortSignal;
};

/**
 * The program that judges outputs, with what Forge needs around it: `explain` is a variant that
 * prints why an output is wrong, `framed` says the test goes to it length-prefixed (testlib
 * interactors).
 */
export type Judge = Program & { explain?: Program; framed?: boolean };

const clip = (line: string | undefined) => (line === undefined ? "<end of output>" : JSON.stringify(line.length > 80 ? `${line.slice(0, 80)}...` : line));

/** Why the judge's default comparison rejects an output: the first line that differs. */
export const firstDifference = (expected: string, actual: string): string | undefined => {
    const lines = (text: string) => {
        const rows = text.split("\n").map((row) => row.trim());
        while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
        return rows;
    };
    const want = lines(expected);
    const got = lines(actual);
    for (let index = 0; index < Math.max(want.length, got.length); index++)
        if (want[index] !== got[index]) return `line ${index + 1}: expected ${clip(want[index])}, found ${clip(got[index])}`;
    return undefined;
};

export class Cancelled extends Error {
    constructor() {
        super("The build was cancelled");
    }
}

export type BuildTest = {
    id: string;
    group: string;
    index: number;
    /** Human readable origin: a manual file or `generator args`. */
    source: string;
    inputHash?: string;
    inputSize?: number;
    answerHash?: string;
    /** Author's note about what the test is for. */
    desc?: string;
    /** Set when the answer is a hand-written file instead of the main solution's output. */
    answerFile?: string;
    error?: string;
    /** Validation result per group whose closure contains the test; null means valid. */
    validation: Record<string, string | null>;
};

export type BuildOutput = {
    report: Report;
    tests: BuildTest[];
    matrix: Matrix;
    /** Cache key of each run, `runKeys[solution][test]`; timing samples hang off these. */
    runKeys: Record<string, Record<string, string>>;
    groups: Array<Pick<PlannedGroup, "name" | "points" | "aggregate" | "sample" | "depends" | "constraints" | "tests" | "closure">>;
    limits?: { time_ms: number; memory_mb: number };
    type?: string;
    scoring?: string;
    checker?: string;
    validator?: string;
    runner: { pool: string; hardwareClass: string };
};

export type AdhocSolution = { name: string; language: Language; source: string };
export type BuildOptions = {
    remeasure?: boolean;
    /** Ignore every cached step: regenerate, revalidate, re-answer and re-run. */
    clean?: boolean;
    adhoc?: AdhocSolution;
};

const GENERATOR_LIMIT_MS = 30_000;
const TOOL_MEMORY_MB = 1024;
/** Solution output kept per run for inspection; longer output is cut. */
const MAX_STORED_OUTPUT = 512 * 1024;
/** Tests of one solution sent to the runner per job. */
const RUN_SLICE = 64;

type Generated = { hash: string; size: number } | { error: string };
type Stored<T> = { key: string; value: T };

/** How the build names its checker: a file, a built-in, or nothing for the judge's default. */
export const checkerLabel = (plan: Plan): string | undefined =>
    plan.checker?.path ?? (plan.builtinChecker ? `built-in ${plan.builtinChecker.kind}${plan.builtinChecker.kind === "float" ? ` (eps ${plan.builtinChecker.eps})` : ""}` : undefined);

export class Engine {
    constructor(private ctx: EngineContext) {}

    private read(path: string): Promise<string> {
        const entry = this.ctx.tree[path];
        if (!entry) throw new Error(`${path} is not in the package`);
        return this.ctx.blobs.text(this.ctx.workspaceId, entry.hash);
    }

    /** Set for a build that ignores every cached step (`clean`). */
    private fresh = false;

    private exec(request: RunRequest): Promise<RunResult> {
        return this.ctx.scheduler.submit(this.ctx.workspaceId, () => {
            // a cancelled build stops asking for work; jobs already on the runner finish on their own
            if (this.ctx.signal?.aborted) throw new Cancelled();
            return this.ctx.runner.run({ ...request, signal: this.ctx.signal });
        });
    }

    private async cached<T>(keys: string[]): Promise<Map<string, T>> {
        const found = new Map<string, T>();
        if (this.fresh) return found;
        const unique = [...new Set(keys)];
        for (let offset = 0; offset < unique.length; offset += 500) {
            const rows = await this.ctx.sql<{ key: string; result: T }[]>`
                select key, result from build_nodes
                where workspace_id = ${this.ctx.workspaceId} and key in ${this.ctx.sql(unique.slice(offset, offset + 500))}`;
            for (const row of rows) found.set(row.key, row.result);
        }
        return found;
    }

    private async store(kind: string, entries: Array<Stored<unknown>>) {
        if (entries.length === 0) return;
        const rows = entries.map((entry) => ({
            workspace_id: this.ctx.workspaceId,
            key: entry.key,
            kind,
            result: this.ctx.sql.json(entry.value as never),
        }));
        await this.ctx.sql`
            insert into build_nodes ${this.ctx.sql(rows as never[])}
            on conflict (workspace_id, key) do update set result = excluded.result, created_at = now()`;
    }

    /** Runs a generator for every item; identical arguments are generated once. */
    async generate(
        generator: Program,
        constraints: Constraints,
        group: string | undefined,
        items: Array<{ id: string; args: string }>,
    ): Promise<Map<string, Generated>> {
        const source = withPrelude(withTestlib(generator.source, generator.language, "generator"), generator.language, constraints, group);
        const sourceHash = sha256(source);
        const keyOfItem = (args: string) => keyOf("gen", sourceHash, generator.language, args);
        const known = await this.cached<Generated>(items.map((item) => keyOfItem(item.args)));
        const missing = new Map<string, string>();
        for (const item of items) {
            const key = keyOfItem(item.args);
            if (!known.has(key)) missing.set(key, item.args);
        }
        if (missing.size > 0) {
            const result = await this.exec({
                program: { source, language: generator.language },
                inputs: [...missing].map(([key, args]) => ({ id: key, stdin: `${args}\n` })),
                checking: "capture",
                timeLimitMs: GENERATOR_LIMIT_MS,
                memoryLimitMb: TOOL_MEMORY_MB,
            });
            const fresh: Array<Stored<Generated>> = [];
            if (result.compileError !== undefined) {
                for (const key of missing.keys())
                    fresh.push({ key, value: { error: `the generator does not compile:\n${result.compileError}` } });
            } else {
                for (const run of result.runs) {
                    if (run.status === "accepted") {
                        const entry = await this.ctx.blobs.put(this.ctx.workspaceId, Buffer.from(run.stdout ?? "", "utf8"));
                        fresh.push({ key: run.id, value: entry });
                    } else if (run.status === "judge_error") {
                        known.set(run.id, { error: `runner failure: ${run.message ?? "unknown"}` });
                    } else {
                        fresh.push({
                            key: run.id,
                            value: { error: `the generator failed (${run.status})${run.message ? `: ${run.message}` : ""}` },
                        });
                    }
                }
            }
            await this.store("gen", fresh);
            for (const entry of fresh) known.set(entry.key, entry.value);
        }
        const output = new Map<string, Generated>();
        for (const item of items) output.set(item.id, known.get(keyOfItem(item.args)) ?? { error: "no result" });
        return output;
    }

    /** Validates inputs against one group's constraints. Null means valid. */
    async validate(
        validator: Program,
        constraints: Constraints,
        group: string,
        inputs: Array<{ id: string; inputHash: string }>,
    ): Promise<Map<string, string | null>> {
        const source = withPrelude(withTestlib(validator.source, validator.language, "validator"), validator.language, constraints, group);
        const sourceHash = sha256(source);
        const keyOfInput = (hash: string) => keyOf("val", sourceHash, validator.language, hash);
        const known = await this.cached<{ message: string | null }>(inputs.map((input) => keyOfInput(input.inputHash)));
        const missing = new Map<string, string>();
        for (const input of inputs) {
            const key = keyOfInput(input.inputHash);
            if (!known.has(key)) missing.set(key, input.inputHash);
        }
        // a slice of the tests at a time, so a large set is never in memory at once
        const pending = [...missing];
        for (let offset = 0; offset < pending.length; offset += RUN_SLICE) {
            const runInputs = [];
            for (const [key, hash] of pending.slice(offset, offset + RUN_SLICE))
                runInputs.push({ id: key, stdin: await this.ctx.blobs.text(this.ctx.workspaceId, hash) });
            const result = await this.exec({
                program: { source, language: validator.language },
                inputs: runInputs,
                checking: "capture",
                timeLimitMs: GENERATOR_LIMIT_MS,
                memoryLimitMb: TOOL_MEMORY_MB,
            });
            const fresh: Array<Stored<{ message: string | null }>> = [];
            if (result.compileError !== undefined) {
                offset = pending.length;
                for (const key of missing.keys())
                    fresh.push({ key, value: { message: `the validator does not compile:\n${result.compileError}` } });
            } else {
                for (const run of result.runs) {
                    if (run.status === "accepted") fresh.push({ key: run.id, value: { message: null } });
                    else if (run.status === "runtime_error")
                        fresh.push({ key: run.id, value: { message: run.message?.trim() || "rejected by the validator" } });
                    else if (run.status === "judge_error")
                        known.set(run.id, { message: `runner failure: ${run.message ?? "unknown"}` });
                    else fresh.push({ key: run.id, value: { message: `the validator failed (${run.status})` } });
                }
            }
            await this.store("val", fresh);
            for (const entry of fresh) known.set(entry.key, entry.value);
        }
        const output = new Map<string, string | null>();
        for (const input of inputs)
            output.set(input.id, known.get(keyOfInput(input.inputHash))?.message ?? null);
        return output;
    }

    /** Produces the reference answer for every input with the main solution. */
    async answers(
        main: Program,
        limits: { time_ms: number; memory_mb: number },
        inputs: Array<{ id: string; inputHash: string }>,
    ): Promise<Map<string, { hash: string } | { error: string }>> {
        type Answer = { hash: string } | { error: string };
        const sourceHash = sha256(main.source);
        const limit = measurementLimitMs(limits.time_ms);
        const keyOfInput = (hash: string) => keyOf("ans", sourceHash, main.language, hash, limit, limits.memory_mb);
        const known = await this.cached<Answer>(inputs.map((input) => keyOfInput(input.inputHash)));
        const missing = new Map<string, string>();
        for (const input of inputs) {
            const key = keyOfInput(input.inputHash);
            if (!known.has(key)) missing.set(key, input.inputHash);
        }
        // a slice of the tests at a time, so a large set is never in memory at once
        const pending = [...missing];
        for (let offset = 0; offset < pending.length; offset += RUN_SLICE) {
            const runInputs = [];
            for (const [key, hash] of pending.slice(offset, offset + RUN_SLICE))
                runInputs.push({ id: key, stdin: await this.ctx.blobs.text(this.ctx.workspaceId, hash) });
            const result = await this.exec({
                program: main,
                inputs: runInputs,
                checking: "capture",
                timeLimitMs: limit,
                memoryLimitMb: limits.memory_mb,
            });
            const fresh: Array<Stored<Answer>> = [];
            if (result.compileError !== undefined) {
                offset = pending.length;
                for (const key of missing.keys())
                    fresh.push({ key, value: { error: `the main solution does not compile:\n${result.compileError}` } });
            } else {
                for (const run of result.runs) {
                    if (run.status === "accepted") {
                        const entry = await this.ctx.blobs.put(this.ctx.workspaceId, Buffer.from(run.stdout ?? "", "utf8"));
                        fresh.push({ key: run.id, value: { hash: entry.hash } });
                    } else if (run.status === "judge_error")
                        known.set(run.id, { error: `runner failure: ${run.message ?? "unknown"}` });
                    else
                        fresh.push({
                            key: run.id,
                            value: { error: `the main solution failed (${run.status})${run.message ? `: ${run.message}` : ""}` },
                        });
                }
            }
            await this.store("ans", fresh);
            for (const entry of fresh) known.set(entry.key, entry.value);
        }
        const output = new Map<string, Answer>();
        for (const input of inputs) output.set(input.id, known.get(keyOfInput(input.inputHash)) ?? { error: "no result" });
        return output;
    }

    /** Runs one solution on tests and returns the raw outcome per test id. */
    async runSolution(
        solution: Program,
        checker: Judge | undefined,
        task: { type: string; time_ms: number; memory_mb: number },
        tests: Array<{ id: string; inputHash: string; answerHash: string }>,
        remeasure = false,
    ): Promise<Map<string, RawRun & { key: string }>> {
        const sourceHash = sha256(solution.source);
        const checkerId = checker ? sha256(checker.source) : "tokens";
        const limit = measurementLimitMs(task.time_ms);
        const keyOfTest = (test: { inputHash: string; answerHash: string }) =>
            keyOf("run3", sourceHash, solution.language, test.inputHash, test.answerHash, checkerId, limit, task.memory_mb, task.type);
        const known = remeasure ? new Map<string, RawRun>() : await this.cached<RawRun>(tests.map(keyOfTest));
        const missing = new Map<string, { inputHash: string; answerHash: string }>();
        for (const test of tests) {
            const key = keyOfTest(test);
            if (!known.has(key)) missing.set(key, test);
        }
        // big test sets go to the runner a slice at a time, so only one slice is in memory
        const pending = [...missing];
        for (let offset = 0; offset < pending.length; offset += RUN_SLICE) {
            const slice = pending.slice(offset, offset + RUN_SLICE);
            const runInputs = [];
            for (const [key, test] of slice) {
                const input = await this.ctx.blobs.text(this.ctx.workspaceId, test.inputHash);
                runInputs.push({
                    id: key,
                    stdin: checker?.framed ? frameInput(input) : input,
                    expected: await this.ctx.blobs.text(this.ctx.workspaceId, test.answerHash),
                });
            }
            const result = await this.exec({
                program: solution,
                inputs: runInputs,
                checking: checker ? { source: checker.source, language: checker.language } : "tokens",
                interactive: task.type === "interactive",
                timeLimitMs: limit,
                memoryLimitMb: task.memory_mb,
            });
            const fresh: Array<Stored<RawRun>> = [];
            if (result.compileError !== undefined) {
                // nothing will compile on the next slice either
                for (const [key] of pending.slice(offset))
                    fresh.push({
                        key,
                        value: { status: "compilation_error", timeMs: 0, memoryKb: 0, message: result.compileError.slice(0, 4000) },
                    });
                offset = pending.length;
            } else {
                const samples = [];
                // why each rejected output is wrong, when the checker can say
                const byId = new Map(runInputs.map((input) => [input.id, input]));
                const comments =
                    task.type === "interactive"
                        ? new Map<string, string>()
                        : await this.comments(
                              checker,
                              result.runs
                                  .filter((run) => (run.status === "wrong_answer" || run.status === "custom") && run.stdout !== undefined)
                                  .map((run) => ({ id: run.id, input: byId.get(run.id)!.stdin, expected: byId.get(run.id)!.expected, output: run.stdout! })),
                          );
                for (const run of result.runs) {
                    const raw: RawRun = {
                        status: run.status,
                        data: run.data,
                        timeMs: run.timeMs,
                        memoryKb: run.memoryKb,
                        message: run.message ?? comments.get(run.id),
                    };
                    // what the solution printed, so a wrong answer can be looked at
                    if (run.stdout !== undefined) {
                        const text = run.stdout.length > MAX_STORED_OUTPUT ? `${run.stdout.slice(0, MAX_STORED_OUTPUT)}\n[output truncated]\n` : run.stdout;
                        raw.outputHash = (await this.ctx.blobs.put(this.ctx.workspaceId, Buffer.from(text, "utf8"))).hash;
                    }
                    if (run.status === "judge_error") known.set(run.id, raw);
                    else {
                        fresh.push({ key: run.id, value: raw });
                        samples.push({
                            workspace_id: this.ctx.workspaceId,
                            node_key: run.id,
                            runner_pool: this.ctx.runner.pool,
                            hardware_class: this.ctx.runner.hardwareClass,
                            time_ms: Math.round(run.timeMs),
                            memory_kb: Math.round(run.memoryKb),
                        });
                    }
                }
                if (samples.length > 0) await this.ctx.sql`insert into timing_samples ${this.ctx.sql(samples)}`;
            }
            await this.store("run", fresh);
            for (const entry of fresh) known.set(entry.key, entry.value);
        }
        // A single measurement is noisy. With several samples on this hardware the median decides,
        // so re-measuring makes a borderline verdict more stable instead of flipping it.
        const medians = await this.medianTimes(tests.map(keyOfTest));
        const output = new Map<string, RawRun & { key: string }>();
        for (const test of tests) {
            const key = keyOfTest(test);
            const raw = known.get(key);
            if (!raw) continue;
            const median = medians.get(key);
            const measured = raw.status === "accepted" || raw.status === "wrong_answer" || raw.status === "custom";
            output.set(test.id, { ...raw, timeMs: measured && median !== undefined ? median : raw.timeMs, key });
        }
        return output;
    }

    /**
     * The checker's comment on outputs it rejected. The evaluator only returns a verdict, so the
     * comment comes from a second run of the checker built to print it (testlib and built-in
     * checkers), or from comparing the texts when the judge's default comparison is used.
     */
    private async comments(
        checker: Judge | undefined,
        items: Array<{ id: string; input: string; expected: string; output: string }>,
    ): Promise<Map<string, string>> {
        const comments = new Map<string, string>();
        if (items.length === 0) return comments;
        if (!checker) {
            for (const item of items) {
                const difference = firstDifference(item.expected, item.output);
                if (difference) comments.set(item.id, difference);
            }
            return comments;
        }
        if (!checker.explain) return comments;
        const separator = `[${sha256(`${items[0]!.id}:${items.length}`)}]\n`;
        try {
            const result = await this.exec({
                program: checker.explain,
                inputs: items.map((item) => ({ id: item.id, stdin: `${separator}${item.input}\n${separator}${item.expected}\n${separator}${item.output}\n${separator}` })),
                checking: "capture",
                timeLimitMs: GENERATOR_LIMIT_MS,
                memoryLimitMb: TOOL_MEMORY_MB,
            });
            for (const run of result.runs) {
                const text = run.status === "accepted" ? (run.stdout ?? "").trim() : "";
                if (text) comments.set(run.id, text.length > 500 ? `${text.slice(0, 500)}...` : text);
            }
        } catch (error) {
            if (error instanceof Cancelled) throw error;
            // a comment is a convenience: the verdict stands without it
        }
        return comments;
    }

    private async medianTimes(keys: string[]): Promise<Map<string, number>> {
        const medians = new Map<string, number>();
        const unique = [...new Set(keys)];
        for (let offset = 0; offset < unique.length; offset += 500) {
            const rows = await this.ctx.sql<{ node_key: string; median: number; count: number }[]>`
                select node_key, percentile_cont(0.5) within group (order by time_ms)::float8 as median, count(*)::int as count
                from timing_samples
                where workspace_id = ${this.ctx.workspaceId} and hardware_class = ${this.ctx.runner.hardwareClass}
                    and node_key in ${this.ctx.sql(unique.slice(offset, offset + 500))}
                group by node_key`;
            for (const row of rows) if (row.count > 1) medians.set(row.node_key, Math.round(row.median));
        }
        return medians;
    }

    /** Output-only tasks: judges output files that are part of the package. */
    async checkOutputs(
        checker: Judge | undefined,
        tests: Array<{ id: string; inputHash: string; answerHash: string; outputHash: string }>,
    ): Promise<Map<string, RawRun & { key: string }>> {
        const checkerId = checker ? sha256(checker.source) : "tokens";
        const keyOfTest = (test: { inputHash: string; answerHash: string; outputHash: string }) =>
            keyOf("chk2", test.outputHash, test.inputHash, test.answerHash, checkerId);
        const known = await this.cached<RawRun>(tests.map(keyOfTest));
        const missing = new Map<string, (typeof tests)[number]>();
        for (const test of tests) {
            const key = keyOfTest(test);
            if (!known.has(key)) missing.set(key, test);
        }
        if (missing.size > 0) {
            const inputs: CheckRequest["inputs"] = [];
            for (const [key, test] of missing)
                inputs.push({
                    id: key,
                    stdin: await this.ctx.blobs.text(this.ctx.workspaceId, test.inputHash),
                    expected: await this.ctx.blobs.text(this.ctx.workspaceId, test.answerHash),
                    output: await this.ctx.blobs.text(this.ctx.workspaceId, test.outputHash),
                });
            const result = await this.ctx.scheduler.submit(this.ctx.workspaceId, () => {
                if (this.ctx.signal?.aborted) throw new Cancelled();
                return this.ctx.runner.check({ checking: checker ? { source: checker.source, language: checker.language } : "tokens", inputs });
            });
            const fresh: Array<Stored<RawRun>> = [];
            if (result.compileError !== undefined) {
                for (const key of missing.keys())
                    known.set(key, { status: "judge_error", timeMs: 0, memoryKb: 0, message: `the checker does not compile:\n${result.compileError}`.slice(0, 4000) });
            } else {
                const comments = await this.comments(
                    checker,
                    result.runs
                        .filter((run) => run.status === "wrong_answer" || run.status === "custom")
                        .map((run) => {
                            const input = inputs.find((entry) => entry.id === run.id)!;
                            return { id: run.id, input: input.stdin, expected: input.expected, output: input.output };
                        }),
                );
                for (const run of result.runs) {
                    const raw: RawRun = { status: run.status, data: run.data, timeMs: 0, memoryKb: 0, message: run.message ?? comments.get(run.id) };
                    if (run.status === "judge_error") known.set(run.id, raw);
                    else fresh.push({ key: run.id, value: raw });
                }
            }
            await this.store("chk", fresh);
            for (const entry of fresh) known.set(entry.key, entry.value);
        }
        const output = new Map<string, RawRun & { key: string }>();
        for (const test of tests) {
            const key = keyOfTest(test);
            const raw = known.get(key);
            if (raw) output.set(test.id, { ...raw, key });
        }
        return output;
    }

    /** The program that judges outputs: the package's checker, a built-in one, or none (the judge's default). */
    async checker(plan: Plan): Promise<Judge | undefined> {
        if (plan.builtinChecker) {
            const { kind, eps } = plan.builtinChecker;
            return {
                language: "python",
                source: builtinCheckerSource(kind, eps),
                explain: { language: "python", source: builtinCheckerSource(kind, eps, true) },
            };
        }
        if (!plan.checker) return undefined;
        const program = await this.program(plan.checker.path);
        const testlib = usesTestlib(program.source, program.language);
        if (plan.manifest.type === "interactive")
            return {
                language: program.language,
                source: withPrelude(withTestlib(program.source, program.language, "interactor"), program.language, plan.manifest.constraints),
                framed: testlib,
            };
        return {
            language: program.language,
            explain: testlib
                ? { language: program.language, source: withPrelude(withTestlib(program.source, program.language, "checker", true), program.language, plan.manifest.constraints) }
                : undefined,
            // testlib first, so its #line and the prelude's keep diagnostics on the author's lines
            source: withPrelude(withTestlib(program.source, program.language, "checker"), program.language, plan.manifest.constraints),
        };
    }

    /** Makes sure the empty blob exists; interactive tasks use it as every test's answer. */
    async putEmpty() {
        return this.ctx.blobs.put(this.ctx.workspaceId, Buffer.alloc(0));
    }

    /** Fails with a readable message when a tool program does not compile. */
    async compiles(program: Program): Promise<string | null> {
        const key = keyOf("compile", sha256(program.source), program.language);
        const known = (await this.cached<{ error: string | null }>([key])).get(key);
        if (known) return known.error;
        const result = await this.exec({
            program,
            inputs: [{ id: "compile", stdin: "" }],
            checking: "capture",
            timeLimitMs: 1000,
            memoryLimitMb: 256,
        });
        const error = result.compileError ?? null;
        await this.store("compile", [{ key, value: { error } }]);
        return error;
    }

    async program(path: string): Promise<Program> {
        const language = languageOf(path);
        if (!language) throw new Error(`${path} has an unsupported extension`);
        return { source: await this.read(path), language };
    }

    /** Parses the manifest and plans the build; a missing plan means the package is broken. */
    async plan(): Promise<{ plan?: Plan; issues: Issue[] }> {
        if (!this.ctx.tree[MANIFEST_PATH])
            return { issues: [{ severity: "error", code: "manifest.missing", message: "The package has no problem.yaml", ref: MANIFEST_PATH }] };
        const parsed = parseManifest(await this.read(MANIFEST_PATH));
        if (!parsed.manifest) return { issues: parsed.issues };
        const { plan, issues } = planBuild(parsed.manifest, Object.keys(this.ctx.tree));
        return { plan, issues };
    }

    /** The whole pipeline: generate, validate, answer, run every solution, report. */
    async build(options: BuildOptions = {}): Promise<BuildOutput> {
        this.fresh = options.clean === true;
        const runner = { pool: this.ctx.runner.pool, hardwareClass: this.ctx.runner.hardwareClass };
        const { plan, issues } = await this.plan();
        const progress = (phase: string, done: number, total: number) => this.ctx.onProgress?.({ phase, done, total });
        const broken = (extra: Issue[] = []): BuildOutput => ({
            report: {
                status: "red",
                solutions: [],
                calibration: { timeLimitMs: plan?.manifest.limits.time_ms ?? 0 },
                kills: [],
                decisiveTests: [],
                issues: [...issues, ...extra],
            },
            tests: [],
            matrix: {},
            runKeys: {},
            groups: plan?.groups ?? [],
            limits: plan?.manifest.limits,
            type: plan?.manifest.type,
            scoring: plan?.manifest.scoring.mode,
            checker: plan ? checkerLabel(plan) : undefined,
            validator: plan?.validator?.path,
            runner,
        });
        if (!plan || issues.some((issue) => issue.severity === "error")) return broken();
        if (!plan.runnable)
            return broken([
                { severity: "error", code: "build.not-runnable", message: `Task type "${plan.manifest.type}" cannot be built with the current runner` },
            ]);
        const error = (code: string, message: string, ref?: string) => issues.push({ severity: "error", code, message, ref });
        if (this.ctx.referenceClass && this.ctx.referenceClass !== runner.hardwareClass)
            issues.push({
                severity: "warning",
                code: "limits.not-reference",
                message: `Times were measured on "${runner.hardwareClass}" hardware, not on the workspace's reference class "${this.ctx.referenceClass}"; treat the time limit calibration as indicative only`,
            });
        const limits = plan.manifest.limits;
        const groupByName = new Map(plan.groups.map((group) => [group.name, group]));

        const tests: BuildTest[] = plan.tests.map((test) => ({
            id: test.id,
            group: test.group,
            index: test.index,
            source: test.source.kind === "manual" ? test.source.path : `${test.source.generator} ${test.source.args}`.trim(),
            desc: test.desc,
            answerFile: test.answer,
            validation: {},
        }));
        const testById = new Map(tests.map((test) => [test.id, test]));

        // 1. inputs
        progress("generate", 0, tests.length);
        const batches = new Map<string, { group: PlannedGroup; path: string; items: Array<{ id: string; args: string }> }>();
        for (const planned of plan.tests) {
            const test = testById.get(planned.id)!;
            if (planned.source.kind === "manual") {
                const entry = this.ctx.tree[planned.source.path]!;
                test.inputHash = entry.hash;
                test.inputSize = entry.size;
                continue;
            }
            const batchKey = `${planned.group}\n${planned.source.path}`;
            const batch = batches.get(batchKey) ?? { group: groupByName.get(planned.group)!, path: planned.source.path, items: [] };
            batch.items.push({ id: planned.id, args: planned.source.args });
            batches.set(batchKey, batch);
        }
        await Promise.all(
            [...batches.values()].map(async (batch) => {
                const generated = await this.generate(await this.program(batch.path), batch.group.constraints, batch.group.name, batch.items);
                for (const [id, result] of generated) {
                    const test = testById.get(id)!;
                    if ("error" in result) {
                        test.error = result.error;
                        error("test.generate", `Test ${id} (${test.source}): ${result.error}`, id);
                    } else {
                        test.inputHash = result.hash;
                        test.inputSize = result.size;
                    }
                }
            }),
        );
        for (const group of plan.groups) {
            const seen = new Map<string, string>();
            for (const id of group.tests) {
                const hash = testById.get(id)?.inputHash;
                if (!hash) continue;
                const other = seen.get(hash);
                if (other) issues.push({ severity: "warning", code: "test.duplicate", message: `Tests ${other} and ${id} are identical`, ref: id });
                else seen.set(hash, id);
            }
        }

        // 2. validation, per group, including the tests inherited from dependencies
        if (plan.validator) {
            const validator = await this.program(plan.validator.path);
            progress("validate", 0, plan.groups.length);
            let done = 0;
            await Promise.all(
                plan.groups.map(async (group) => {
                    const inputs = group.closure
                        .map((id) => testById.get(id)!)
                        .filter((test) => test.inputHash)
                        .map((test) => ({ id: test.id, inputHash: test.inputHash! }));
                    const results = await this.validate(validator, group.constraints, group.name, inputs);
                    for (const [id, message] of results) {
                        testById.get(id)!.validation[group.name] = message;
                        if (message !== null)
                            error(
                                "test.invalid",
                                `Test ${id} breaks the constraints of group "${group.name}": ${message.split("\n")[0]}`,
                                id,
                            );
                    }
                    progress("validate", ++done, plan.groups.length);
                }),
            );
        }

        // statements must not reach contestants with a placeholder nobody filled in
        const groupConstraints = Object.fromEntries(plan.groups.map((group) => [group.name, group.constraints]));
        for (const [language, path] of Object.entries(plan.statements)) {
            // as many (empty) samples as the package has, so {{sample.9}} of three is caught
            const sampleGroups = new Set(plan.groups.filter((group) => group.sample).map((group) => group.name));
            const placeholders = plan.tests.filter((test) => sampleGroups.has(test.group)).map(() => ({ input: "", output: "" }));
            const { unresolved } = renderStatement(await this.read(path), plan.manifest, groupConstraints, placeholders, { strictSamples: true });
            if (unresolved.length > 0)
                error(
                    "statement.unresolved",
                    `The ${language} statement uses ${unresolved.map((name) => `{{${name}}}`).join(", ")}, which problem.yaml does not define`,
                    path,
                );
        }

        // 3. answers
        const withInput = tests.filter((test) => test.inputHash);
        const checker = await this.checker(plan);
        if (checker) {
            const compileError = await this.compiles(checker);
            if (compileError !== null) {
                error("checker.compile", `The checker does not compile:\n${compileError}`, plan.checker?.path);
                return { ...broken(), tests, groups: plan.groups };
            }
        }
        progress("answers", 0, withInput.length);
        if (plan.manifest.type === "interactive") {
            const empty = await this.ctx.blobs.put(this.ctx.workspaceId, Buffer.alloc(0));
            for (const test of withInput) test.answerHash = empty.hash;
        } else if (plan.main!.outputs) {
            // output-only task whose reference answers are files in the package
            for (const test of withInput) test.answerHash = this.ctx.tree[plan.main!.outputs[test.id] ?? ""]?.hash;
        } else {
            // a hand-written answer file wins; the main solution answers the rest
            const written = new Map(plan.tests.filter((test) => test.answer).map((test) => [test.id, test.answer!]));
            for (const test of withInput) if (written.has(test.id)) test.answerHash = this.ctx.tree[written.get(test.id)!]?.hash;
            const main = await this.program(plan.main!.path);
            const answers = await this.answers(
                main,
                limits,
                withInput.filter((test) => !written.has(test.id)).map((test) => ({ id: test.id, inputHash: test.inputHash! })),
            );
            for (const [id, answer] of answers) {
                const test = testById.get(id)!;
                if ("error" in answer) {
                    test.error = answer.error;
                    error("test.answer", `Test ${id}: ${answer.error.split("\n")[0]}`, id);
                } else test.answerHash = answer.hash;
            }
        }

        // 4. every solution on every test
        const runnable = tests
            .filter((test) => test.inputHash && test.answerHash)
            .map((test) => ({ id: test.id, inputHash: test.inputHash!, answerHash: test.answerHash! }));
        type Runnable = { path: string; program?: Program; outputs?: Record<string, string> };
        const solutions: Runnable[] = options.adhoc
            ? [{ path: options.adhoc.name, program: { source: options.adhoc.source, language: options.adhoc.language } }]
            : await Promise.all(
                  plan.solutions.map(async (solution) =>
                      solution.outputs
                          ? { path: solution.path, outputs: solution.outputs }
                          : { path: solution.path, program: await this.program(solution.path) },
                  ),
              );
        const effectivePlan: Plan = options.adhoc
            ? { ...plan, solutions: [{ path: options.adhoc.name, language: options.adhoc.language, main: false, expect: {} }] }
            : plan;
        const matrix: Matrix = {};
        const runKeys: BuildOutput["runKeys"] = {};
        /** Tests on which the checker gave a partial score kontestis would not recognise. */
        const barePartial = new Set<string>();
        let finished = 0;
        progress("solutions", 0, solutions.length);
        await Promise.all(
            solutions.map(async (solution) => {
                const raw = new Map<string, RawRun & { key?: string }>();
                if (solution.program) {
                    const runs = await this.runSolution(
                        solution.program,
                        checker,
                        { type: plan.manifest.type, time_ms: limits.time_ms, memory_mb: limits.memory_mb },
                        runnable,
                        options.remeasure,
                    );
                    for (const [id, run] of runs) raw.set(id, run);
                } else {
                    const submitted = [];
                    for (const test of runnable) {
                        const entry = this.ctx.tree[solution.outputs?.[test.id] ?? ""];
                        if (entry) submitted.push({ ...test, outputHash: entry.hash });
                        else raw.set(test.id, { status: "wrong_answer", timeMs: 0, memoryKb: 0, message: "no output file for this test" });
                    }
                    const files = new Map(submitted.map((test) => [test.id, test.outputHash]));
                    for (const [id, run] of await this.checkOutputs(checker, submitted)) raw.set(id, { ...run, outputHash: files.get(id) });
                }
                const row: Matrix[string] = {};
                const keys: Record<string, string> = {};
                for (const test of runnable) {
                    const run = raw.get(test.id);
                    if (!run) continue;
                    if (run.status === "custom" && !(run.data ?? "").trim().startsWith("partial:")) barePartial.add(test.id);
                    row[test.id] = judge(run, limits.time_ms);
                    if (run.key) keys[test.id] = run.key;
                }
                matrix[solution.path] = row;
                runKeys[solution.path] = keys;
                const compileError = [...raw.values()].find((run) => run.status === "compilation_error");
                if (compileError)
                    error("solution.compile", `${solution.path} does not compile:\n${(compileError.message ?? "").trim()}`, solution.path);
                const judgeError = [...raw.values()].find((run) => run.status === "judge_error");
                if (judgeError)
                    error("run.judge-error", `${solution.path}: the judge failed on some tests (${judgeError.message ?? "unknown"})`, solution.path);
                progress("solutions", ++finished, solutions.length);
            }),
        );

        if (plan.manifest.judge === "kontestis" && barePartial.size > 0)
            issues.push({
                severity: "warning",
                code: "kontestis.incompatible",
                message: `kontestis: the checker printed a partial score without "partial:" (for example on ${[...barePartial][0]}); kontestis only awards credit for custom:partial:<fraction> and scores anything else 0`,
                ref: plan.checker?.path,
            });

        return {
            report: buildReport(effectivePlan, matrix, issues),
            tests,
            matrix,
            runKeys,
            groups: plan.groups,
            limits,
            type: plan.manifest.type,
            scoring: plan.manifest.scoring.mode,
            checker: checkerLabel(plan),
            validator: plan.validator?.path,
            runner,
        };
    }
}
