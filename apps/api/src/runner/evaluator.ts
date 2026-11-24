import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { createClient } from "redis";

import { Config } from "../config";
import { Capabilities, CheckRequest, CommunicationRequest, RunInput, Runner, RunOutcome, RunRequest, RunResult } from "./types";

type EvaluatorVerdict = { type: string; data?: string | null };
type EvaluatorResult = {
    evaluation_id: string;
    verdict: EvaluatorVerdict;
    compiler_output?: string | null;
    testcases: Array<{
        id: string;
        verdict: EvaluatorVerdict;
        time: number;
        memory: number;
        error?: string | null;
        output?: string | null;
    }>;
};

/** Evaluator messages carry test data inline, so large batches are split. */
const MAX_CHUNK_BYTES = 6 * 1024 * 1024;
const MAX_CHUNK_TESTS = 64;
/**
 * Worst-case run time allowed in one message (tests x time limit). A job must answer before its
 * timeout, so a slow solution on many tests is split instead of being declared lost.
 */
const MAX_CHUNK_RUN_MS = 4 * 60_000;
const CHECK_CONCURRENCY = 8;

const PROBE_TIMEOUT_MS = 30_000;

const testcaseOf = (input: RunInput) => ({
    id: input.id,
    input: input.stdinBase64 ?? input.stdin,
    output: input.expected ?? "",
    ...(input.stdinBase64 !== undefined ? { input_encoding: "base64" } : {}),
});

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

/** Runs programs on kontestis evaluator instances through their existing Redis protocol. */
export class EvaluatorRunner implements Runner {
    readonly pool: string;
    readonly hardwareClass: string;
    readonly capabilities: Capabilities;
    private client;
    private listener;
    private resultQueue = `forge_results:${randomUUID()}`;
    private pending = new Map<string, (result: EvaluatorResult | undefined) => void>();
    private closed = false;
    private lastResultAt = 0;
    private inFlight = 0;
    private probing?: Promise<boolean>;
    private idFormat?: Promise<"number" | "string">;

    constructor(private config: Config) {
        this.pool = config.runner.pool;
        this.hardwareClass = config.runner.hardwareClass;
        this.capabilities = {
            binaryInput: config.runner.features.includes("binary-input"),
            communication: config.runner.features.includes("communication"),
        };
        this.client = createClient({
            url: config.redisUrl,
            ...(config.redisCaFile ? { socket: { tls: true as const, ca: readFileSync(config.redisCaFile, "utf8") } } : {}),
        });
        this.listener = this.client.duplicate();
    }

    async init() {
        this.client.on("error", () => {});
        this.listener.on("error", () => {});
        await this.client.connect();
        await this.listener.connect();
        void this.listen();
    }

    private async listen() {
        while (!this.closed) {
            try {
                const item = await this.listener.blPop(this.resultQueue, 2);
                if (!item) continue;
                const result = JSON.parse(item.element) as EvaluatorResult;
                this.lastResultAt = Date.now();
                const resolve = this.pending.get(String(result.evaluation_id));
                if (resolve) {
                    this.pending.delete(String(result.evaluation_id));
                    resolve(result);
                }
            } catch {
                if (this.closed) return;
                await new Promise((done) => setTimeout(done, 1000));
            }
        }
    }

    private async evaluate(request: RunRequest, inputs: RunInput[]): Promise<RunResult> {
        const id = await this.evaluationId();
        const checker =
            typeof request.checking === "object"
                ? { script: request.checking.source, language: request.checking.language }
                : null;
        const body = {
            id,
            code: request.program.source,
            language: request.program.language,
            testcases: inputs.map(testcaseOf),
            time_limit: request.timeLimitMs,
            memory_limit: request.memoryLimitMb * 1024,
            evaluate_all: true,
            checker,
        };
        const message = {
            BeginEvaluation: {
                output_queue: this.resultQueue,
                evaluation: request.interactive ? { Interactive: body } : { Batch: body },
            },
        };
        // waiting in the queue is covered by the configured timeout; running by the worst case of
        // this chunk (the sandbox allows about twice the CPU limit in wall-clock time)
        const timeout = this.config.runner.jobTimeoutMs + 2 * inputs.length * request.timeLimitMs + 60_000;
        return this.interpret(await this.send(id, message, timeout), inputs, request.checking === "capture");
    }

    /**
     * Whether an evaluator is consuming the queue. A busy evaluator answers nothing until its
     * current job ends, so recent results and work in flight count as alive; a probe is only
     * sent when the queue is otherwise idle.
     */
    async alive(): Promise<boolean> {
        if (Date.now() - this.lastResultAt < 60_000) return true;
        if (this.inFlight > 0) return true;
        return (this.probing ??= this.probe().finally(() => {
            this.probing = undefined;
        }));
    }

