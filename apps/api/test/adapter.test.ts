import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The evaluator adapter against a scripted Redis: an "evaluator" that answers only messages
 * whose evaluation id has the type it understands, exactly like the real one, which drops
 * anything it cannot parse.
 */
const state = vi.hoisted(() => ({
    accepts: "number" as "number" | "string" | "nothing",
    messages: [] as any[],
    queues: new Map<string, string[]>(),
    waiters: new Map<string, Array<(value: string) => void>>(),
    deleted: [] as string[],
}));

const deliver = (queue: string, value: string) => {
    const waiter = state.waiters.get(queue)?.shift();
    if (waiter) waiter(value);
    else state.queues.set(queue, [...(state.queues.get(queue) ?? []), value]);
};

vi.mock("redis", () => {
    const client = () => ({
        on: () => {},
        connect: async () => {},
        disconnect: async () => {},
        duplicate: () => client(),
        del: async (key: string) => void state.deleted.push(key),
        rPush: async (_queue: string, raw: string) => {
            const { output_queue, evaluation } = JSON.parse(raw).BeginEvaluation;
            const body = evaluation.Batch ?? evaluation.Interactive ?? evaluation.OutputOnly;
            state.messages.push(evaluation);
            if (typeof body.id !== state.accepts) return;
            const testcases = (body.testcases ?? [body.testcase]).map((testcase: { id: string }) => ({
                id: testcase.id,
                verdict: { type: "accepted" },
                time: 1,
                memory: 1,
                output: "ok",
            }));
            deliver(output_queue, JSON.stringify({ evaluation_id: body.id, verdict: { type: "accepted" }, testcases }));
        },
        blPop: (queue: string) =>
            new Promise((resolve) => {
                const ready = state.queues.get(queue)?.shift();
                if (ready !== undefined) return resolve({ key: queue, element: ready });
                const waiter = (value: string) => resolve({ key: queue, element: value });
                state.waiters.set(queue, [...(state.waiters.get(queue) ?? []), waiter]);
                setTimeout(() => {
                    const list = state.waiters.get(queue) ?? [];
                    if (list.includes(waiter)) {
                        state.waiters.set(queue, list.filter((entry) => entry !== waiter));
                        resolve(null);
                    }
                }, 50);
            }),
    });
    return { createClient: client };
});

const { loadConfig } = await import("../src/config");
const { EvaluatorRunner } = await import("../src/runner/evaluator");

const start = async (accepts: typeof state.accepts, idFormat = "auto") => {
    state.accepts = accepts;
    state.messages.length = 0;
    state.queues.clear();
    state.waiters.clear();
    process.env.EVALUATOR_ID_FORMAT = idFormat;
    const runner = new EvaluatorRunner(loadConfig());
    await runner.init();
    return runner;
};

const request = (count: number, timeLimitMs = 1000) => ({
    program: { language: "python" as const, source: "print(1)" },
    inputs: Array.from({ length: count }, (_, index) => ({ id: `t${index}`, stdin: "1\n", expected: "1\n" })),
    checking: "tokens" as const,
    timeLimitMs,
    memoryLimitMb: 256,
});

const jobs = () => state.messages.filter((message) => message.Batch).map((message) => message.Batch);

describe("evaluator adapter against a scripted queue", () => {
    let runner: InstanceType<typeof EvaluatorRunner>;
    afterEach(() => runner.close());

    it("finds out that the evaluator takes numeric ids, as evaluator master and kontestis do", async () => {
        runner = await start("number");
        const result = await runner.run(request(2));
        expect(result.runs.map((run) => run.status)).toEqual(["accepted", "accepted"]);
        expect(jobs().map((job) => typeof job.id)).toEqual(["number"]);
        // the decision is kept: later jobs are not probed again
        const probes = state.messages.filter((message) => message.OutputOnly).length;
        await runner.run(request(1));
        expect(state.messages.filter((message) => message.OutputOnly)).toHaveLength(probes);
        expect(jobs().map((job) => typeof job.id)).toEqual(["number", "number"]);
    });

    it("finds out that the evaluator takes string ids", async () => {
        runner = await start("string");
        const result = await runner.run(request(1));
        expect(result.runs[0]!.status).toBe("accepted");
        expect(jobs().map((job) => typeof job.id)).toEqual(["string"]);
    });

    it("sends the configured id form without probing", async () => {
        runner = await start("string", "string");
        await runner.run(request(1));
        expect(state.messages.filter((message) => message.OutputOnly)).toHaveLength(0);
        expect(typeof jobs()[0].id).toBe("string");
    });

    it("splits work by test count and by worst-case run time", async () => {
        runner = await start("number", "number");
        const many = await runner.run(request(150));
        expect(many.runs).toHaveLength(150);
        expect(jobs().map((job) => job.testcases.length)).toEqual([64, 64, 22]);

        state.messages.length = 0;
        // 15 s per test: four minutes of worst-case run time is 16 tests
        await runner.run(request(40, 15_000));
        expect(jobs().map((job) => job.testcases.length)).toEqual([16, 16, 8]);
        expect(jobs().every((job) => job.time_limit === 15_000 && job.memory_limit === 256 * 1024 && job.evaluate_all === true)).toBe(true);
    });

    it("stops sending chunks once the build is cancelled", async () => {
        runner = await start("number", "number");
        const controller = new AbortController();
        controller.abort();
        await expect(runner.run({ ...request(150), signal: controller.signal })).rejects.toThrow("cancelled");
        expect(jobs()).toHaveLength(0);
    });

    it("reports a runner that answers nothing as not alive, and removes its result queue on close", async () => {
        runner = await start("nothing");
        expect(await runner.alive()).toBe(false);
        state.accepts = "number";
        expect(await runner.alive()).toBe(true);
        await runner.close();
        expect(state.deleted.some((key) => key.startsWith("forge_results:"))).toBe(true);
    }, 20_000);
});
