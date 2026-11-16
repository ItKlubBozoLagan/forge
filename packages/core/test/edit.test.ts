import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
    addGroup,
    addSolution,
    addTest,
    ManifestEditError,
    moveGroup,
    moveTest,
    parseManifest,
    planBuild,
    readManifestDraft,
    refersTo,
    removeConstraint,
    removeGenerator,
    removeGroup,
    removeReferences,
    removeSolution,
    removeTest,
    renameConstraint,
    renameGenerator,
    renameReferences,
    setChecker,
    setConstraint,
    setExpectation,
    setGenerator,
    setLimits,
    setMainSolution,
    setScoringMode,
    setTitle,
    setType,
    setValidator,
    templateFiles,
    TEMPLATE_FORMATS,
    updateGroup,
    updateSolution,
    updateTest,
} from "../src";

const IOI = templateFiles("ioi", "pair-sum", "Pair Sum")["problem.yaml"]!;

const valid = (text: string) => {
    const parsed = parseManifest(text);
    if (!parsed.manifest) throw new Error(parsed.issues.map((issue) => issue.message).join("; "));
    return parsed.manifest;
};

const data = (text: string) => parse(text) as Record<string, any>;

describe("manifest edits", () => {
    it("keeps comments and untouched formatting", () => {
        const next = setLimits(IOI, { time_ms: 2000 });
        expect(next).toContain("limits: { time_ms: 2000, memory_mb: 256 }");
        expect(next).toContain('# IOI style: subtasks score all-or-nothing (aggregate: min) and "full" also requires "small".');
        expect(next).toContain('      - { gen: rand, args: "n=1000 seed={i}", count: 3 }');
        expect(next).toContain("  - { path: solutions/brute.cpp, expect: { samples: AC, small: AC, full: TLE } }");
        // only the one line differs
        const before = IOI.split("\n");
        const after = next.split("\n");
        expect(after.length).toBe(before.length);
        expect(after.filter((line, index) => line !== before[index])).toEqual([
            "limits: { time_ms: 2000, memory_mb: 256 }",
        ]);
        valid(next);
    });

    it("returns the text unchanged when nothing changes", () => {
        expect(setLimits(IOI, { time_ms: 1000 })).toBe(IOI);
        expect(renameReferences(IOI, "nothing.py", "other.py")).toBe(IOI);
        for (const format of TEMPLATE_FORMATS) {
            const text = templateFiles(format, "x", "X")["problem.yaml"]!;
            expect(removeReferences(text, "not-there.txt")).toBe(text);
        }
    });

    it("sets general fields", () => {
        let text = setTitle(IOI, "Pairs");
        text = setType(text, "output-only");
        text = setScoringMode(text, "binary");
        const manifest = valid(text);
        expect(manifest.title).toBe("Pairs");
        expect(manifest.type).toBe("output-only");
        expect(manifest.scoring.mode).toBe("binary");
        // scoring is added next to limits, not at the end
        expect(text.indexOf("scoring:")).toBeLessThan(text.indexOf("constraints:"));
        expect(setTitle("name: x\ntitle: { en: A, hr: B }\n", "C")).toContain("title: { en: C, hr: B }");
    });

    it("sets and clears the validator and checker", () => {
        let text = setValidator(IOI, undefined);
        expect(data(text).validator).toBeUndefined();
        text = setValidator(text, "check/validator.cpp");
        expect(data(text).validator).toBe("check/validator.cpp");
        expect(text.indexOf("validator:")).toBeLessThan(text.indexOf("generators:"));

        text = setChecker(text, "checker.py");
        expect(data(text).checker).toBe("checker.py");
        expect(text.indexOf("checker:")).toBeGreaterThan(text.indexOf("validator:"));
        text = setChecker(text, { builtin: "float", eps: 1e-6 });
        expect(data(text).checker).toEqual({ builtin: "float", eps: 1e-6 });
        expect(text).toContain("checker: { builtin: float, eps: 0.000001 }");
        text = setChecker(text, { builtin: "yesno" });
        expect(data(text).checker).toEqual({ builtin: "yesno" });
        valid(text);
        text = setChecker(text, undefined);
        expect("checker" in data(text)).toBe(false);
    });

    it("edits constraints globally and per group", () => {
        let text = setConstraint(IOI, "Q", { min: 1, max: 10 });
        expect(data(text).constraints.Q).toEqual({ min: 1, max: 10 });
        expect(text).toContain("  Q: { min: 1, max: 10 }");
        text = setConstraint(text, "N", { min: 2, max: 500 });
        expect(text).toContain("  N: { min: 2, max: 500 }");
        text = setConstraint(text, "N", { max: 500 });
        expect(data(text).constraints.N).toEqual({ max: 500 });

        text = setConstraint(text, "A", { max: 9 }, "small");
        expect(text).toContain("constraints: { N: { max: 1000 }, A: { max: 9 } }");
        text = setConstraint(text, "A", { max: 9 }, "full");
        expect(data(text).groups[2].constraints).toEqual({ A: { max: 9 } });
        text = removeConstraint(text, "A", "full");
        expect("constraints" in data(text).groups[2]).toBe(false);

        text = renameConstraint(text, "N", "M");
        expect(data(text).constraints.M).toEqual({ max: 500 });
        expect(data(text).groups[1].constraints.M).toEqual({ max: 1000 });
        text = removeConstraint(text, "Q");
        expect(data(text).constraints.Q).toBeUndefined();
        valid(text);
    });

    it("edits generators", () => {
        let text = setGenerator(IOI, "line", "generators/line.cpp");
        expect(data(text).generators).toEqual({ rand: "generators/rand.py", line: "generators/line.cpp" });
        text = renameGenerator(text, "rand", "random");
        expect(data(text).generators.random).toBe("generators/rand.py");
        expect(data(text).groups[1].tests[0].gen).toBe("random");
        text = removeGenerator(text, "line");
        expect(data(text).generators).toEqual({ random: "generators/rand.py" });
        expect(() => renameGenerator(text, "nope", "x")).toThrow(ManifestEditError);
        valid(text);
    });

    it("adds, updates, moves and removes groups", () => {
        let text = addGroup(IOI, { name: "medium", points: 20, depends: ["small"] }, 2);
        let manifest = valid(text);
        expect(manifest.groups.map((group) => group.name)).toEqual(["samples", "small", "medium", "full"]);
        expect(manifest.groups[2]).toMatchObject({ points: 20, depends: ["small"], tests: [] });

        text = updateGroup(text, "small", { name: "tiny", points: 25, sample: true, aggregate: "sum" });
        manifest = valid(text);
        expect(manifest.groups[1]).toMatchObject({ name: "tiny", points: 25, sample: true, aggregate: "sum" });
        // the rename follows into depends and expectations
        expect(manifest.groups[2]!.depends).toEqual(["tiny"]);
        expect(manifest.groups[3]!.depends).toEqual(["tiny"]);
        expect(manifest.solutions[1]!.expect).toEqual({ samples: "AC", tiny: "AC", full: "TLE" });

        text = updateGroup(text, "tiny", { sample: false, points: undefined });
        expect(data(text).groups[1]).not.toHaveProperty("sample");
        expect(data(text).groups[1]).not.toHaveProperty("points");

        text = moveGroup(text, "medium", 0);
        expect(valid(text).groups.map((group) => group.name)).toEqual(["medium", "samples", "tiny", "full"]);

        text = removeGroup(text, "tiny");
        manifest = valid(text);
        expect(manifest.groups.map((group) => group.name)).toEqual(["medium", "samples", "full"]);
        expect(data(text).groups[0]).not.toHaveProperty("depends");
        expect(manifest.solutions[1]!.expect).toEqual({ samples: "AC", full: "TLE" });
        expect(() => addGroup(text, { name: "full" })).toThrow(/already exists/);
    });

    it("adds, updates, moves and removes tests", () => {
        let text = addTest(IOI, "small", { gen: "rand", args: "n=7 seed={i}", count: 2, desc: "tiny" });
        expect(text).toContain('      - { gen: rand, args: "n=7 seed={i}", count: 2, desc: tiny }');
        text = addTest(text, "samples", { manual: "tests/sample2.in", answer: "tests/sample2.out" });
        expect(text).toContain("      - manual: tests/sample2.in\n        answer: tests/sample2.out\n");

        let tests = data(text).groups[1].tests;
        expect(tests).toHaveLength(3);
        const plan = planBuild(valid(text), [
            "problem.yaml",
            "validator.py",
            "generators/rand.py",
            "tests/sample1.in",
            "tests/sample2.in",
            "solutions/main.cpp",
            "solutions/brute.cpp",
            "solutions/overflow.cpp",
        ]).plan;
        expect(plan.groups.find((group) => group.name === "small")!.tests).toEqual([
            "small/1",
            "small/2",
            "small/3",
            "small/4",
            "small/5",
            "small/6",
        ]);

        text = updateTest(text, "small", 2, { gen: "rand", args: "n=8 seed={i}", count: 2 });
        expect(data(text).groups[1].tests[2]).toEqual({ gen: "rand", args: "n=8 seed={i}", count: 2 });
        // switching kinds drops the other kind's keys
        text = updateTest(text, "small", 2, { manual: "tests/hand.in", desc: "by hand" });
        expect(data(text).groups[1].tests[2]).toEqual({ manual: "tests/hand.in", desc: "by hand" });

        text = moveTest(text, "small", 2, 0);
        tests = data(text).groups[1].tests;
        expect(tests[0]).toEqual({ manual: "tests/hand.in", desc: "by hand" });
        expect(tests[1].args).toBe("n=1000 seed={i}");

        text = removeTest(text, "small", 0);
        expect(data(text).groups[1].tests).toHaveLength(2);
        valid(text);
    });

    it("keeps keys of a test that it does not know about", () => {
        const text = "name: x\nlimits: { time_ms: 1000, memory_mb: 256 }\ngroups:\n  - name: a\n    tests:\n      - { gen: g, args: a, weight: 3 }\n";
        const next = updateTest(text, "a", 0, { gen: "g", args: "b" });
        expect(data(next).groups[0].tests[0]).toEqual({ gen: "g", args: "b", weight: 3 });
    });

    it("edits solutions and expectations", () => {
        let text = addSolution(IOI, { path: "solutions/slow.py", expect: "TLE" });
        expect(text).toContain("  - { path: solutions/slow.py, expect: TLE }");
        text = setExpectation(text, "solutions/slow.py", "samples", "AC");
        expect(data(text).solutions[3].expect).toEqual({ samples: "AC", small: "TLE", full: "TLE" });
        text = setExpectation(text, "solutions/slow.py", "small", "WA|TLE");
        text = setExpectation(text, "solutions/slow.py", "full", undefined);
        expect(data(text).solutions[3].expect).toEqual({ samples: "AC", small: "WA|TLE" });
        // a solution with no expectation is AC everywhere: setting one cell keeps the others AC
        text = addSolution(text, { path: "solutions/ok.cpp" });
        text = setExpectation(text, "solutions/ok.cpp", "full", "TLE");
        expect(data(text).solutions[4].expect).toEqual({ samples: "AC", small: "AC", full: "TLE" });

        text = setMainSolution(text, "solutions/ok.cpp");
        expect(data(text).solutions[0]).not.toHaveProperty("role");
        expect(data(text).solutions[4]).toEqual({ path: "solutions/ok.cpp", role: "main" });

        text = updateSolution(text, "solutions/main.cpp", { expect: "WA" });
        expect(data(text).solutions[0].expect).toBe("WA");
        text = updateSolution(text, "solutions/main.cpp", { expect: { full: "TLE" } });
        expect(data(text).solutions[0].expect).toEqual({ full: "TLE" });
        text = removeSolution(text, "solutions/slow.py");
        expect(data(text).solutions.map((s: { path: string }) => s.path)).toEqual([
            "solutions/main.cpp",
            "solutions/brute.cpp",
            "solutions/overflow.cpp",
            "solutions/ok.cpp",
        ]);
        valid(text);
        expect(() => addSolution(text, { path: "solutions/ok.cpp" })).toThrow(/already/);
    });
});