    private async probe(): Promise<boolean> {
        const ask = async (id: number | string) =>
            (await this.send(
                id,
                {
                    BeginEvaluation: {
                        output_queue: this.resultQueue,
                        evaluation: { OutputOnly: { id, output: "", testcase: { id: "probe", input: "", output: "" }, checker: null } },
                    },
                },
                5000,
            )) !== undefined;
        const configured = this.config.runner.idFormat;
        const number = randomInt(1, 2 ** 48 - 1);
        const answers = await Promise.all(
            configured === "auto" ? [ask(number), ask(String(number + 1))] : [ask(configured === "string" ? String(number) : number)],
        );
        return answers.some(Boolean);
    }

    /**
     * Evaluator `master` declares evaluation ids as unsigned integers (what kontestis sends)
     * and drops any message it cannot parse without answering; its string-id branch does the
     * same to numbers. Unless configured, the first job finds out which form gets an answer.
     */
    private async evaluationId(): Promise<number | string> {
        const configured = this.config.runner.idFormat;
        const format = configured === "auto" ? await (this.idFormat ??= this.detectIdFormat()) : configured;
        const id = randomInt(1, 2 ** 48 - 1);
        return format === "string" ? String(id) : id;
    }

    private async detectIdFormat(): Promise<"number" | "string"> {
        const probe = (id: number | string) =>
            this.send(
                id,
                {
                    BeginEvaluation: {
                        output_queue: this.resultQueue,
                        evaluation: { OutputOnly: { id, output: "", testcase: { id: "probe", input: "", output: "" }, checker: null } },
                    },
                },
                PROBE_TIMEOUT_MS,
            );
        // the form the evaluator cannot parse never answers, so take whichever answers first
        const answered = (format: "number" | "string", id: number | string) =>
            probe(id).then((result) => (result ? format : new Promise<never>(() => {})));
        const format = await Promise.race([
            answered("number", randomInt(1, 2 ** 48 - 1)),
            answered("string", String(randomInt(1, 2 ** 48 - 1))),
            new Promise<undefined>((resolve) => {
                setTimeout(() => resolve(undefined), PROBE_TIMEOUT_MS).unref();
            }),
        ]);
        if (format) return format;
        // nothing answered (no evaluator, or a long queue): assume the released form and ask again next time
        this.idFormat = undefined;
        return "number";
    }

    private async send(evaluation: number | string, message: unknown, timeoutMs = this.config.runner.jobTimeoutMs): Promise<EvaluatorResult | undefined> {
        const id = String(evaluation);
        const answer = new Promise<EvaluatorResult | undefined>((resolve) => {
            this.pending.set(id, resolve);
            setTimeout(() => {
                if (this.pending.delete(id)) resolve(undefined);
            }, timeoutMs).unref();
        });
        await this.client.rPush(this.config.runner.queueKey, JSON.stringify(message));
        return answer;
    }

    private interpret(result: EvaluatorResult | undefined, inputs: Array<{ id: string }>, capture: boolean): RunResult {
        if (!result)
            return {
                runs: inputs.map((input) => ({
                    id: input.id,
                    status: "judge_error" as const,
                    timeMs: 0,
                    memoryKb: 0,
                    message: "the runner did not answer in time",
                })),
            };
        if (result.verdict.type === "system_error" && result.testcases.length === 0)
            return {
                runs: inputs.map((input) => ({
                    id: input.id,
                    status: "judge_error" as const,
                    timeMs: 0,
                    memoryKb: 0,
                    message: `the evaluator could not run this: ${result.compiler_output ?? "system error"}`,
                })),
            };
        if (result.verdict.type === "compilation_error")
            return {
                compileError: stripAnsi(result.compiler_output || result.verdict.data || "compilation failed"),
                runs: [],
            };

        const byId = new Map(result.testcases.map((testcase) => [testcase.id, testcase]));
        const runs = inputs.map((input): RunOutcome => {
            const testcase = byId.get(input.id);
            if (!testcase)
                return { id: input.id, status: "judge_error", timeMs: 0, memoryKb: 0, message: "no result" };
            const base = { id: input.id, timeMs: testcase.time, memoryKb: testcase.memory };
            const stdout = testcase.output ?? undefined;
            switch (testcase.verdict.type) {
                case "accepted":
                    return { ...base, status: "accepted", stdout };
                case "wrong_answer":
                    // without a checker the evaluator compares against an empty expected
                    // output; when only capturing, any clean exit is a success
                    return { ...base, status: capture ? "accepted" : "wrong_answer", stdout };
                case "custom":
                    return { ...base, status: "custom", data: testcase.verdict.data ?? "", stdout };
                case "time_limit_exceeded":
                    return { ...base, status: "time_limit_exceeded" };
                case "memory_limit_exceeded":
                    return { ...base, status: "memory_limit_exceeded" };
                case "runtime_error":
                    return { ...base, status: "runtime_error", message: (testcase.error ?? "").slice(0, 2000) };
                default:
                    return {
                        ...base,
                        status: "judge_error",
                        message: `${testcase.verdict.type}${testcase.error ? `: ${testcase.error}` : ""}`.slice(0, 2000),
                    };
            }
        });
        return { runs };
    }

