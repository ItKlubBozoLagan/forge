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

    it("judges submitted outputs without running anything of the contestant's", async () => {
        const plain = await runner.check({
            checking: "tokens",
            inputs: [
                { id: "same", stdin: "1\n", expected: "42\n", output: "42  \n" },
                { id: "other", stdin: "1\n", expected: "42\n", output: "41\n" },
            ],
        });
        expect(plain.runs.map((run) => [run.id, run.status])).toEqual([
            ["same", "accepted"],
            ["other", "wrong_answer"],
        ]);

        const checker = `import sys
text = sys.stdin.read()
separator = text.split("\\n", 1)[0]
_, test_input, expected, actual, _ = text.split(separator + "\\n")
print("AC" if actual.split() == expected.split() else "custom:0.5" if actual.split() == test_input.split() else "WA")`;
        const scored = await runner.check({
            checking: { language: "python", source: checker },
            inputs: [
                { id: "full", stdin: "1\n", expected: "42\n", output: "42\n" },
                { id: "half", stdin: "1\n", expected: "42\n", output: "1\n" },
                { id: "none", stdin: "1\n", expected: "42\n", output: "9\n" },
            ],
        });
        expect(scored.runs.map((run) => [run.status, run.data])).toEqual([
            ["accepted", undefined],
            ["custom", "0.5"],
            ["wrong_answer", undefined],
        ]);

        const broken = await runner.check({ checking: { language: "cpp", source: "int main() { return x; }" }, inputs: [{ id: "a", stdin: "", expected: "", output: "" }] });
        expect(broken.compileError).toBeDefined();
    });

    it("runs a solution against an interactor", async () => {
        const interactor = `import sys
def finish(verdict):
    open("interactor_meta.out", "w").write(verdict)
    sys.exit(0)
def tokens():
    for line in sys.stdin:
        yield from line.split()
reader = tokens()
secret = int(next(reader))
print(100, flush=True)
for _ in range(7):
    token = next(reader, None)
    if token is None or not token.isdigit():
        finish("WA")
    if int(token) == secret:
        print("=", flush=True)
        finish("AC")
    print("<" if secret < int(token) else ">", flush=True)
finish("WA")`;
        const binary = `low, high = 1, int(input())
while True:
    middle = (low + high) // 2
    print(middle, flush=True)
    answer = input()
    if answer == "=":
        break
    if answer == "<":
        high = middle - 1
    else:
        low = middle + 1`;
        const result = await runner.run({
            program: { language: "python", source: binary },
            inputs: [
                { id: "a", stdin: "37\n", expected: "" },
                { id: "b", stdin: "100\n", expected: "" },
            ],
            checking: { language: "python", source: interactor },
            interactive: true,
            ...limits,
        });
        expect(result.runs.map((run) => [run.id, run.status])).toEqual([
            ["a", "accepted"],
            ["b", "accepted"],
        ]);
    });
});
