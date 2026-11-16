import { createServer as createHttpServer } from "node:http";
import { AddressInfo } from "node:net";

import { unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Scheduler } from "../src/runner/scheduler";
import { Client, createProblem, finished, Harness, login, readFile, startHarness, writeFile } from "./harness";

let harness: Harness;
let ana: Client;
let problemId: string;

beforeAll(async () => {
    harness = await startHarness();
    ana = await login(harness, "Ana");
    problemId = await createProblem(ana, "pairs");
});
afterAll(() => harness.close());

const build = async (client: Client, id: string, body: object = {}) => {
    const queued = await client.post(`/problems/${id}/builds`, body);
    expect(queued.status).toBe(200);
    return finished(harness, client, queued.body.id);
};

describe("build pipeline", () => {
    it("builds the template green and reports what each solution did", async () => {
        const result = await build(ana, problemId);
        const report = result.output.report;
        expect(report.issues.filter((issue: any) => issue.severity === "error")).toEqual([]);
        expect(result.result).toBe("green");
        const byPath = Object.fromEntries(report.solutions.map((solution: any) => [solution.path, solution]));
        expect(byPath["solutions/main.cpp"].score).toBe(100);
        expect(byPath["solutions/brute.cpp"].score).toBe(30);
        expect(byPath["solutions/brute.cpp"].groups.find((group: any) => group.group === "full").summary).toBe("TLE");
        expect(byPath["solutions/overflow.cpp"].groups.find((group: any) => group.group === "full").summary).toBe("WA");
        // tests of "small" are also validated against "full", which depends on it
        const small = result.output.tests.find((test: any) => test.id === "small/1");
        expect(small.validation).toEqual({ small: null, full: null });
        expect(report.kills.find((row: any) => row.solution === "solutions/overflow.cpp").killedBy).toEqual(["full/3", "full/4"]);
        expect(report.calibration.slowestAccepted).toBe("solutions/main.cpp");
    });

    it("re-runs nothing when nothing changed", async () => {
        const before = harness.runner.calls;
        const result = await build(ana, problemId);
        expect(result.result).toBe("green");
        expect(harness.runner.calls).toBe(before);
    });

    it("re-runs only what an edit invalidates", async () => {
        const before = harness.runner.calls;
        const source = await readFile(ana, problemId, "solutions/overflow.cpp");
        await writeFile(ana, problemId, "solutions/overflow.cpp", `${source}\n// touched\n`);
        await build(ana, problemId);
        // one solution changed: one batch of runs, no generation, validation or answers
        expect(harness.runner.calls).toBe(before + 1);
    });

    it("records a timing sample per run and adds more on re-measure", async () => {
        const first = await build(ana, problemId);
        const timing = await ana.get(`/builds/${first.id}/timing`);
        const sample = timing.body.samples["solutions/main.cpp"]["full/1"][0];
        expect(sample.hardwareClass).toBe("test-box");
        const again = await build(ana, problemId, { remeasure: true });
        const after = await ana.get(`/builds/${again.id}/timing`);
        expect(after.body.samples["solutions/main.cpp"]["full/1"][0].count).toBe(sample.count + 1);
    });

    it("goes red when a test breaks the constraints of its group", async () => {
        const id = await createProblem(ana, "invalid-test");
        const manifest = await readFile(ana, id, "problem.yaml");
        // 2000 numbers in a group that allows at most 1000
        await writeFile(ana, id, "problem.yaml", manifest.replace('args: "n=1000 mode=equal seed=9"', 'args: "n=2000 mode=equal seed=9"'));
        const result = await build(ana, id);
        expect(result.result).toBe("red");
        const invalid = result.output.report.issues.filter((issue: any) => issue.code === "test.invalid");
        expect(invalid).toHaveLength(1);
        expect(invalid[0].message).toContain('group "small"');
        expect(invalid[0].message).toContain("N=2000");
    });

    it("goes red when a solution does not behave as declared", async () => {
        const id = await createProblem(ana, "wrong-expectation");
        const manifest = await readFile(ana, id, "problem.yaml");
        await writeFile(ana, id, "problem.yaml", manifest.replace("small: AC, full: WA", "small: AC, full: AC"));
        const result = await build(ana, id);
        expect(result.result).toBe("red");
        expect(result.output.report.issues.map((issue: any) => issue.code)).toContain("expectation.unmet");
    });

    it("reports a broken manifest without running anything", async () => {
        const id = await createProblem(ana, "broken");
        await writeFile(ana, id, "problem.yaml", "name: broken\nlimits: nope\n");
        const before = harness.runner.calls;
        const result = await build(ana, id);
        expect(result.result).toBe("red");
        expect(result.output.report.issues[0].code).toBe("manifest.schema");
        expect(harness.runner.calls).toBe(before);
    });

    it("supports checkers with partial scores", async () => {
        const id = await createProblem(ana, "partial", "honi");
        const manifest = await readFile(ana, id, "problem.yaml");
        // half the points for an answer that is off by one
        await writeFile(
            ana,
            id,
            "checker.py",
            `import sys
text = sys.stdin.read()
separator = text.split("\\n", 1)[0]
_, test_input, expected, actual, _ = text.split(separator + "\\n")
expected, actual = int(expected.split()[0]), int(actual.split()[0])
print("AC" if actual == expected else "custom:0.5" if abs(actual - expected) == 1 else "WA")
`,
        );
        await writeFile(ana, id, "solutions/offbyone.py", "n, k = map(int, input().split())\na = list(map(int, input().split()))\nprint(sum(1 for i in range(n) for j in range(i + 1, n) if a[i] + a[j] == k) + 1)\n");
        await writeFile(
            ana,
            id,
            "problem.yaml",
            manifest
                .replace("validator: validator.py", "validator: validator.py\nchecker: checker.py")
                .replace("solutions:\n", "solutions:\n  - { path: solutions/offbyone.py, expect: { samples: PA, cluster1: PA, cluster2: PA } }\n"),
        );
        const result = await build(ana, id);
        const solution = result.output.report.solutions.find((entry: any) => entry.path === "solutions/offbyone.py");
        expect(solution.groups.find((group: any) => group.group === "cluster1")).toMatchObject({ summary: "PA", score: 10, meets: true });
    });
});

