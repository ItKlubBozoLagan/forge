import {
    buildReport,
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
};

export type BuildTest = {
    id: string;
    group: string;
    index: number;
    /** Human readable origin: a manual file or `generator args`. */
    source: string;
    inputHash?: string;
    inputSize?: number;
    answerHash?: string;
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
export type BuildOptions = { remeasure?: boolean; adhoc?: AdhocSolution };

const GENERATOR_LIMIT_MS = 30_000;
const TOOL_MEMORY_MB = 1024;
/** Solution output kept per run for inspection; longer output is cut. */
const MAX_STORED_OUTPUT = 512 * 1024;

type Generated = { hash: string; size: number } | { error: string };
type Stored<T> = { key: string; value: T };

export class Engine {
    constructor(private ctx: EngineContext) {}

    private read(path: string): Promise<string> {
        const entry = this.ctx.tree[path];
        if (!entry) throw new Error(`${path} is not in the package`);
        return this.ctx.blobs.text(this.ctx.workspaceId, entry.hash);
    }

    private exec(request: RunRequest): Promise<RunResult> {
        return this.ctx.scheduler.submit(this.ctx.workspaceId, () => this.ctx.runner.run(request));
    }

    private async cached<T>(keys: string[]): Promise<Map<string, T>> {
        const found = new Map<string, T>();
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
        const source = withPrelude(generator.source, generator.language, constraints, group);
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
        const source = withPrelude(validator.source, validator.language, constraints, group);
        const sourceHash = sha256(source);
        const keyOfInput = (hash: string) => keyOf("val", sourceHash, validator.language, hash);
        const known = await this.cached<{ message: string | null }>(inputs.map((input) => keyOfInput(input.inputHash)));
        const missing = new Map<string, string>();
        for (const input of inputs) {
            const key = keyOfInput(input.inputHash);
            if (!known.has(key)) missing.set(key, input.inputHash);
        }
        if (missing.size > 0) {
            const runInputs = [];
            for (const [key, hash] of missing)
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
        if (missing.size > 0) {
            const runInputs = [];
            for (const [key, hash] of missing)
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
        checker: Program | undefined,
        task: { type: string; time_ms: number; memory_mb: number },
        tests: Array<{ id: string; inputHash: string; answerHash: string }>,
        remeasure = false,
    ): Promise<Map<string, RawRun & { key: string }>> {
        const sourceHash = sha256(solution.source);
        const checkerId = checker ? sha256(checker.source) : "tokens";
        const limit = measurementLimitMs(task.time_ms);
        const keyOfTest = (test: { inputHash: string; answerHash: string }) =>
            keyOf("run2", sourceHash, solution.language, test.inputHash, test.answerHash, checkerId, limit, task.memory_mb, task.type);
        const known = remeasure ? new Map<string, RawRun>() : await this.cached<RawRun>(tests.map(keyOfTest));
        const missing = new Map<string, { inputHash: string; answerHash: string }>();
        for (const test of tests) {
            const key = keyOfTest(test);
            if (!known.has(key)) missing.set(key, test);
        }
        if (missing.size > 0) {
            const runInputs = [];
            for (const [key, test] of missing)
                runInputs.push({
                    id: key,
                    stdin: await this.ctx.blobs.text(this.ctx.workspaceId, test.inputHash),
                    expected: await this.ctx.blobs.text(this.ctx.workspaceId, test.answerHash),
                });
            const result = await this.exec({
                program: solution,
                inputs: runInputs,
                checking: checker ?? "tokens",
                interactive: task.type === "interactive",
                timeLimitMs: limit,
                memoryLimitMb: task.memory_mb,
            });
            const fresh: Array<Stored<RawRun>> = [];
            if (result.compileError !== undefined) {
                for (const key of missing.keys())
                    fresh.push({
                        key,
                        value: { status: "compilation_error", timeMs: 0, memoryKb: 0, message: result.compileError.slice(0, 4000) },
                    });
            } else {
                const samples = [];
                for (const run of result.runs) {
                    const raw: RawRun = {
                        status: run.status,
                        data: run.data,
                        timeMs: run.timeMs,
                        memoryKb: run.memoryKb,
                        message: run.message,
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
        const output = new Map<string, RawRun & { key: string }>();
        for (const test of tests) {
            const key = keyOfTest(test);
            const raw = known.get(key);
            if (raw) output.set(test.id, { ...raw, key });
        }
        return output;
    }

    /** Output-only tasks: judges output files that are part of the package. */
    async checkOutputs(
        checker: Program | undefined,
        tests: Array<{ id: string; inputHash: string; answerHash: string; outputHash: string }>,
    ): Promise<Map<string, RawRun & { key: string }>> {
        const checkerId = checker ? sha256(checker.source) : "tokens";
        const keyOfTest = (test: { inputHash: string; answerHash: string; outputHash: string }) =>
            keyOf("chk", test.outputHash, test.inputHash, test.answerHash, checkerId);
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
            const result = await this.ctx.scheduler.submit(this.ctx.workspaceId, () =>
                this.ctx.runner.check({ checking: checker ?? "tokens", inputs }),
            );
            const fresh: Array<Stored<RawRun>> = [];
            if (result.compileError !== undefined) {
                for (const key of missing.keys())
                    known.set(key, { status: "judge_error", timeMs: 0, memoryKb: 0, message: `the checker does not compile:\n${result.compileError}`.slice(0, 4000) });
            } else {
                for (const run of result.runs) {
                    const raw: RawRun = { status: run.status, data: run.data, timeMs: 0, memoryKb: 0, message: run.message };
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
            checker: plan?.checker?.path,
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
            const { unresolved } = renderStatement(await this.read(path), plan.manifest, groupConstraints, []);
            if (unresolved.length > 0)
                error(
                    "statement.unresolved",
                    `The ${language} statement uses ${unresolved.map((name) => `{{${name}}}`).join(", ")}, which problem.yaml does not define`,
                    path,
                );
        }

        // 3. answers
        const withInput = tests.filter((test) => test.inputHash);
        const checker = plan.checker
            ? await this.program(plan.checker.path).then((program) => ({
                  language: program.language,
                  source: withPrelude(program.source, program.language, plan.manifest.constraints),
              }))
            : undefined;
        if (checker) {
            const compileError = await this.compiles(checker);
            if (compileError !== null) {
                error("checker.compile", `The checker does not compile:\n${compileError}`, plan.checker!.path);
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
            const main = await this.program(plan.main!.path);
            const answers = await this.answers(main, limits, withInput.map((test) => ({ id: test.id, inputHash: test.inputHash! })));
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

        return {
            report: buildReport(effectivePlan, matrix, issues),
            tests,
            matrix,
            runKeys,
            groups: plan.groups,
            limits,
            type: plan.manifest.type,
            scoring: plan.manifest.scoring.mode,
            checker: plan.checker?.path,
            validator: plan.validator?.path,
            runner,
        };
    }
}
