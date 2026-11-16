import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { builtinCheckerSource } from "@forge/core";

import { loadConfig } from "../src/config";
import { frameInput, withTestlib } from "../src/engine/testlib";
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

    it("runs testlib generators and checkers and the built-in float checker in the sandbox", async () => {
        const generator = withTestlib(
            `#include "testlib.h"\n#include <cstdlib>\nint main(int argc, char* argv[]) {\n    registerGen(argc, argv, 1);\n    println(rnd.next(1, atoi(argv[1])));\n}\n`,
            "cpp",
            "generator",
        );
        const generated = await runner.run({
            program: { language: "cpp", source: generator },
            inputs: [
                { id: "a", stdin: "50 1\n" },
                { id: "b", stdin: "50 1\n" },
                { id: "c", stdin: "1 9\n" },
            ],
            checking: "capture",
            timeLimitMs: 5000,
            memoryLimitMb: 512,
        });
        expect(generated.compileError).toBeUndefined();
        expect(generated.runs.map((run) => run.status)).toEqual(["accepted", "accepted", "accepted"]);
        expect(generated.runs[0]!.stdout).toBe(generated.runs[1]!.stdout);
        expect(generated.runs[2]!.stdout?.trim()).toBe("1");

        const checker = withTestlib(
            `#include "testlib.h"\nint main(int argc, char* argv[]) {\n    registerTestlibCmd(argc, argv);\n    int expected = ans.readInt(), found = ouf.readInt();\n    if (expected == found) quitf(_ok, "correct");\n    if (found == expected + 1) quitp(0.5, "off by one");\n    quitf(_wa, "expected %d, found %d", expected, found);\n}\n`,
            "cpp",
            "checker",
        );
        const checked = await runner.check({
            checking: { language: "cpp", source: checker },
            inputs: [
                { id: "right", stdin: "2\n", expected: "4\n", output: "4\n" },
                { id: "close", stdin: "2\n", expected: "4\n", output: "5\n" },
                { id: "wrong", stdin: "2\n", expected: "4\n", output: "9\n" },
                { id: "empty", stdin: "2\n", expected: "4\n", output: "" },
            ],
        });
        expect(checked.compileError).toBeUndefined();
        expect(checked.runs.map((run) => [run.status, run.data])).toEqual([
            ["accepted", undefined],
            ["custom", "partial:0.500000"],
            ["wrong_answer", undefined],
            ["wrong_answer", undefined],
        ]);

        const float = await runner.check({
            checking: { language: "python", source: builtinCheckerSource("float", 1e-3) },
            inputs: [
                { id: "near", stdin: "", expected: "1.0 yes\n", output: "1.0004 yes\n" },
                { id: "far", stdin: "", expected: "1.0 yes\n", output: "1.1 yes\n" },
            ],
        });
        expect(float.runs.map((run) => run.status)).toEqual(["accepted", "wrong_answer"]);
    }, 120_000);

    it("runs a testlib interactor and gets a testlib checker's comment in the sandbox", async () => {
        const interactor = withTestlib(
            `#include "testlib.h"\n#include <iostream>\nint main(int argc, char* argv[]) {\n    registerInteraction(argc, argv);\n    int secret = inf.readInt();\n    std::cout << 100 << std::endl;\n    for (int asked = 1; asked <= 7; asked++) {\n        int guess = ouf.readInt(1, 100, "guess");\n        if (guess == secret) { std::cout << "=" << std::endl; quitf(_ok, "found"); }\n        std::cout << (secret < guess ? "<" : ">") << std::endl;\n    }\n    quitf(_wa, "too many questions");\n}\n`,
            "cpp",
            "interactor",
        );
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
        const played = await runner.run({
            program: { language: "python", source: binary },
            inputs: [
                { id: "a", stdin: frameInput("37\n"), expected: "" },
                { id: "b", stdin: frameInput("100\n"), expected: "" },
            ],
            checking: { language: "cpp", source: interactor },
            interactive: true,
            timeLimitMs: 2000,
            memoryLimitMb: 256,
        });
        expect(played.compileError).toBeUndefined();
        expect(played.runs.map((run) => [run.id, run.status])).toEqual([
            ["a", "accepted"],
            ["b", "accepted"],
        ]);

        const explain = withTestlib(
            `#include "testlib.h"\nint main(int argc, char* argv[]) {\n    registerTestlibCmd(argc, argv);\n    int expected = ans.readInt(), found = ouf.readInt();\n    if (expected != found) quitf(_wa, "expected %d, found %d", expected, found);\n    quitf(_ok, "ok");\n}\n`,
            "cpp",
            "checker",
            true,
        );
        const separator = "[0123456789abcdef]\n";
        const commented = await runner.run({
            program: { language: "cpp", source: explain },
            inputs: [{ id: "x", stdin: `${separator}2\n\n${separator}4\n\n${separator}9\n\n${separator}` }],
            checking: "capture",
            timeLimitMs: 5000,
            memoryLimitMb: 512,
        });
        expect(commented.runs[0]!.stdout).toContain("expected 4, found 9");
    }, 120_000);

    // These need an evaluator built from its feat/forge-runner branch: FORGE_TEST_EVALUATOR_FEATURES=1.
    it.skipIf(process.env.FORGE_TEST_EVALUATOR_FEATURES !== "1")("delivers binary input and runs instances at the same time", async () => {
        const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x80, 0x41]);
        const counted = await runner.run({
            program: { language: "python", source: "import sys\ndata = sys.stdin.buffer.read()\nprint(len(data), sum(data))" },
            inputs: [
                { id: "raw", stdin: "", stdinBase64: bytes.toString("base64") },
                { id: "text", stdin: "AB" },
            ],
            checking: "capture",
            ...limits,
        });
        expect(counted.runs.map((run) => [run.id, run.status, run.stdout?.trim()])).toEqual([
            ["raw", "accepted", "5 702"],
            ["text", "accepted", "2 131"],
        ]);

        const manager = `import sys
raw = sys.stdin.buffer
length = int(raw.readline())
n = int(raw.read(length))
raw.readline()
def send(instance, text):
    sys.stdout.write(f"{instance}:{text}\\n")
    sys.stdout.flush()
def finish(verdict):
    with open("interactor_meta.out", "w") as meta:
        meta.write(verdict)
    sys.exit(0)
def receive(instance):
    while True:
        line = raw.readline().decode().rstrip("\\n")
        if line == "" or line.startswith(f"{instance}!"):
            finish("WA")
        if line.startswith(f"{instance}:"):
            return line[len(str(instance)) + 1:]
send(1, f"A {n}")
send(2, "B")
message = receive(1)
send(2, message)
finish("AC" if receive(2).strip() == str(2 * n) else "WA")`;
        const solution = (extra: number) => `role = input().split()
if role[0] == "A":
    print(role[1], flush=True)
else:
    print(int(input()) * 2 + ${extra}, flush=True)`;
        const talk = (extra: number) =>
            runner.communicate({
                program: { language: "python", source: solution(extra) },
                manager: { language: "python", source: manager },
                inputs: [
                    { id: "a", stdin: "2\n" },
                    { id: "b", stdin: "21\n" },
                ],
                processes: 2,
                timeLimitMs: 2000,
                memoryLimitMb: 256,
            });
        expect((await talk(0)).runs.map((run) => [run.id, run.status])).toEqual([
            ["a", "accepted"],
            ["b", "accepted"],
        ]);
        expect((await talk(1)).runs.map((run) => run.status)).toEqual(["wrong_answer", "wrong_answer"]);
    }, 120_000);
});