describe("task types", () => {
    it("builds an interactive task by piping the solution to the interactor", async () => {
        const id = await createProblem(ana, "guess", "interactive");
        const result = await build(ana, id);
        expect(result.output.report.issues.filter((issue: any) => issue.severity === "error")).toEqual([]);
        expect(result.result).toBe("green");
        const byPath = Object.fromEntries(result.output.report.solutions.map((solution: any) => [solution.path, solution]));
        expect(byPath["solutions/binary.py"].score).toBe(1);
        expect(byPath["solutions/linear.py"].groups.map((group: any) => group.summary)).toEqual(["AC", "WA"]);
        expect(result.output.matrix["solutions/linear.py"]["secret/1"].verdict).toBe("AC");
    });

    it("builds an output-only task from programs and from directories of outputs", async () => {
        const id = await createProblem(ana, "pack", "output-only");
        const result = await build(ana, id);
        const report = result.output.report;
        expect(report.issues.filter((issue: any) => issue.severity === "error")).toEqual([]);
        expect(result.result).toBe("green");
        expect(result.output.type).toBe("output-only");
        const byPath = Object.fromEntries(report.solutions.map((solution: any) => [solution.path, solution]));
        expect(byPath["solutions/main.py"].score).toBe(100);
        // 8/10 and 17/20 of the two tests, averaged
        expect(byPath["solutions/greedy"].score).toBe(82.5);
        expect(byPath["solutions/greedy"].groups[1].summary).toBe("PA");
        expect(byPath["solutions/unfinished"].score).toBe(50);
        expect(result.output.matrix["solutions/unfinished"]["tests/2"]).toMatchObject({ verdict: "WA", message: "no output file for this test" });
        // nobody's program is timed, so there is nothing to calibrate
        expect(report.calibration.slowestAcceptedMs).toBeUndefined();

        // checking outputs is cached like everything else
        const before = harness.runner.calls;
        await build(ana, id);
        expect(harness.runner.calls).toBe(before);

        // filling in the missing output changes the verdict and re-checks only that file
        await writeFile(ana, id, "solutions/unfinished/tests/2.out", "3\n1 4 5\n");
        const fixed = await build(ana, id);
        expect(harness.runner.calls).toBe(before + 1);
        expect(fixed.output.matrix["solutions/unfinished"]["tests/2"].verdict).toBe("AC");
        expect(fixed.result).toBe("red");
        expect(fixed.output.report.issues.map((issue: any) => issue.code)).toContain("expectation.unmet");
    });

    it("takes reference answers from a directory when the main solution is one", async () => {
        const id = await createProblem(ana, "pack-files", "output-only");
        await writeFile(ana, id, "solutions/best/samples/1.out", "2\n1 2\n");
        await writeFile(ana, id, "solutions/best/tests/1.out", "2\n3 4\n");
        await writeFile(ana, id, "solutions/best/tests/2.out", "3\n1 4 5\n");
        const manifest = await readFile(ana, id, "problem.yaml");
        await writeFile(ana, id, "problem.yaml", manifest.replace("{ path: solutions/main.py, role: main }", "{ path: solutions/best, role: main }\n  - { path: solutions/main.py }"));
        const result = await build(ana, id);
        expect(result.output.report.issues.filter((issue: any) => issue.severity === "error")).toEqual([]);
        expect(result.result).toBe("green");
        expect(result.output.report.solutions.map((solution: any) => [solution.path, solution.score])).toEqual([
            ["solutions/best", 100],
            ["solutions/main.py", 100],
            ["solutions/greedy", 82.5],
            ["solutions/unfinished", 50],
        ]);
    });
});

describe("what authors need to debug", () => {
    it("keeps what each solution printed and scores kontestis-style partial verdicts", async () => {
        const id = await createProblem(ana, "outputs", "honi");
        const manifest = await readFile(ana, id, "problem.yaml");
        // kontestis awards partial credit for custom:partial:<fraction>
        await writeFile(
            ana,
            id,
            "checker.py",
            `import sys
text = sys.stdin.read()
separator = text.split("\\n", 1)[0]
_, test_input, expected, actual, _ = text.split(separator + "\\n")
expected, actual = int(expected.split()[0]), int(actual.split()[0])
print("AC" if actual == expected else "custom:partial:0.25" if abs(actual - expected) == 1 else "WA")
`,
        );
        await writeFile(ana, id, "solutions/offbyone.py", "n, k = map(int, input().split())\na = list(map(int, input().split()))\nprint(sum(1 for i in range(n) for j in range(i + 1, n) if a[i] + a[j] == k) + 1)\n");
        await writeFile(
            ana,
            id,
            "problem.yaml",
            manifest
                .replace("validator: validator.py", "validator: validator.py\nchecker: checker.py")
                .replace("solutions:\n", "solutions:\n  - { path: solutions/offbyone.py, expect: { samples: PA, cluster1: PA, cluster2: PA } }\n"),
        );
        const result = await build(ana, id);
        const solution = result.output.report.solutions.find((entry: any) => entry.path === "solutions/offbyone.py");
        expect(solution.groups.find((group: any) => group.group === "cluster1")).toMatchObject({ summary: "PA", score: 5, meets: true });

        // the sample answer is 2; the off-by-one solution printed 3, and that is on record
        const cell = result.output.matrix["solutions/offbyone.py"]["samples/1"];
        expect(cell.verdict).toBe("PA");
        const printed = await ana.get(`/problems/${id}/blobs/${cell.outputHash}`);
        expect(printed.raw.toString().trim()).toBe("3");
    });

    it("reports a solution that does not compile once, with the compiler's output", async () => {
        const id = await createProblem(ana, "nocompile");
        await writeFile(ana, id, "solutions/overflow.cpp", "int main() { return undeclared_thing; }\n");
        const result = await build(ana, id);
        expect(result.result).toBe("red");
        const issues = result.output.report.issues.filter((issue: any) => issue.code === "solution.compile");
        expect(issues).toHaveLength(1);
        expect(issues[0].ref).toBe("solutions/overflow.cpp");
        expect(issues[0].message).toContain("undeclared_thing");
    });

    it("refuses a statement with a placeholder problem.yaml cannot fill", async () => {
        const id = await createProblem(ana, "placeholder");
        const statement = await readFile(ana, id, "statement/en.md");
        await writeFile(ana, id, "statement/en.md", `${statement}\nAt most {{M.max}} edges.\n`);
        const result = await build(ana, id);
        expect(result.result).toBe("red");
        const issue = result.output.report.issues.find((entry: any) => entry.code === "statement.unresolved");
        expect(issue.message).toContain("{{M.max}}");
    });

    it("runs an author's invocation against the working copy, not the last revision", async () => {
        const id = await createProblem(ana, "invoke-draft");
        const committed = await ana.post(`/problems/${id}/revisions`, { message: "First" });
        await finished(harness, ana, committed.body.buildId);
        // after the commit the author drops the big group from the working copy
        const manifest = await readFile(ana, id, "problem.yaml");
        await writeFile(ana, id, "problem.yaml", manifest.replace("    depends: [small]\n", "    depends: [small, samples]\n"));
        const source = await readFile(ana, id, "solutions/main.cpp");
        const draft = await finished(harness, ana, (await ana.post(`/problems/${id}/invocations`, { name: "mine", language: "cpp", source })).body.id);
        expect(draft.revisionId).toBeNull();
        expect(draft.output.groups.find((group: any) => group.name === "full").depends).toEqual(["small", "samples"]);
        const pinned = await finished(harness, ana, (await ana.post(`/problems/${id}/invocations`, { name: "mine", language: "cpp", source, revision: committed.body.id })).body.id);
        expect(pinned.revisionId).toBe(committed.body.id);
        expect(pinned.output.groups.find((group: any) => group.name === "full").depends).toEqual(["small"]);
    });

    it("stress tests an interactive task through its interactor", async () => {
        const id = await createProblem(ana, "guess-stress", "interactive");
        await writeFile(ana, id, "generators/pick.py", "args = dict(part.split(\"=\") for part in input().split())\nprint(int(args[\"seed\"]) * 37 % N_MAX + 1)\n");
        const manifest = await readFile(ana, id, "problem.yaml");
        await writeFile(ana, id, "problem.yaml", manifest.replace("groups:\n", "generators:\n  pick: generators/pick.py\n\ngroups:\n"));
        const queued = await ana.post(`/problems/${id}/stress`, { generator: "pick", args: "seed={seed}", count: 4, seedStart: 100, solution: "solutions/linear.py", group: "secret" });
        expect(queued.status).toBe(200);
        const run = await finished(harness, ana, queued.body.id);
        expect(run.output.errors).toEqual([]);
        // the linear search only finds secrets up to 20; none of these are that small
        expect(run.output.passed).toBe(0);
        expect(run.output.failures.map((failure: any) => failure.verdict)).toEqual(["WA", "WA", "WA", "WA"]);
    });
});

