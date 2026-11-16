import { randomUUID } from "node:crypto";

import { createClient } from "redis";

import { Config } from "../config";
import { CheckRequest, RunInput, Runner, RunOutcome, RunRequest, RunResult } from "./types";

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
const CHECK_CONCURRENCY = 8;

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

/** Runs programs on kontestis evaluator instances through their existing Redis protocol. */
export class EvaluatorRunner implements Runner {
    readonly pool: string;
    readonly hardwareClass: string;
    private client;
    private listener;
    private resultQueue = `forge_results:${randomUUID()}`;
    private pending = new Map<string, (result: EvaluatorResult | undefined) => void>();
    private closed = false;

    constructor(private config: Config) {
        this.pool = config.runner.pool;
        this.hardwareClass = config.runner.hardwareClass;
        this.client = createClient({ url: config.redisUrl });
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
        const id = randomUUID();
        const checker =
            typeof request.checking === "object"
                ? { script: request.checking.source, language: request.checking.language }
                : null;
        const body = {
            id,
            code: request.program.source,
            language: request.program.language,
            testcases: inputs.map((input) => ({
                id: input.id,
                input: input.stdin,
                output: input.expected ?? "",
            })),
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
        return this.interpret(await this.send(id, message), inputs, request.checking === "capture");
    }

    private async send(id: string, message: unknown): Promise<EvaluatorResult | undefined> {
        const answer = new Promise<EvaluatorResult | undefined>((resolve) => {
            this.pending.set(id, resolve);
            setTimeout(() => {
                if (this.pending.delete(id)) resolve(undefined);
            }, this.config.runner.jobTimeoutMs).unref();
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
                    const id = randomUUID();
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
            if (current.length > 0 && (bytes + size > MAX_CHUNK_BYTES || current.length >= MAX_CHUNK_TESTS)) {
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
            const result = await this.evaluate(request, chunk);
            if (result.compileError !== undefined) return result;
            merged.runs.push(...result.runs);
        }
        return merged;
    }

    async close() {
        this.closed = true;
        await this.listener.disconnect().catch(() => {});
        await this.client.disconnect().catch(() => {});
    }
}
