import { describe, expect, it } from "vitest";

import {
    buildReport,
    judge,
    Matrix,
    meetsExpectation,
    parseManifest,
    planBuild,
    renderStatement,
    TEMPLATE_FORMATS,
    templateFiles,
    TestResult,
    withPrelude,
} from "../src";

const plan = (yaml: string, files: string[]) => {
    const parsed = parseManifest(yaml);
    if (!parsed.manifest) throw new Error(parsed.issues.map((issue) => issue.message).join("; "));
    return planBuild(parsed.manifest, ["problem.yaml", ...files]);
};

const BASE = `
name: demo
limits: { time_ms: 1000, memory_mb: 256 }
constraints: { N: { min: 1, max: 100000 } }
validator: validator.py
generators: { rand: gen.py }
groups:
  - name: small
    points: 30
    constraints: { N: { max: 100 } }
    tests:
      - { gen: rand, args: "seed={i}", count: 2 }
  - name: full
    points: 70
    depends: [small]
    tests:
      - { gen: rand, args: "big" }
solutions:
  - { path: main.cpp, role: main }
  - { path: slow.py, expect: { small: AC, full: TLE } }
`;
const FILES = ["validator.py", "gen.py", "main.cpp", "slow.py"];

describe("manifest", () => {
    it("rejects malformed manifests with readable issues", () => {
        expect(parseManifest("name: [").manifest).toBeUndefined();
        const parsed = parseManifest("name: Bad Name\nlimits: { time_ms: 1000, memory_mb: 256 }\ngroups: []");
        expect(parsed.manifest).toBeUndefined();
        expect(parsed.issues.map((issue) => issue.message).join("\n")).toMatch(/name/);
    });

    it("expands counted tests and merges group constraints", () => {
        const { plan: built, issues } = plan(BASE, FILES);
        expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
        expect(built.tests.map((test) => test.id)).toEqual(["small/1", "small/2", "full/1"]);
        expect(built.tests[1]!.source).toMatchObject({ kind: "gen", args: "seed=2" });
        expect(built.groups[0]!.constraints).toEqual({ N: { min: 1, max: 100 } });
        expect(built.groups[1]!.constraints).toEqual({ N: { min: 1, max: 100000 } });
    });

    it("includes the tests of dependencies in a group's closure", () => {
        const { plan: built } = plan(BASE, FILES);
        expect(built.groups[1]!.closure).toEqual(["small/1", "small/2", "full/1"]);
    });

    it("reports missing files, unknown generators and dependency cycles", () => {
        const codes = (yaml: string, files = FILES) => plan(yaml, files).issues.map((issue) => issue.code);
        expect(codes(BASE, ["gen.py", "main.cpp", "slow.py"])).toContain("file.missing");
        expect(codes(BASE.replace("gen: rand, args: \"big\"", "gen: nope, args: \"big\""))).toContain("generator.unknown");
        expect(codes(BASE.replace("points: 30", "points: 30\n    depends: [full]"))).toContain("group.cycle");
        expect(codes(BASE.replace("role: main", "expect: AC"))).toContain("solution.no-main");
        expect(codes(BASE.replace("seed={i}", "seed=1"))).toContain("test.count");
    });

    it("marks task types the current runner cannot execute", () => {
        const { plan: built, issues } = plan(BASE.replace("name: demo", "name: demo\ntype: communication"), FILES);
        expect(built.runnable).toBe(false);
        expect(issues.map((issue) => issue.code)).toContain("type.not-runnable");
    });

    it("accepts a directory of outputs as a solution of an output-only task", () => {
        const files = templateFiles("output-only", "demo", "Demo");
        const manifest = parseManifest(files["problem.yaml"]!).manifest!;
        const { plan: built, issues } = planBuild(manifest, Object.keys(files));
        expect(built.runnable).toBe(true);
        expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
        const greedy = built.solutions.find((solution) => solution.path === "solutions/greedy")!;
        expect(greedy.language).toBeUndefined();
        expect(greedy.outputs).toEqual({
            "samples/1": "solutions/greedy/samples/1.out",
            "tests/1": "solutions/greedy/tests/1.out",
            "tests/2": "solutions/greedy/tests/2.out",
        });
        expect(Object.keys(built.solutions.find((solution) => solution.path === "solutions/unfinished")!.outputs!)).toHaveLength(2);

        // a main solution made of outputs must cover every test; stray files are pointed out
        const asMain = planBuild(
            parseManifest(files["problem.yaml"]!.replace("{ path: solutions/main.py, role: main }", "{ path: solutions/unfinished, role: main }").replace(/\n  - \{ path: solutions\/unfinished, expect.*\n/, "\n"))
                .manifest!,
            [...Object.keys(files), "solutions/unfinished/notes.txt"],
        ).issues.map((issue) => issue.code);
        expect(asMain).toContain("solution.main-output");
        expect(asMain).toContain("solution.stray-output");

        // directories are only solutions in output-only tasks
        const batch = planBuild(parseManifest(files["problem.yaml"]!.replace("type: output-only", "type: batch")).manifest!, Object.keys(files));
        expect(batch.issues.map((issue) => issue.code)).toContain("file.missing");
    });

    it("warns about what kontestis cannot score when the problem is meant for it", () => {
        const files = templateFiles("ioi", "demo", "Demo");
        const text = files["problem.yaml"]!;
        const codes = (manifest: string) => planBuild(parseManifest(manifest).manifest!, Object.keys(files)).issues.filter((issue) => issue.code === "kontestis.incompatible");
        expect(codes(text)).toEqual([]);
        const targeted = codes(text.replace("type: batch", "type: batch\njudge: kontestis"));
        // the IOI template makes "full" depend on "small"
        expect(targeted).toHaveLength(1);
        expect(targeted[0]!.message).toContain("depends on other groups");
        expect(codes(text.replace("type: batch", "type: batch\njudge: kontestis\nscoring: { mode: binary }")).length).toBe(2);
    });

    it("accepts built-in checkers and hand-written answers", () => {
        const files = templateFiles("ioi", "demo", "Demo");
        const manifest = files["problem.yaml"]!
            .replace("validator: validator.py", "validator: validator.py\nchecker: { builtin: float, eps: 0.001 }")
            .replace("- manual: tests/sample1.in", "- { manual: tests/sample1.in, answer: tests/sample1.ans, desc: from the statement }");
        const parsed = parseManifest(manifest);
        expect(parsed.issues).toEqual([]);
        const missing = planBuild(parsed.manifest!, Object.keys(files));
        expect(missing.issues.map((issue) => issue.code)).toContain("file.missing");
        const { plan: built, issues } = planBuild(parsed.manifest!, [...Object.keys(files), "tests/sample1.ans"]);
        expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
        expect(built.builtinChecker).toEqual({ kind: "float", eps: 0.001 });
        expect(built.tests[0]).toMatchObject({ answer: "tests/sample1.ans", desc: "from the statement" });
    });

    it("warns when a tool's language cannot receive the constraint constants", () => {
        const files = templateFiles("ioi", "demo", "Demo");
        const manifest = parseManifest(files["problem.yaml"]!.replace("validator: validator.py", "validator: validator.java")).manifest!;
        const { issues } = planBuild(manifest, [...Object.keys(files), "validator.java"]);
        const warning = issues.find((issue) => issue.code === "prelude.unsupported");
        expect(warning?.ref).toBe("validator.java");
    });

    it("ships templates that plan without errors", () => {
        for (const format of TEMPLATE_FORMATS) {
            const files = templateFiles(format, "demo", "Demo");
            const parsed = parseManifest(files["problem.yaml"]!);
            expect(parsed.issues).toEqual([]);
            const { issues } = planBuild(parsed.manifest!, Object.keys(files));
            const errors = issues.filter((issue) => issue.severity === "error").map((issue) => issue.code);
            // the empty template is a skeleton: it has no solution yet, and says so
            expect(errors).toEqual(format === "empty" ? ["solution.no-main"] : []);
        }
    });
});

describe("prelude", () => {
    it("injects constraints as constants and keeps line numbers", () => {
        const cpp = withPrelude("int main(){}", "cpp", { N: { min: 1, max: 5 } }, "small");
        expect(cpp).toContain("static const long long N_MAX = 5LL;");
        expect(cpp).toContain('FORGE_GROUP[] = "small"');
        expect(cpp.split("\n").at(-2)).toBe("#line 1");
        const python = withPrelude("print(N_MAX)", "python", { N: { max: 5 } });
        expect(python.startsWith("N_MAX = 5\n")).toBe(true);
    });
});

describe("verdicts", () => {
    const raw = (status: string, timeMs = 10, data?: string) => ({ status, timeMs, memoryKb: 1, data }) as never;

    it("applies the time limit to measured runs", () => {
        expect(judge(raw("accepted", 900), 1000).verdict).toBe("AC");
        // the program finished under the measurement limit but over the real limit
        expect(judge(raw("accepted", 1500), 1000).verdict).toBe("TLE");
        expect(judge(raw("wrong_answer"), 1000).verdict).toBe("WA");
    });

    it("turns checker scores into AC, PA and WA", () => {
        expect(judge(raw("custom", 10, "1"), 1000)).toMatchObject({ verdict: "AC", score: 1 });
        expect(judge(raw("custom", 10, "0.5"), 1000)).toMatchObject({ verdict: "PA", score: 0.5 });
        expect(judge(raw("custom", 10, "0"), 1000)).toMatchObject({ verdict: "WA", score: 0 });
        expect(judge(raw("custom", 10, "seven"), 1000).verdict).toBe("JE");
    });

    it("checks expectations the way Polygon tags do", () => {
        expect(meetsExpectation("AC", ["AC", "AC"])).toBe(true);
        expect(meetsExpectation("AC", ["AC", "WA"])).toBe(false);
        expect(meetsExpectation("TLE", ["AC", "TLE"])).toBe(true);
        expect(meetsExpectation("TLE", ["AC", "AC"])).toBe(false);
        expect(meetsExpectation("TLE", ["TLE", "WA"])).toBe(false);
        expect(meetsExpectation("TLE|WA", ["TLE", "WA"])).toBe(true);
        expect(meetsExpectation("FAIL", ["RE"])).toBe(true);
        expect(meetsExpectation("FAIL", ["CE"])).toBe(false);
    });
});

describe("report", () => {
    const result = (verdict: string, timeMs = 100): TestResult =>
        ({ verdict, score: verdict === "AC" ? 1 : 0, timeMs, memoryKb: 1 }) as TestResult;
    const { plan: built } = plan(BASE, FILES);

    it("scores groups, applies dependencies and checks expectations", () => {
        const matrix: Matrix = {
            "main.cpp": { "small/1": result("AC"), "small/2": result("AC"), "full/1": result("AC", 400) },
            "slow.py": { "small/1": result("AC"), "small/2": result("AC"), "full/1": result("TLE", 3000) },
        };
        const report = buildReport(built, matrix);
        expect(report.status).toBe("green");
        expect(report.solutions.map((solution) => solution.score)).toEqual([100, 30]);
        expect(report.calibration).toMatchObject({ slowestAcceptedMs: 400, fastestRejectedMs: 3000, headroom: 2.5, separation: 3 });
        expect(report.kills).toEqual([{ solution: "slow.py", killedBy: ["full/1"] }]);
        expect(report.decisiveTests).toEqual(["full/1"]);
        expect(report.issues.map((issue) => issue.code)).toContain("tests.fragile");
    });

    it("goes red when a solution does not behave as declared", () => {
        const matrix: Matrix = {
            "main.cpp": { "small/1": result("AC"), "small/2": result("WA"), "full/1": result("AC") },
            "slow.py": { "small/1": result("AC"), "small/2": result("AC"), "full/1": result("AC") },
        };
        const report = buildReport(built, matrix);
        expect(report.status).toBe("red");
        expect(report.issues.filter((issue) => issue.code === "expectation.unmet")).toHaveLength(3);
        // "full" depends on "small", which main.cpp did not fully solve
        expect(report.solutions[0]!.score).toBe(0);
    });

    it("warns when the time limit is too close to the slowest accepted run", () => {
        const matrix: Matrix = {
            "main.cpp": { "small/1": result("AC"), "small/2": result("AC"), "full/1": result("AC", 800) },
            "slow.py": { "small/1": result("AC"), "small/2": result("AC"), "full/1": result("TLE", 1100) },
        };
        const codes = buildReport(built, matrix).issues.map((issue) => issue.code);
        expect(codes).toContain("limits.tight");
        expect(codes).toContain("limits.thin-margin");
    });

    it("ignores wall-clock timeouts when measuring how slow the slow solutions are", () => {
        const matrix: Matrix = {
            "main.cpp": { "small/1": result("AC"), "small/2": result("AC"), "full/1": result("AC", 400) },
            // blocked on input: killed after the wall-clock limit with 17 ms of CPU time
            "slow.py": { "small/1": result("AC"), "small/2": result("AC"), "full/1": result("TLE", 17) },
        };
        const report = buildReport(built, matrix);
        expect(report.calibration.fastestRejectedMs).toBeUndefined();
        expect(report.issues.map((issue) => issue.code)).not.toContain("limits.thin-margin");
    });

    it("supports ICPC style binary scoring", () => {
        const binary = plan(BASE.replace("name: demo", "name: demo\nscoring: { mode: binary }"), FILES).plan;
        const matrix: Matrix = { "main.cpp": { "small/1": result("AC"), "small/2": result("AC"), "full/1": result("AC") } };
        expect(buildReport(binary, matrix).solutions[0]).toMatchObject({ score: 1, maxScore: 1 });
    });
});

describe("statement placeholders", () => {
    const manifest = parseManifest(templateFiles("ioi", "demo", "Demo")["problem.yaml"]!).manifest!;
    it("flags a sample that does not exist once the list of samples is complete", () => {
        const one = [{ input: "1", output: "2" }];
        expect(renderStatement("{{sample.1}} {{sample.2}}", manifest, {}, one, { strictSamples: true }).unresolved).toEqual(["sample.2"]);
        expect(renderStatement("{{sample.1}}", manifest, {}, [], { strictSamples: true }).unresolved).toEqual(["sample.1"]);
        // before a build there are no samples yet, which is not an error
        expect(renderStatement("{{sample.1}}", manifest, {}, []).unresolved).toEqual([]);
    });
    it("leaves escaped braces alone", () => {
        const rendered = renderStatement("$2^\\{{N}}$ and {{N.max}}", manifest, {}, []);
        expect(rendered.unresolved).toEqual([]);
        expect(rendered.markdown).toContain("$2^{{N}}$");
    });
});

describe("statement", () => {
    it("fills constraints, limits and samples from the package", () => {
        const { plan: built } = plan(BASE, FILES);
        const constraints = Object.fromEntries(built.groups.map((group) => [group.name, group.constraints]));
        const rendered = renderStatement(
            "N <= {{N.max}} ({{N.max|raw}}), small: {{group.small.N.max}}, {{limits.time}}, {{limits.memory}}, {{M.max}}",
            built.manifest,
            constraints,
            [{ input: "1\n", output: "2\n" }],
        );
        expect(rendered.markdown).toContain("N <= 10^{5} (100000), small: 100, 1 s, 256 MB");
        expect(rendered.unresolved).toEqual(["M.max"]);
        expect(rendered.markdown).toContain("### Sample 1");
    });
});