describe("checkers", () => {
    it("ships built-in checkers, here one that tolerates floating point error", async () => {
        const id = await createProblem(ana, "floaty", "honi");
        const manifest = await readFile(ana, id, "problem.yaml");
        await writeFile(ana, id, "solutions/float.py", "n, k = map(int, input().split())\na = list(map(int, input().split()))\nprint(sum(1 for i in range(n) for j in range(i + 1, n) if a[i] + a[j] == k) + 0.001)\n");
        const withSolution = manifest.replace("solutions:\n", "solutions:\n  - { path: solutions/float.py, expect: { samples: AC, cluster1: AC, cluster2: AC } }\n");
        await writeFile(ana, id, "problem.yaml", withSolution.replace("validator: validator.py", "validator: validator.py\nchecker: { builtin: float, eps: 0.01 }"));
        const tolerant = await build(ana, id);
        expect(tolerant.output.checker).toBe("built-in float (eps 0.01)");
        expect(tolerant.output.matrix["solutions/float.py"]["samples/1"].verdict).toBe("AC");
        expect(tolerant.output.matrix["solutions/overflow.cpp"]["cluster3/3"].verdict).toBe("WA");

        // the judge's default comparison does not accept 2.001 for 2
        await writeFile(ana, id, "problem.yaml", withSolution);
        const strict = await build(ana, id);
        expect(strict.output.checker).toBeUndefined();
        expect(strict.output.matrix["solutions/float.py"]["samples/1"].verdict).toBe("WA");
    });

    it("runs testlib generators, validators and checkers, and uses hand-written answers", async () => {
        const id = await createProblem(ana, "polygon-style", "empty");
        await writeFile(ana, id, "gen.cpp", `#include "testlib.h"
#include <cstdlib>
int main(int argc, char* argv[]) {
    registerGen(argc, argv, 1);
    println(rnd.next(1, atoi(argv[1])));
}
`);
        await writeFile(ana, id, "validator.cpp", `#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    inf.readInt(1, (int)N_MAX, "n");
    inf.readEoln();
    inf.readEof();
}
`);
        await writeFile(ana, id, "checker.cpp", `#include "testlib.h"
int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    int expected = ans.readInt(), found = ouf.readInt();
    if (expected == found) quitf(_ok, "correct");
    if (found == expected + 1) quitp(0.5, "off by one");
    quitf(_wa, "expected %d, found %d", expected, found);
}
`);
        await writeFile(ana, id, "tests/one.in", "1\n");
        await writeFile(ana, id, "tests/one.ans", "2\n");
        await writeFile(ana, id, "tests/big.in", "500\n");
        await writeFile(ana, id, "sol.py", "print(int(input()) * 2)\n");
        await writeFile(ana, id, "half.py", "print(int(input()) * 2 + 1)\n");
        await writeFile(ana, id, "wrong.py", "print(0)\n");
        const manifest = `name: polygon-style
limits: { time_ms: 3000, memory_mb: 256 }
constraints: { N: { min: 1, max: 100 } }
validator: validator.cpp
checker: checker.cpp
generators: { gen: gen.cpp }
groups:
  - name: all
    points: 100
    aggregate: sum
    tests:
      - { gen: gen, args: "50 {i}", count: 2, desc: "random" }
      - { manual: tests/one.in, answer: tests/one.ans, desc: "smallest input" }
solutions:
  - { path: sol.py, role: main }
  - { path: half.py, expect: PA }
  - { path: wrong.py, expect: WA }
`;
        await writeFile(ana, id, "problem.yaml", manifest);
        const result = await build(ana, id);
        expect(result.output.report.issues.filter((issue: any) => issue.severity === "error")).toEqual([]);
        expect(result.result).toBe("green");
        const byPath = Object.fromEntries(result.output.report.solutions.map((solution: any) => [solution.path, solution]));
        expect(byPath["sol.py"].score).toBe(100);
        expect(byPath["half.py"].score).toBe(50);
        expect(byPath["wrong.py"].score).toBe(0);
        const manual = result.output.tests.find((test: any) => test.id === "all/3");
        expect(manual).toMatchObject({ desc: "smallest input", answerFile: "tests/one.ans", validation: { all: null } });
        expect((await ana.get(`/problems/${id}/blobs/${manual.answerHash}`)).raw.toString()).toBe("2\n");
        // the generator got its arguments as argv and is deterministic
        const generated = (await ana.get(`/problems/${id}/blobs/${result.output.tests[0].inputHash}`)).raw.toString();
        expect(Number(generated)).toBeGreaterThanOrEqual(1);
        expect(Number(generated)).toBeLessThanOrEqual(50);

        // the testlib validator rejects a test outside the constraints, with its own message
        await writeFile(ana, id, "problem.yaml", manifest.replace("      - { manual: tests/one.in", "      - { manual: tests/big.in }\n      - { manual: tests/one.in"));
        const invalid = await build(ana, id);
        expect(invalid.result).toBe("red");
        expect(invalid.output.tests.find((test: any) => test.id === "all/3").validation.all).toMatch(/violates the range|500/);
    }, 180_000);
});