describe("file references", () => {
    const MANIFEST = `# a comment that must survive
name: refs
limits: { time_ms: 1000, memory_mb: 256 }
validator: check/validator.py
checker: check/checker.py
generators:
  rand: gen/rand.py  # random
groups:
  - name: samples
    tests:
      - manual: tests/1.in
      - { manual: tests/2.in, answer: tests/2.ans }
  - name: main
    tests:
      - { gen: rand, args: "seed={i}", count: 2 }
solutions:
  - { path: solutions/main.cpp, role: main }
  - { path: solutions/greedy/, expect: WA }
statements:
  en: statement/en.md
`;

    it("renames a file everywhere it is named", () => {
        let text = renameReferences(MANIFEST, "tests/1.in", "tests/sample.in");
        expect(text).toContain("      - manual: tests/sample.in\n");
        text = renameReferences(text, "tests/2.ans", "tests/2.out");
        expect(text).toContain("{ manual: tests/2.in, answer: tests/2.out }");
        text = renameReferences(text, "solutions/main.cpp", "solutions/best.cpp");
        expect(text).toContain("{ path: solutions/best.cpp, role: main }");
        text = renameReferences(text, "statement/en.md", "statement/english.md");
        expect(data(text).statements.en).toBe("statement/english.md");
        text = renameReferences(text, "gen/rand.py", "gen/random.py");
        expect(text).toContain("  rand: gen/random.py # random");
        expect(text.startsWith("# a comment that must survive\n")).toBe(true);
        valid(text);
    });

    it("renames a directory prefix", () => {
        let text = renameReferences(MANIFEST, "check", "programs");
        expect(data(text).validator).toBe("programs/validator.py");
        expect(data(text).checker).toBe("programs/checker.py");
        text = renameReferences(text, "tests/", "cases/");
        expect(data(text).groups[0].tests).toEqual([
            { manual: "cases/1.in" },
            { manual: "cases/2.in", answer: "cases/2.ans" },
        ]);
        text = renameReferences(text, "solutions/greedy", "solutions/greedy-outputs");
        expect(data(text).solutions[1].path).toBe("solutions/greedy-outputs/");
        // a prefix only matches whole path segments
        expect(renameReferences(MANIFEST, "test", "x")).toBe(MANIFEST);
    });

    it("keeps a built-in checker when renaming", () => {
        const text = setChecker(MANIFEST, { builtin: "lines" });
        expect(renameReferences(text, "check", "programs")).toContain("checker: { builtin: lines }");
        expect(removeReferences(text, "check")).toContain("checker: { builtin: lines }");
    });

    it("removes references to a deleted file", () => {
        expect(refersTo(MANIFEST, "tests/1.in")).toBe(true);
        expect(refersTo(MANIFEST, "tests/3.in")).toBe(false);
        let text = removeReferences(MANIFEST, "tests/1.in");
        expect(data(text).groups[0].tests).toEqual([{ manual: "tests/2.in", answer: "tests/2.ans" }]);
        text = removeReferences(text, "tests/2.ans");
        expect(data(text).groups[0].tests).toEqual([{ manual: "tests/2.in" }]);
        text = removeReferences(text, "check/checker.py");
        expect("checker" in data(text)).toBe(false);
        expect(data(text).validator).toBe("check/validator.py");
        text = removeReferences(text, "gen/rand.py");
        expect(data(text).generators).toEqual({});
        expect(data(text).groups[1].tests).toEqual([]);
        text = removeReferences(text, "solutions/greedy");
        expect(data(text).solutions).toEqual([{ path: "solutions/main.cpp", role: "main" }]);
        expect(text.startsWith("# a comment that must survive\n")).toBe(true);
        valid(text);
    });

    it("removes everything under a deleted directory", () => {
        const text = removeReferences(MANIFEST, "tests");
        expect(data(text).groups[0].tests).toEqual([]);
        valid(text);
    });
});

describe("readManifestDraft", () => {
    it("reads every template", () => {
        for (const format of TEMPLATE_FORMATS) {
            const text = templateFiles(format, "x", "X")["problem.yaml"]!;
            const result = readManifestDraft(text);
            expect(result.problems).toEqual([]);
            expect(result.draft!.groups.length).toBeGreaterThan(0);
        }
    });

    it("reads values that the schema would reject", () => {
        const result = readManifestDraft("name: x\nlimits: { time_ms: 10 }\ngroups:\n  - name: a\n    points: lots\n");
        expect(result.draft?.limits.time_ms).toBe(10);
        expect(result.draft?.groups[0]).toMatchObject({ name: "a", points: undefined, tests: [] });
    });

    it("refuses shapes a form cannot show", () => {
        expect(readManifestDraft("groups: [").draft).toBeUndefined();
        expect(readManifestDraft("groups: 3").problems).toEqual(["groups must be a list of mappings"]);
        expect(readManifestDraft("- a").problems).toEqual(["problem.yaml must be a mapping"]);
    });

    it("refuses to edit text that is not YAML", () => {
        expect(() => setTitle("groups: [", "x")).toThrow(ManifestEditError);
    });
});