    /** Simultaneous communication: the evaluator runs the manager and every instance at once. */
    async communicate(request: CommunicationRequest): Promise<RunResult> {
        const merged: RunResult = { runs: [] };
        // each test occupies a sandbox per process, so chunks stay small
        const size = Math.max(1, Math.min(16, Math.floor(MAX_CHUNK_RUN_MS / request.timeLimitMs)));
        for (let offset = 0; offset < request.inputs.length; offset += size) {
            if (request.signal?.aborted) throw new Error("The build was cancelled");
            const inputs = request.inputs.slice(offset, offset + size);
            const id = await this.evaluationId();
            const message = {
                BeginEvaluation: {
                    output_queue: this.resultQueue,
                    evaluation: {
                        Communication: {
                            id,
                            code: request.program.source,
                            language: request.program.language,
                            testcases: inputs.map(testcaseOf),
                            time_limit: request.timeLimitMs,
                            memory_limit: request.memoryLimitMb * 1024,
                            evaluate_all: true,
                            checker: { script: request.manager.source, language: request.manager.language },
                            processes: request.processes,
                        },
                    },
                },
            };
            this.inFlight += 1;
            const timeout = this.config.runner.jobTimeoutMs + 2 * inputs.length * request.timeLimitMs + 60_000;
            const result = this.interpret(
                await this.send(id, message, timeout).finally(() => {
                    this.inFlight -= 1;
                }),
                inputs,
                false,
            );
            if (result.compileError !== undefined) return result;
            merged.runs.push(...result.runs);
        }
        return merged;
    }

    /** Output-only judging: one evaluation per output, a few in flight at a time. */
    async check(request: CheckRequest): Promise<RunResult> {
        const checker =
            typeof request.checking === "object"
                ? { script: request.checking.source, language: request.checking.language }
                : null;
        const merged: RunResult = { runs: [] };
        for (let offset = 0; offset < request.inputs.length; offset += CHECK_CONCURRENCY) {
            const results = await Promise.all(
                request.inputs.slice(offset, offset + CHECK_CONCURRENCY).map(async (input) => {
                    const id = await this.evaluationId();
                    const message = {
                        BeginEvaluation: {
                            output_queue: this.resultQueue,
                            evaluation: {
                                OutputOnly: {
                                    id,
                                    output: input.output,
                                    testcase: { id: input.id, input: input.stdin, output: input.expected },
                                    checker,
                                },
                            },
                        },
                    };
                    return this.interpret(await this.send(id, message), [input], false);
                }),
            );
            for (const result of results) {
                if (result.compileError !== undefined) return result;
                merged.runs.push(...result.runs);
            }
        }
        return merged;
    }

    async run(request: RunRequest): Promise<RunResult> {
        const chunks: RunInput[][] = [];
        let current: RunInput[] = [];
        let bytes = 0;
        for (const input of request.inputs) {
            const size = input.stdin.length + (input.expected?.length ?? 0);
            const tooLong = (current.length + 1) * request.timeLimitMs > MAX_CHUNK_RUN_MS;
            if (current.length > 0 && (bytes + size > MAX_CHUNK_BYTES || current.length >= MAX_CHUNK_TESTS || tooLong)) {
                chunks.push(current);
                current = [];
                bytes = 0;
            }
            current.push(input);
            bytes += size;
        }
        if (current.length > 0) chunks.push(current);

        const merged: RunResult = { runs: [] };
        for (const chunk of chunks) {
            if (request.signal?.aborted) throw new Error("The build was cancelled");
            this.inFlight += 1;
            const result = await this.evaluate(request, chunk).finally(() => {
                this.inFlight -= 1;
            });
            if (result.compileError !== undefined) return result;
            merged.runs.push(...result.runs);
        }
        return merged;
    }

    async close() {
        this.closed = true;
        // answers nobody will read any more
        await this.client.del(this.resultQueue).catch(() => {});
        await this.listener.disconnect().catch(() => {});
        await this.client.disconnect().catch(() => {});
    }
}
