import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config";
import { EvaluatorRunner } from "../src/runner/evaluator";

// Needs a kontestis evaluator consuming EVALUATOR_QUEUE_KEY; run with FORGE_TEST_EVALUATOR=1.
const enabled = process.env.FORGE_TEST_EVALUATOR === "1";

describe.skipIf(!enabled)("evaluator adapter", () => {
    let runner: EvaluatorRunner;
    const limits = { timeLimitMs: 1000, memoryLimitMb: 256 };

    beforeAll(async () => {
        process.env.EVALUATOR_QUEUE_KEY ??= "forge_evaluator_queue";
        runner = new EvaluatorRunner(loadConfig());
        await runner.init();
    });
    afterAll(() => runner.close());

    it("captures the output of a program", async () => {
        const result = await runner.run({
            program: { language: "python", source: "print(int(input()) * 2)" },
            inputs: [
                { id: "a", stdin: "21\n" },
                { id: "b", stdin: "5\n" },
            ],
            checking: "capture",
            ...limits,
        });
        expect(result.runs.map((run) => [run.id, run.status, run.stdout?.trim()])).toEqual([
            ["a", "accepted", "42"],
            ["b", "accepted", "10"],
        ]);
    });

    it("maps wrong answers, crashes, timeouts and compile errors", async () => {
        const source = `#include <cstdio>
int main() { int n; scanf("%d", &n); if (n == 2) return 3; if (n == 3) for (;;) {} printf("%d\\n", n); }`;
        const result = await runner.run({
            program: { language: "cpp", source },
            inputs: [
                { id: "ok", stdin: "1\n", expected: "1\n" },
                { id: "wrong", stdin: "1\n", expected: "7\n" },
                { id: "crash", stdin: "2\n", expected: "2\n" },
                { id: "slow", stdin: "3\n", expected: "3\n" },
            ],
            checking: "tokens",
            ...limits,
        });
        expect(result.runs.map((run) => run.status)).toEqual(["accepted", "wrong_answer", "runtime_error", "time_limit_exceeded"]);
        expect(result.runs[3]!.timeMs).toBeGreaterThanOrEqual(1000);

        const broken = await runner.run({ program: { language: "cpp", source: "int main() { return x; }" }, inputs: [{ id: "a", stdin: "" }], checking: "capture", ...limits });
        expect(broken.compileError).toContain("was not declared");
        expect(broken.compileError).not.toContain("\u001b");
    });

    it("passes partial scores from a custom checker through", async () => {
        const checker = `import sys
text = sys.stdin.read()
separator = text.split("\\n", 1)[0]
_, test_input, expected, actual, _ = text.split(separator + "\\n")
print("AC" if actual.split() == expected.split() else "custom:0.25")`;
        const result = await runner.run({
            program: { language: "python", source: "print(input())" },
            inputs: [
                { id: "same", stdin: "x\n", expected: "x\n" },
                { id: "other", stdin: "x\n", expected: "y\n" },
            ],
            checking: { language: "python", source: checker },
            ...limits,
        });
        expect(result.runs.map((run) => [run.status, run.data])).toEqual([
            ["accepted", undefined],
            ["custom", "0.25"],
        ]);
    });
});