describe("package handling", () => {
    it("downloads the package and a build's tests as zip archives", async () => {
        const id = await createProblem(ana, "archive");
        const result = await build(ana, id);
        const tests = await ana.get(`/builds/${result.id}/tests.zip`);
        expect(tests.status).toBe(200);
        const testFiles = unzipSync(new Uint8Array(tests.raw));
        expect(Buffer.from(testFiles["samples/001.in"]!).toString()).toBe("5 6\n1 5 3 3 2\n");
        expect(Buffer.from(testFiles["samples/001.out"]!).toString().trim()).toBe("2");
        expect(Object.keys(testFiles).filter((name) => name.endsWith(".in"))).toHaveLength(result.output.tests.length);

        const committed = await ana.post(`/problems/${id}/revisions`, { message: "First" });
        await finished(harness, ana, committed.body.buildId);
        await writeFile(ana, id, "notes.txt", "only in the working copy\n");
        const working = unzipSync(new Uint8Array((await ana.get(`/problems/${id}/archive`)).raw));
        expect(Buffer.from(working["notes.txt"]!).toString()).toBe("only in the working copy\n");
        expect(working["problem.yaml"]).toBeDefined();
        const frozen = unzipSync(new Uint8Array((await ana.get(`/problems/${id}/archive?revision=${committed.body.id}`)).raw));
        expect(frozen["notes.txt"]).toBeUndefined();
        expect(frozen["solutions/main.cpp"]).toBeDefined();
    });

    it("rebuilds from scratch on request and cancels a build in progress", async () => {
        const id = await createProblem(ana, "rebuild");
        await build(ana, id);
        const before = harness.runner.calls;
        expect((await build(ana, id)).result).toBe("green");
        expect(harness.runner.calls).toBe(before);
        expect((await build(ana, id, { clean: true })).result).toBe("green");
        // generation, validation, answers and every solution ran again
        expect(harness.runner.calls).toBeGreaterThanOrEqual(before + 6);

        // hold the runner so the build is certainly in the middle of its first step
        let release!: () => void;
        harness.runner.gate = new Promise<void>((resolve) => (release = resolve));
        const reached = new Promise<void>((resolve) => (harness.runner.onRun = resolve));
        const queued = await ana.post(`/problems/${id}/builds`, { clean: true });
        await reached;
        expect((await ana.get(`/builds/${queued.body.id}`)).body.status).toBe("running");
        const atCancel = harness.runner.calls;
        expect((await ana.post(`/builds/${queued.body.id}/cancel`)).status).toBe(200);
        release();
        harness.runner.gate = undefined;
        harness.runner.onRun = undefined;
        await harness.app.worker.idle();
        const cancelled = await ana.get(`/builds/${queued.body.id}`);
        expect(cancelled.body.status).toBe("failed");
        expect(cancelled.body.error).toBe("Cancelled by Ana");
        expect(cancelled.body.output).toBeNull();
        // steps already asked for stop at the gate; nothing after them is started
        expect(harness.runner.calls).toBeLessThanOrEqual(atCancel + 2);
        expect((await ana.post(`/builds/${queued.body.id}/cancel`)).status).toBe(409);
        expect((await build(ana, id)).result).toBe("green");
    });

    it("only serves a problem its own content, even inside one workspace", async () => {
        const first = await createProblem(ana, "vault-a");
        const second = await createProblem(ana, "vault-b");
        const secret = (await writeFile(ana, first, "notes/hidden.txt", "belongs to the first problem")).body.hash;
        expect((await ana.get(`/problems/${first}/blobs/${secret}`)).status).toBe(200);
        expect((await ana.get(`/problems/${second}/blobs/${secret}`)).status).toBe(404);
        expect((await ana.post(`/problems/${second}/sync`, { changes: [{ path: "copy.txt", base: null, hash: secret }] })).status).toBe(400);
        // content uploaded for a problem can be synced into it
        const uploaded = await ana.post(`/problems/${second}/blobs`, Buffer.from("fresh"));
        expect((await ana.post(`/problems/${second}/sync`, { changes: [{ path: "fresh.txt", base: null, hash: uploaded.body.hash }] })).status).toBe(200);
        // a review thread cannot point at a file the problem does not have
        expect((await ana.post(`/problems/${second}/threads`, { body: "look", path: "no/such/file.cpp", line: 3 })).status).toBe(400);
        expect((await ana.post(`/problems/${second}/threads`, { body: "look", path: "fresh.txt", line: 1 })).status).toBe(200);
    });

    it("places single samples in a statement and previews unsaved text", async () => {
        const id = await createProblem(ana, "samples");
        const statement = await readFile(ana, id, "statement/en.md");
        await writeFile(ana, id, "statement/en.md", statement.replace("{{samples}}", "{{sample.1}}\n\nThe pairs are (1, 5) and (3, 3).\n"));
        expect((await build(ana, id)).result).toBe("green");
        const rendered = (await ana.get(`/problems/${id}/statement`)).body;
        expect(rendered.markdown).toMatch(/### Sample 1[\s\S]*The pairs are/);
        expect(rendered.path).toBe("statement/en.md");
        expect(rendered.source).toContain("{{sample.1}}");

        const preview = await ana.post(`/problems/${id}/statement/preview`, { markdown: "At most {{N.max}} numbers, {{K.typo}}.\n\n{{sample.1}}\n{{sample.7}}" });
        expect(preview.body.markdown).toContain("2 \\cdot 10^{5}");
        expect(preview.body.markdown).toContain("### Sample 1");
        expect(preview.body.unresolved).toEqual(["K.typo", "sample.7"]);
    });
});

describe("polygon import", () => {
    it("imports a Polygon package and builds it with its own testlib tools", async () => {
        const text = (value: string) => new Uint8Array(Buffer.from(value));
        const archive = zipSync({
            "problem.xml": text(`<?xml version="1.0" encoding="utf-8" standalone="no"?>
<problem revision="7" short-name="double-it" url="https://polygon.example/p/double-it">
    <names><name language="english" value="Double It"/></names>
    <statements><statement charset="UTF-8" language="english" path="statements/english/problem.tex" type="application/x-tex"/></statements>
    <judging cpu-name="x" cpu-speed="3600" input-file="" output-file="" run-count="1">
        <testset name="tests">
            <time-limit>2000</time-limit>
            <memory-limit>268435456</memory-limit>
            <test-count>4</test-count>
            <input-path-pattern>tests/%02d</input-path-pattern>
            <answer-path-pattern>tests/%02d.a</answer-path-pattern>
            <tests>
                <test method="manual" sample="true"/>
                <test cmd="gen 100 1" method="generated"/>
                <test cmd="gen 100 2" method="generated"/>
                <test cmd="lost 5" method="generated"/>
            </tests>
        </testset>
    </judging>
    <files>
        <resources><file path="files/testlib.h" type="h.g++"/></resources>
        <executables>
            <executable><source path="files/gen.cpp" type="cpp.g++17"/></executable>
        </executables>
    </files>
    <assets>
        <checker name="std::ncmp.cpp" type="testlib"><source path="files/check.cpp" type="cpp.g++17"/></checker>
        <validators><validator><source path="files/validator.cpp" type="cpp.g++17"/></validator></validators>
        <solutions>
            <solution tag="main"><source path="solutions/sol.cpp" type="cpp.g++17"/></solution>
            <solution tag="wrong-answer"><source path="solutions/wrong.py" type="python.3"/></solution>
            <solution tag="time-limit-exceeded-or-accepted"><source path="solutions/maybe.py" type="python.3"/></solution>
        </solutions>
    </assets>
</problem>`),
            "files/gen.cpp": text(`#include "testlib.h"\n#include <cstdlib>\nint main(int argc, char* argv[]) {\n    registerGen(argc, argv, 1);\n    println(rnd.next(1, atoi(argv[1])));\n}\n`),
            "files/validator.cpp": text(`#include "testlib.h"\nint main(int argc, char* argv[]) {\n    registerValidation(argc, argv);\n    inf.readInt(1, 1000, "n");\n    inf.readEoln();\n    inf.readEof();\n}\n`),
            "files/check.cpp": text(`#include "testlib.h"\nint main(int argc, char* argv[]) {\n    registerTestlibCmd(argc, argv);\n    long long expected = ans.readLong(), found = ouf.readLong();\n    if (expected != found) quitf(_wa, "expected %lld, found %lld", expected, found);\n    quitf(_ok, "ok");\n}\n`),
            "files/testlib.h": text("// the real header is provided by Forge\n"),
            "solutions/sol.cpp": text(`#include <cstdio>\nint main() { int n; scanf("%d", &n); printf("%d\\n", 2 * n); }\n`),
            "solutions/wrong.py": text("print(int(input()) + 2)\n"),
            "solutions/maybe.py": text("print(int(input()) * 2)\n"),
            "tests/01": text("2\n"),
            "statements/english/problem-properties.json": text(JSON.stringify({ name: "Double It", legend: "Given $n$, print \\textbf{twice} $n$.", input: "One integer $n$.", output: "One integer." })),
        });
        const imported = await ana.post(`/workspaces/${ana.workspaceId}/import/polygon`, Buffer.from(archive));
        expect(imported.status).toBe(200);
        expect(imported.body).toMatchObject({ name: "double-it", title: "Double It" });
        const notes = imported.body.notes.join("\n");
        expect(notes).toContain('"lost 5"');
        expect(notes).toContain("time-limit-exceeded-or-accepted");
        const id = imported.body.id;
        expect(await readFile(ana, id, "statement/en.md")).toContain("print **twice** $n$");
        const manifest = await readFile(ana, id, "problem.yaml");
        expect(manifest).toContain("checker: checker.cpp");
        expect(manifest).toContain("args: 100 1");

        const result = await build(ana, id);
        expect(result.output.report.issues.filter((issue: any) => issue.severity === "error")).toEqual([]);
        expect(result.result).toBe("green");
        expect(result.output.tests.map((test: any) => test.id)).toEqual(["samples/1", "tests/1", "tests/2"]);
        const byPath = Object.fromEntries(result.output.report.solutions.map((solution: any) => [solution.path, solution]));
        expect(byPath["solutions/sol.cpp"].score).toBe(1);
        // n + 2 equals 2n only for the sample (n = 2)
        expect(byPath["solutions/wrong.py"].groups.map((group: any) => group.summary)).toEqual(["AC", "WA"]);

        // importing it again does not collide
        const again = await ana.post(`/workspaces/${ana.workspaceId}/import/polygon`, Buffer.from(archive));
        expect(again.body.name).toBe("double-it-2");
        expect((await ana.post(`/workspaces/${ana.workspaceId}/import/polygon`, Buffer.from("not a zip"))).status).toBe(400);
    }, 180_000);
});

describe("second audit", () => {
    it("serves statement figures to blind testers and with a usable content type", async () => {
        const id = await createProblem(ana, "figures");
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
        await writeFile(ana, id, "statement/figure.svg", svg);
        const own = await harness.server.inject({ method: "GET", url: `/api/problems/${id}/statement/asset?path=statement/figure.svg`, headers: ana.headers });
        expect(own.statusCode).toBe(200);
        expect(own.headers["content-type"]).toBe("image/svg+xml");
        expect(own.headers["content-security-policy"]).toContain("sandbox");
        // only statement assets, never the statement source or other package files
        expect((await ana.get(`/problems/${id}/statement/asset?path=statement/en.md`)).status).toBe(404);
        expect((await ana.get(`/problems/${id}/statement/asset?path=solutions/main.cpp`)).status).toBe(404);

        const cara = await login(harness, "Cara");
        await ana.post(`/workspaces/${ana.workspaceId}/members`, { email: "cara@dev.local" });
        await ana.put(`/problems/${id}/access/${cara.userId}`, { role: "tester" });
        // testers see the latest revision; nothing is committed yet
        expect((await cara.get(`/problems/${id}/statement/asset?path=statement/figure.svg`)).status).toBe(404);
        const committed = await ana.post(`/problems/${id}/revisions`, { message: "With a figure" });
        await finished(harness, ana, committed.body.buildId);
        expect((await cara.get(`/problems/${id}/statement/asset?path=statement/figure.svg`)).raw.toString()).toBe(svg);
        expect((await cara.get(`/problems/${id}/file?path=statement/figure.svg`)).status).toBe(403);
    });

    it("keeps at least one owner in a workspace", async () => {
        const demoted = await ana.post(`/workspaces/${ana.workspaceId}/members`, { email: "ana@dev.local", role: "member" });
        expect(demoted.status).toBe(409);
        expect((await ana.get(`/workspaces/${ana.workspaceId}/members`)).body.find((member: any) => member.id === ana.userId).role).toBe("owner");
    });

    it("needs a session to probe the runner", async () => {
        expect((await harness.server.inject({ method: "GET", url: "/api/health" })).json().ok).toBe(true);
        expect((await harness.server.inject({ method: "GET", url: "/api/health?runner=1" })).statusCode).toBe(401);
        expect((await ana.get("/health?runner=1")).body.runner.alive).toBe(true);
    });

    it("decides a verdict by the median of the measured times", async () => {
        const id = await createProblem(ana, "median");
        // a solution no other test has measured, so its samples are only the ones below
        await writeFile(ana, id, "solutions/main.cpp", `${await readFile(ana, id, "solutions/main.cpp")}\n// median test\n`);
        const first = await build(ana, id);
        const key = first.output.runKeys["solutions/main.cpp"]["samples/1"];
        // two much slower measurements of the same run on the same hardware
        await harness.app.sql`
            insert into timing_samples (workspace_id, node_key, runner_pool, hardware_class, time_ms, memory_kb)
            values (${ana.workspaceId}, ${key}, 'test', 'test-box', 5000, 1), (${ana.workspaceId}, ${key}, 'test', 'test-box', 6000, 1)`;
        const second = await build(ana, id);
        const cell = second.output.matrix["solutions/main.cpp"]["samples/1"];
        expect(cell.timeMs).toBe(5000);
        expect(cell.verdict).toBe("TLE");
        expect(second.result).toBe("red");
    });

    it("warns when a checker's partial score is in a form kontestis ignores", async () => {
        const id = await createProblem(ana, "bare-partial", "honi");
        const manifest = await readFile(ana, id, "problem.yaml");
        await writeFile(ana, id, "checker.py", `import sys
text = sys.stdin.read()
separator = text.split("\\n", 1)[0]
_, test_input, expected, actual, _ = text.split(separator + "\\n")
print("AC" if actual.split() == expected.split() else "custom:0.5")
`);
        await writeFile(ana, id, "problem.yaml", manifest.replace("type: batch", "type: batch\njudge: kontestis").replace("validator: validator.py", "validator: validator.py\nchecker: checker.py").replace("cluster3: WA", "cluster3: PA"));
        const result = await build(ana, id);
        const warnings = result.output.report.issues.filter((issue: any) => issue.code === "kontestis.incompatible").map((issue: any) => issue.message);
        expect(warnings.some((message: string) => message.includes('without "partial:"'))).toBe(true);
    });

    it("refuses a testlib interactor instead of failing at run time", async () => {
        const id = await createProblem(ana, "tl-interactor", "interactive");
        await writeFile(ana, id, "interactor.cpp", `#include "testlib.h"\nint main(int argc, char* argv[]) { registerInteraction(argc, argv); quitf(_ok, "ok"); }\n`);
        const manifest = await readFile(ana, id, "problem.yaml");
        await writeFile(ana, id, "problem.yaml", manifest.replace("checker: interactor.py", "checker: interactor.cpp"));
        const before = harness.runner.calls;
        const result = await build(ana, id);
        expect(result.result).toBe("red");
        expect(result.output.report.issues.map((issue: any) => issue.code)).toContain("interactor.testlib");
        // nothing was compiled or run for the solutions
        expect(harness.runner.calls).toBeLessThanOrEqual(before + 1);
    });
});

describe("working copy", () => {
    it("rejects an edit based on a stale version of the file", async () => {
        const id = await createProblem(ana, "stale");
        const tree = await ana.get(`/problems/${id}/tree`);
        const loaded = tree.body.files.find((file: any) => file.path === "statement/en.md").hash;
        expect((await ana.put(`/problems/${id}/file?path=statement/en.md`, Buffer.from("first"), { "if-match": loaded })).status).toBe(200);
        const stale = await ana.put(`/problems/${id}/file?path=statement/en.md`, Buffer.from("second"), { "if-match": loaded });
        expect(stale.status).toBe(409);
        expect(await readFile(ana, id, "statement/en.md")).toBe("first");
    });

    it("applies a sync atomically and refuses it when a path moved on the server", async () => {
        const id = await createProblem(ana, "sync");
        const tree = await ana.get(`/problems/${id}/tree`);
        const base = tree.body.files.find((file: any) => file.path === "statement/en.md").hash;
        const mine = (await ana.post(`/problems/${id}/blobs`, Buffer.from("mine"))).body.hash;
        const added = (await ana.post(`/problems/${id}/blobs`, Buffer.from("new file"))).body.hash;
        await writeFile(ana, id, "statement/en.md", "theirs");
        const refused = await ana.post(`/problems/${id}/sync`, {
            changes: [
                { path: "notes.txt", base: null, hash: added },
                { path: "statement/en.md", base, hash: mine },
            ],
        });
        expect(refused.status).toBe(409);
        expect(refused.body.error.detail.map((entry: any) => entry.path)).toEqual(["statement/en.md"]);
        // nothing was applied, not even the non-conflicting change
        expect((await ana.get(`/problems/${id}/file?path=notes.txt`)).status).toBe(404);
        const applied = await ana.post(`/problems/${id}/sync`, {
            changes: [
                { path: "notes.txt", base: null, hash: added },
                { path: "tests/sample1.in", base: tree.body.files.find((file: any) => file.path === "tests/sample1.in").hash, hash: null },
            ],
        });
        expect(applied.status).toBe(200);
        expect(await readFile(ana, id, "notes.txt")).toBe("new file");
        expect((await ana.get(`/problems/${id}/file?path=tests/sample1.in`)).status).toBe(404);
    });

    it("refuses paths that escape the package", async () => {
        for (const path of ["../x", "/etc/passwd", "a//b", "a/./b"])
            expect((await ana.put(`/problems/${problemId}/file?path=${encodeURIComponent(path)}`, Buffer.from("x"))).status).toBe(400);
    });
});

describe("revisions and problem sets", () => {
    it("commits, builds the revision and exports a judge bundle only when green", async () => {
        const id = await createProblem(ana, "release");
        const committed = await ana.post(`/problems/${id}/revisions`, { message: "First version" });
        expect(committed.body.number).toBe(1);
        expect((await finished(harness, ana, committed.body.buildId)).result).toBe("green");
        expect((await ana.post(`/problems/${id}/revisions`, { message: "Again" })).status).toBe(409);

        // a second, broken revision
        const manifest = await readFile(ana, id, "problem.yaml");
        await writeFile(ana, id, "problem.yaml", manifest.replace("small: AC, full: WA", "small: AC, full: AC"));
        const broken = await ana.post(`/problems/${id}/revisions`, { message: "Wrong expectation" });
        expect((await finished(harness, ana, broken.body.buildId)).result).toBe("red");

        const set = await ana.post(`/workspaces/${ana.workspaceId}/sets`, { name: "Round 1" });
        await ana.put(`/sets/${set.body.id}/entries`, { entries: [{ label: "A", problemId: id, revisionId: broken.body.id }] });
        const refused = await ana.get(`/sets/${set.body.id}/export`);
        expect(refused.status).toBe(409);
        expect(refused.body.error.detail[0]).toMatchObject({ label: "A", revision: 2, result: "red" });

        await ana.put(`/sets/${set.body.id}/entries`, { entries: [{ label: "A", problemId: id, revisionId: committed.body.id }] });
        const exported = await ana.get(`/sets/${set.body.id}/export`);
        expect(exported.status).toBe(200);
        const files = unzipSync(new Uint8Array(exported.raw));
        const text = (name: string) => Buffer.from(files[name]!).toString("utf8");
        expect(JSON.parse(text("bundle.json"))).toMatchObject({ format: "forge-bundle/1", problems: [{ label: "A", revision: 1 }] });
        const problem = JSON.parse(text("A/problem.json"));
        expect(problem.limits.time_ms).toBe(400);
        expect(problem.groups.find((group: any) => group.name === "full").tests).toContain("small/1");
        expect(text("A/tests/samples-001.in")).toBe("5 6\n1 5 3 3 2\n");
        expect(text("A/tests/samples-001.out").trim()).toBe("2");
        // no checker in this problem, so the bundle names none
        expect(problem.checker).toBeNull();
        // kontestis keeps a reference solution with every problem
        expect(problem.solution).toEqual({ path: "solution.cpp", language: "cpp" });
        expect(text("A/solution.cpp")).toBe(await readFile(ana, id, "solutions/main.cpp"));
        // the statement is rendered: constraints and samples are filled in
        expect(text("A/statement/en.md")).toContain("2 \\cdot 10^{5}");
        expect(text("A/statement/en.md")).toContain("### Sample 1");

        // restoring revision 1 makes the working copy equal to it again
        await ana.post(`/problems/${id}/revisions/${committed.body.id}/restore`);
        expect(await readFile(ana, id, "problem.yaml")).toBe(manifest);
    });
});

describe("stress testing", () => {
    it("finds a counterexample and promotes it into the test plan", async () => {
        const id = await createProblem(ana, "stress");
        const clean = await ana.post(`/problems/${id}/stress`, {
            generator: "rand", args: "n=20 maxv=5 seed={seed}", count: 10, solution: "solutions/brute.cpp", group: "small",
        });
        const cleanRun = await finished(harness, ana, clean.body.id);
        expect(cleanRun.output).toMatchObject({ total: 10, passed: 10, failures: [] });

        const queued = await ana.post(`/problems/${id}/stress`, {
            generator: "rand", args: "mode=equal seed={seed}", count: 2, seedStart: 50, solution: "solutions/overflow.cpp", group: "full",
        });
        const run = await finished(harness, ana, queued.body.id);
        expect(run.result).toBe("red");
        expect(run.output.failures.map((failure: any) => [failure.args, failure.verdict])).toEqual([
            ["mode=equal seed=50", "WA"],
            ["mode=equal seed=51", "WA"],
        ]);
        expect((await ana.post(`/builds/${run.id}/promote`, { args: "mode=equal seed=50" })).status).toBe(200);
        const manifest = await readFile(ana, id, "problem.yaml");
        expect(manifest).toContain('{ gen: rand, args: mode=equal seed=50 }');
        expect(manifest).toContain("# IOI style"); // comments survive the edit

        // generated tests that break the group's constraints are reported as generator bugs
        const invalid = await ana.post(`/problems/${id}/stress`, {
            generator: "rand", args: "n=5000 seed={seed}", count: 1, solution: "solutions/brute.cpp", group: "small",
        });
        const invalidRun = await finished(harness, ana, invalid.body.id);
        expect(invalidRun.output.invalid[0].message).toContain("N=5000");
    });
});

describe("tenancy and roles", () => {
    let bruno: Client;

    beforeAll(async () => {
        bruno = await login(harness, "Bruno");
    });

    it("hides problems, files and blobs from other workspaces", async () => {
        expect((await bruno.get(`/problems/${problemId}`)).status).toBe(404);
        expect((await bruno.get(`/problems/${problemId}/tree`)).status).toBe(404);
        expect((await bruno.get(`/workspaces/${ana.workspaceId}/problems`)).status).toBe(404);
        // knowing the hash of another tenant's content is not a capability
        const own = await createProblem(bruno, "mine");
        const secret = (await writeFile(ana, problemId, "notes/secret.txt", "only Ana's workspace holds this")).body.hash;
        expect((await ana.get(`/problems/${problemId}/blobs/${secret}`)).status).toBe(200);
        expect((await bruno.get(`/problems/${own}/blobs/${secret}`)).status).toBe(404);
        const refused = await bruno.post(`/problems/${own}/sync`, { changes: [{ path: "stolen.cpp", base: null, hash: secret }] });
        expect(refused.status).toBe(400);
    });

    it("keeps problems private inside a workspace until access is granted", async () => {
        await ana.post(`/workspaces/${ana.workspaceId}/members`, { email: "bruno@dev.local" });
        expect((await bruno.get(`/workspaces/${ana.workspaceId}/problems`)).body).toEqual([]);
        expect((await bruno.get(`/problems/${problemId}`)).status).toBe(404);
        await ana.put(`/problems/${problemId}/access/${bruno.userId}`, { role: "viewer" });
        expect((await bruno.get(`/problems/${problemId}/tree`)).status).toBe(200);
        expect((await writeFile(bruno, problemId, "x.txt", "x")).status).toBe(403);
    });

    it("lets blind testers run their own solutions without seeing the package", async () => {
        await ana.put(`/problems/${problemId}/access/${bruno.userId}`, { role: "tester" });
        expect((await bruno.get(`/problems/${problemId}/tree`)).status).toBe(403);
        expect((await bruno.get(`/problems/${problemId}/revisions`)).status).toBe(403);
        const source = "#include <cstdio>\nint main(){ puts(\"0\"); }\n";
        // nothing is committed yet, so there is nothing a tester may run against
        expect((await bruno.post(`/problems/${problemId}/invocations`, { name: "zero", language: "cpp", source })).status).toBe(409);

        const revision = await ana.post(`/problems/${problemId}/revisions`, { message: "Ready for testing" });
        const authorBuild = await finished(harness, ana, revision.body.buildId);
        expect((await bruno.get(`/builds/${authorBuild.id}`)).status).toBe(404);

        const queued = await bruno.post(`/problems/${problemId}/invocations`, { name: "zero", language: "cpp", source });
        const invocation = await finished(harness, bruno, queued.body.id);
        expect(invocation.output.report.solutions[0].groups.map((group: any) => group.summary)).toEqual(["WA", "WA", "WA"]);
        // per-group outcomes only: no tests, no matrix, no hashes
        expect(invocation.output.tests).toBeUndefined();
        expect(invocation.output.matrix).toBeUndefined();
        expect(JSON.stringify(invocation.output)).not.toMatch(/[0-9a-f]{64}/);
        const statement = await bruno.get(`/problems/${problemId}/statement`);
        expect(statement.body.markdown).toContain("### Sample 1");
        // nothing that shows the package: no source, no archives, no blobs, no previews
        expect(statement.body.path).toBeUndefined();
        expect(statement.body.source).toBeUndefined();
        expect((await bruno.get(`/problems/${problemId}/archive`)).status).toBe(403);
        expect((await bruno.get(`/builds/${authorBuild.id}/tests.zip`)).status).toBe(404);
        expect((await bruno.get(`/builds/${invocation.id}/tests.zip`)).status).toBe(404);
        expect((await bruno.get(`/problems/${problemId}/blobs/${authorBuild.output.tests[0].inputHash}`)).status).toBe(403);
        expect((await bruno.post(`/problems/${problemId}/statement/preview`, { markdown: "{{N.max}}" })).status).toBe(403);
        expect((await bruno.post(`/builds/${authorBuild.id}/cancel`)).status).toBe(404);
        // a tester does get their own compiler output
        const broken = await finished(harness, bruno, (await bruno.post(`/problems/${problemId}/invocations`, { name: "typo", language: "cpp", source: "int main() { return oops; }" })).body.id);
        expect(broken.output.report.issues.map((issue: any) => issue.code)).toEqual(["solution.compile"]);
        expect(broken.output.report.issues[0].message).toContain("oops");
    });

    it("records who did what", async () => {
        const audit = await ana.get(`/workspaces/${ana.workspaceId}/audit`);
        const actions = audit.body.map((entry: any) => entry.action);
        expect(actions).toEqual(expect.arrayContaining(["problem.create", "revision.create", "access.grant", "invocation.run", "set.export"]));
        expect((await bruno.get(`/workspaces/${ana.workspaceId}/audit`)).status).toBe(403);
    });
});

describe("authentication", () => {
    it("requires the CSRF header on cookie-authenticated writes but not with a token", async () => {
        const response = await harness.server.inject({ method: "POST", url: "/api/auth/dev-login", payload: { name: "Csrf" } });
        const cookie = `forge_session=${response.cookies[0]!.value}`;
        const blocked = await harness.server.inject({ method: "POST", url: "/api/tokens", headers: { cookie }, payload: { name: "x" } });
        expect(blocked.statusCode).toBe(403);
        const created = await harness.server.inject({ method: "POST", url: "/api/tokens", headers: { cookie, "x-forge-csrf": "1" }, payload: { name: "cli" } });
        const token = created.json().token as string;
        const me = await harness.server.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
        expect(me.json().user.name).toBe("Csrf");
        const withToken = await harness.server.inject({ method: "POST", url: "/api/workspaces", headers: { authorization: `Bearer ${token}` }, payload: { name: "From CLI" } });
        expect(withToken.statusCode).toBe(200);
        expect((await harness.server.inject({ method: "GET", url: "/api/me", headers: { authorization: "Bearer fpat_wrong" } })).statusCode).toBe(401);
        expect((await harness.server.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    });
});

describe("scheduler", () => {
    it("serves workspaces round-robin and caps each one", async () => {
        const scheduler = new Scheduler(2, 1);
        const order: string[] = [];
        let running = 0;
        let peak = 0;
        const job = (name: string) => async () => {
            running += 1;
            peak = Math.max(peak, running);
            order.push(name);
            await new Promise((resolve) => setTimeout(resolve, 10));
            running -= 1;
        };
        await Promise.all([
            scheduler.submit("a", job("a1")),
            scheduler.submit("a", job("a2")),
            scheduler.submit("a", job("a3")),
            scheduler.submit("b", job("b1")),
            scheduler.submit("b", job("b2")),
        ]);
        expect(peak).toBe(2);
        // workspace b is not stuck behind a's backlog
        expect(order.indexOf("b1")).toBeLessThan(order.indexOf("a2"));
        expect(order.indexOf("b2")).toBeLessThan(order.indexOf("a3"));
    });
});

describe("sign in with kontestis", () => {
    it("runs the authorization code flow and mirrors organisations as workspaces", async () => {
        // a stand-in for the kontestis OAuth provider (kontestis PR #146)
        const provider = createHttpServer((req, res) => {
            const url = new URL(req.url!, "http://provider");
            if (url.pathname === "/token") {
                let body = "";
                req.on("data", (chunk) => (body += chunk));
                req.on("end", () => {
                    const form = new URLSearchParams(body);
                    const basic = Buffer.from((req.headers.authorization ?? "").replace("Basic ", ""), "base64").toString();
                    const ok = basic === "forge:s3cret" && form.get("code") === "good-code" && form.get("redirect_uri") === "http://web.test/api/auth/callback";
                    res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
                    res.end(JSON.stringify(ok ? { access_token: "provider-token", token_type: "Bearer", expires_in: 60 } : { error: "invalid_grant" }));
                });
                return;
            }
            if (url.pathname === "/userinfo" && req.headers.authorization === "Bearer provider-token") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                    JSON.stringify({
                        sub: "4711",
                        name: "Cvita",
                        email: "cvita@example.org",
                        permissions: "0",
                        organisations: [
                            { organisation_id: "7", permissions: "1" },
                            { organisation_id: "9", permissions: "2048" },
                        ],
                        contests: [],
                    }),
                );
                return;
            }
            res.writeHead(401).end();
        });
        await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
        await harness.close();
        harness = await startHarness({
            OAUTH_CLIENT_ID: "forge",
            OAUTH_CLIENT_SECRET: "s3cret",
            OAUTH_AUTHORIZE_URL: "http://kontestis.test/oauth/authorize",
            OAUTH_TOKEN_URL: `${origin}/token`,
            OAUTH_USERINFO_URL: `${origin}/userinfo`,
        });
        try {
            const start = await harness.server.inject({ method: "GET", url: "/api/auth/login?redirect=/p/1/builds" });
            expect(start.statusCode).toBe(302);
            const authorize = new URL(start.headers.location as string);
            expect(authorize.origin + authorize.pathname).toBe("http://kontestis.test/oauth/authorize");
            expect(authorize.searchParams.get("client_id")).toBe("forge");
            expect(authorize.searchParams.get("redirect_uri")).toBe("http://web.test/api/auth/callback");
            const state = authorize.searchParams.get("state")!;
            const stateCookie = `forge_oauth_state=${start.cookies[0]!.value}`;

            // a callback with a state that does not match the browser's cookie is refused
            const forged = await harness.server.inject({ method: "GET", url: "/api/auth/callback?code=good-code&state=forged", headers: { cookie: stateCookie } });
            expect(forged.headers.location).toBe("http://web.test/login?error=invalid_state");
            const badCode = await harness.server.inject({ method: "GET", url: `/api/auth/callback?code=bad&state=${state}`, headers: { cookie: stateCookie } });
            expect(badCode.headers.location).toBe("http://web.test/login?error=token_exchange_failed");

            const callback = await harness.server.inject({ method: "GET", url: `/api/auth/callback?code=good-code&state=${state}`, headers: { cookie: stateCookie } });
            expect(callback.headers.location).toBe("http://web.test/p/1/builds");
            const session = callback.cookies.find((cookie) => cookie.name === "forge_session")!;
            const me = await harness.server.inject({ method: "GET", url: "/api/me", headers: { cookie: `forge_session=${session.value}` } });
            expect(me.json().user).toMatchObject({ name: "Cvita", email: "cvita@example.org" });
            const workspaces = me.json().workspaces.map((workspace: any) => [workspace.kontestisOrgId, workspace.role]);
            // organisation admins own the mirrored workspace; other members are plain members
            expect(workspaces).toEqual([[null, "owner"], ["7", "owner"], ["9", "member"]]);

            // open redirects are not followed
            const evil = await harness.server.inject({ method: "GET", url: "/api/auth/login?redirect=//evil.example" });
            const evilState = new URL(evil.headers.location as string).searchParams.get("state")!;
            const evilCallback = await harness.server.inject({ method: "GET", url: `/api/auth/callback?code=good-code&state=${evilState}`, headers: { cookie: `forge_oauth_state=${evil.cookies[0]!.value}` } });
            expect(evilCallback.headers.location).toBe("http://web.test/");
        } finally {
            provider.close();
        }
    });
});
