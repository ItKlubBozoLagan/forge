import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { Language, languageOf } from "./languages";
import { PRELUDE_LANGUAGES } from "./prelude";

const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "must be an identifier");
const GroupName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "letters, digits, - and _ only");
const FilePath = z
    .string()
    .min(1)
    .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "must be a relative path");

const Bound = z.object({ min: z.number().optional(), max: z.number().optional() }).strict();
export type Bound = z.infer<typeof Bound>;
const Constraints = z.record(Identifier, Bound);
export type Constraints = z.infer<typeof Constraints>;

export const TASK_TYPES = ["batch", "interactive", "output-only", "communication", "grader"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
/** Task types the current runner protocol can execute. The rest can be described but not built. */
export const RUNNABLE_TASK_TYPES: readonly TaskType[] = ["batch", "interactive", "output-only", "communication", "grader"];
/** Languages a grader can be written in: the solution and the grader become one source file. */
export const GRADER_LANGUAGES = ["c", "cpp", "python"] as const;

const TestSpec = z.union([
    z
        .object({
            manual: FilePath,
            /** A hand-written answer file; without it the main solution produces the answer. */
            answer: FilePath.optional(),
            desc: z.string().max(200).optional(),
        })
        .strict(),
    z
        .object({
            gen: Identifier,
            args: z.string().default(""),
            count: z.number().int().min(1).max(1000).optional(),
            desc: z.string().max(200).optional(),
        })
        .strict(),
]);

export const BUILTIN_CHECKERS = ["tokens", "lines", "float", "yesno"] as const;
export type BuiltinChecker = (typeof BUILTIN_CHECKERS)[number];
const Checker = z.union([
    FilePath,
    z
        .object({
            builtin: z.enum(BUILTIN_CHECKERS),
            /** `float` only: largest absolute or relative error accepted. */
            eps: z.number().positive().max(1).optional(),
        })
        .strict(),
]);

const Group = z
    .object({
        name: GroupName,
        points: z.number().min(0).default(0),
        aggregate: z.enum(["min", "sum"]).default("min"),
        sample: z.boolean().default(false),
        depends: z.array(GroupName).default([]),
        constraints: Constraints.default({}),
        tests: z.array(TestSpec).default([]),
    })
    .strict();

export const EXPECTABLE = ["AC", "WA", "TLE", "MLE", "RE", "PA", "FAIL"] as const;
const Expectation = z.string().refine(
    (value) => {
        const parts = value.split("|").map((p) => p.trim());
        if (parts.length === 0) return false;
        if (parts.includes("AC") && parts.length > 1) return false;
        return parts.every((p) => (EXPECTABLE as readonly string[]).includes(p));
    },
    { message: `expected AC, or one or more of WA, TLE, MLE, RE, PA, FAIL separated by "|"` },
);

const Solution = z
    .object({
        path: FilePath,
        role: z.enum(["main"]).optional(),
        expect: z.union([Expectation, z.record(GroupName, Expectation)]).optional(),
    })
    .strict();

export const ManifestSchema = z
    .object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and -"),
        title: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
        type: z.enum(TASK_TYPES).default("batch"),
        limits: z
            .object({
                time_ms: z.number().int().min(50).max(60_000),
                memory_mb: z.number().int().min(16).max(4096),
            })
            .strict(),
        scoring: z
            .object({ mode: z.enum(["sum", "binary"]).default("sum") })
            .strict()
            .default({ mode: "sum" }),
        constraints: Constraints.default({}),
        validator: FilePath.optional(),
        checker: Checker.optional(),
        /**
         * `type: grader`: the contestant implements functions and the grader holds `main`. One
         * grader per language; `headers` are the files solutions and graders `#include`.
         */
        grader: z
            .object({
                c: FilePath.optional(),
                cpp: FilePath.optional(),
                python: FilePath.optional(),
                headers: z.array(FilePath).default([]),
            })
            .strict()
            .optional(),
        /**
         * `type: communication`: the solution runs twice; the manager turns the test and the
         * first run's output into the second run's input.
         */
        manager: FilePath.optional(),
        /**
         * `type: communication` only. `simultaneous: true` runs `processes` instances of the
         * solution at once, talking only through the manager, instead of two runs in turn.
         */
        communication: z
            .object({
                simultaneous: z.boolean().default(false),
                processes: z.number().int().min(1).max(4).default(2),
            })
            .strict()
            .optional(),
        /** Judge the problem is meant for; turns on warnings about what that judge cannot score. */
        judge: z.enum(["kontestis"]).optional(),
        generators: z.record(Identifier, FilePath).default({}),
        groups: z.array(Group).min(1),
        solutions: z.array(Solution).default([]),
        statements: z.record(z.string(), FilePath).optional(),
    })
    .strict();

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestGroup = Manifest["groups"][number];

export type Issue = {
    severity: "error" | "warning";
    code: string;
    message: string;
    /** File path, group, test or solution the issue is about. */
    ref?: string;
};

export type PlannedTest = {
    /** Stable id: `<group>/<index>` with a 1-based index inside its group. */
    id: string;
    group: string;
    index: number;
    source: { kind: "manual"; path: string } | { kind: "gen"; generator: string; path: string; args: string };
    /** Hand-written answer file of a manual test. */
    answer?: string;
    desc?: string;
};

export type PlannedGroup = {
    name: string;
    points: number;
    aggregate: "min" | "sum";
    sample: boolean;
    depends: string[];
    /** Global constraints overridden by the group's own. */
    constraints: Constraints;
    /** Ids of the group's own tests. */
    tests: string[];
    /** Own tests plus the tests of every (transitive) dependency. */
    closure: string[];
};

export type PlannedSolution = {
    path: string;
    /** Set for a program. Output-only tasks also accept a directory of outputs, see `outputs`. */
    language?: Language;
    /**
     * Output-only tasks: the solution is a directory of answer files, one per test at
     * `<path>/<group>/<index>.out`. Maps test id to the file; tests with no file are absent.
     */
    outputs?: Record<string, string>;
    main: boolean;
    /** Expected outcome per group name. */
    expect: Record<string, string>;
};

export type Plan = {
    manifest: Manifest;
    runnable: boolean;
    tests: PlannedTest[];
    groups: PlannedGroup[];
    solutions: PlannedSolution[];
    main?: PlannedSolution;
    validator?: { path: string; language: Language };
    checker?: { path: string; language: Language };
    /** A checker Forge generates: `lines`, `float` or `yesno` (`tokens` is the judge's default). */
    builtinChecker?: { kind: Exclude<BuiltinChecker, "tokens">; eps: number };
    /** `type: grader`: the grader file per language and the headers they share with solutions. */
    grader?: { files: Partial<Record<Language, string>>; headers: string[] };
    /** `type: communication`: the program run between a solution's two runs. */
    manager?: { path: string; language: Language };
    /** Set when the instances of a communication task run at the same time. */
    simultaneous?: { processes: number };
    statements: Record<string, string>;
};

export const MANIFEST_PATH = "problem.yaml";

export const parseManifest = (
    text: string,
): { manifest: Manifest; issues: Issue[] } | { manifest: undefined; issues: Issue[] } => {
    let raw: unknown;
    try {
        raw = parseYaml(text);
    } catch (error) {
        return {
            manifest: undefined,
            issues: [
                {
                    severity: "error",
                    code: "manifest.yaml",
                    message: `problem.yaml is not valid YAML: ${(error as Error).message}`,
                    ref: MANIFEST_PATH,
                },
            ],
        };
    }
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success) {
        return {
            manifest: undefined,
            issues: parsed.error.issues.map((issue) => ({
                severity: "error" as const,
                code: "manifest.schema",
                message: `${issue.path.join(".") || "problem.yaml"}: ${issue.message}`,
                ref: MANIFEST_PATH,
            })),
        };
    }
    return { manifest: parsed.data, issues: [] };
};

const mergeConstraints = (base: Constraints, override: Constraints): Constraints => {
    const merged: Constraints = {};
    for (const [name, bound] of Object.entries(base)) merged[name] = { ...bound };
    for (const [name, bound] of Object.entries(override))
        merged[name] = { ...merged[name], ...bound };
    return merged;
};

/**
 * Turns a manifest plus the list of files in the package into a concrete build plan and
 * reports every structural problem (missing files, unknown generators, dependency cycles...).
 */
export const planBuild = (manifest: Manifest, files: readonly string[]): { plan: Plan; issues: Issue[] } => {
    const issues: Issue[] = [];
    const fileSet = new Set(files);
    const error = (code: string, message: string, ref?: string) =>
        issues.push({ severity: "error", code, message, ref });
    const warning = (code: string, message: string, ref?: string) =>
        issues.push({ severity: "warning", code, message, ref });

    const program = (path: string, what: string): { path: string; language: Language } | undefined => {
        if (!fileSet.has(path)) {
            error("file.missing", `${what} ${path} does not exist`, path);
            return undefined;
        }
        const language = languageOf(path);
        if (!language) {
            error("file.language", `${what} ${path} has an unsupported file extension`, path);
            return undefined;
        }
        return { path, language };
    };

    const runnable = RUNNABLE_TASK_TYPES.includes(manifest.type);
    if (!runnable)
        warning(
            "type.not-runnable",
            `Task type "${manifest.type}" can be described but not built yet; it needs the next runner protocol`,
        );

    const validator = manifest.validator ? program(manifest.validator, "Validator") : undefined;
    if (!manifest.validator)
        warning("validator.missing", "No validator: nothing proves the tests satisfy the constraints");
    const checker = typeof manifest.checker === "string" ? program(manifest.checker, "Checker") : undefined;
    const builtinChecker =
        typeof manifest.checker === "object" && manifest.checker.builtin !== "tokens"
            ? { kind: manifest.checker.builtin, eps: manifest.checker.eps ?? 1e-6 }
            : undefined;
    if (typeof manifest.checker === "object" && manifest.checker.eps !== undefined && manifest.checker.builtin !== "float")
        warning("checker.eps", `eps only applies to the float checker, not to "${manifest.checker.builtin}"`);
    if (manifest.type === "interactive" && typeof manifest.checker === "object")
        error("checker.missing", "Interactive tasks need an interactor program as the checker, not a built-in one");
    if (manifest.type === "interactive" && !manifest.checker)
        error("checker.missing", "Interactive tasks need a checker (the interactor)");

    let grader: Plan["grader"];
    if (manifest.type === "grader") {
        const files: Partial<Record<Language, string>> = {};
        for (const language of GRADER_LANGUAGES) {
            const path = manifest.grader?.[language];
            if (!path) continue;
            if (!fileSet.has(path)) error("file.missing", `Grader ${path} does not exist`, path);
            else if (languageOf(path) !== language) error("grader.language", `Grader ${path} is listed under "${language}" but is not a ${language} file`, path);
            else files[language] = path;
        }
        for (const header of manifest.grader?.headers ?? []) if (!fileSet.has(header)) error("file.missing", `Header ${header} does not exist`, header);
        if (Object.keys(files).length === 0 && !issues.some((issue) => issue.severity === "error"))
            error("grader.missing", "A grader task needs a grader for at least one language: grader: { cpp: grader.cpp }");
        grader = { files, headers: (manifest.grader?.headers ?? []).filter((header) => fileSet.has(header)) };
    } else if (manifest.grader) warning("grader.unused", `grader is only used by type: grader, not by "${manifest.type}"`);
    let manager: Plan["manager"];
    if (manifest.type === "communication") {
        if (!manifest.manager) error("manager.missing", "A communication task needs a manager: the program run between the solution's two runs");
        else manager = program(manifest.manager, "Manager");
        if (manifest.communication?.simultaneous && manifest.checker !== undefined)
            warning("checker.unused", "With simultaneous communication the manager decides the verdict; the checker is not used");
    } else if (manifest.communication) {
        warning("communication.unused", `communication is only used by type: communication, not by "${manifest.type}"`);
    } else if (manifest.manager) warning("manager.unused", `manager is only used by type: communication, not by "${manifest.type}"`);

    const generators: Record<string, { path: string; language: Language }> = {};
    for (const [name, path] of Object.entries(manifest.generators)) {
        const resolved = program(path, `Generator "${name}"`);
        if (resolved) generators[name] = resolved;
    }

    // groups
    const groupNames = new Set<string>();
    for (const group of manifest.groups) {
        if (groupNames.has(group.name)) error("group.duplicate", `Duplicate group "${group.name}"`, group.name);
        groupNames.add(group.name);
    }
    for (const group of manifest.groups)
        for (const dependency of group.depends)
            if (!groupNames.has(dependency))
                error(
                    "group.depends",
                    `Group "${group.name}" depends on unknown group "${dependency}"`,
                    group.name,
                );

    const tests: PlannedTest[] = [];
    const ownTests: Record<string, string[]> = {};
    for (const group of manifest.groups) {
        const ids: string[] = [];
        let index = 0;
        const add = (source: PlannedTest["source"], extra: Pick<PlannedTest, "answer" | "desc"> = {}) => {
            index += 1;
            const id = `${group.name}/${index}`;
            tests.push({ id, group: group.name, index, source, ...extra });
            ids.push(id);
        };
        for (const spec of group.tests) {
            if ("manual" in spec) {
                if (!fileSet.has(spec.manual))
                    error("file.missing", `Manual test ${spec.manual} does not exist`, spec.manual);
                if (spec.answer !== undefined && !fileSet.has(spec.answer))
                    error("file.missing", `Answer file ${spec.answer} does not exist`, spec.answer);
                if (spec.answer !== undefined && manifest.type === "interactive")
                    warning("test.answer-unused", `Interactive tasks have no answers; ${spec.answer} is not used`, spec.answer);
                add({ kind: "manual", path: spec.manual }, { answer: spec.answer, desc: spec.desc });
                continue;
            }
            const generator = generators[spec.gen];
            if (!generator) {
                if (!(spec.gen in manifest.generators))
                    error(
                        "generator.unknown",
                        `Group "${group.name}" uses unknown generator "${spec.gen}"`,
                        group.name,
                    );
                continue;
            }
            const count = spec.count ?? 1;
            if (spec.count !== undefined && spec.count > 1 && !spec.args.includes("{i}"))
                error(
                    "test.count",
                    `Group "${group.name}": a test with count > 1 must use {i} in args, otherwise every copy is identical`,
                    group.name,
                );
            for (let copy = 1; copy <= count; copy++)
                add(
                    {
                        kind: "gen",
                        generator: spec.gen,
                        path: generator.path,
                        args: spec.args.replaceAll("{i}", String(copy)),
                    },
                    { desc: spec.desc },
                );
        }
        if (ids.length === 0 && group.depends.length === 0)
            warning("group.empty", `Group "${group.name}" has no tests`, group.name);
        ownTests[group.name] = ids;
    }

    // dependency closure, detecting cycles
    const closures: Record<string, string[]> = {};
    const visiting = new Set<string>();
    const byName = new Map(manifest.groups.map((group) => [group.name, group]));
    const closureOf = (name: string): string[] => {
        const cached = closures[name];
        if (cached) return cached;
        if (visiting.has(name)) {
            error("group.cycle", `Group dependencies form a cycle through "${name}"`, name);
            return [];
        }
        visiting.add(name);
        const result = new Set<string>();
        for (const dependency of byName.get(name)?.depends ?? [])
            if (byName.has(dependency)) for (const id of closureOf(dependency)) result.add(id);
        for (const id of ownTests[name] ?? []) result.add(id);
        visiting.delete(name);
        return (closures[name] = [...result]);
    };

    const groups: PlannedGroup[] = manifest.groups.map((group) => ({
        name: group.name,
        points: group.points,
        aggregate: group.aggregate,
        sample: group.sample,
        depends: group.depends,
        constraints: mergeConstraints(manifest.constraints, group.constraints),
        tests: ownTests[group.name] ?? [],
        closure: closureOf(group.name),
    }));

    for (const group of manifest.groups)
        for (const name of Object.keys(group.constraints))
            if (!(name in manifest.constraints))
                warning(
                    "constraint.undeclared",
                    `Group "${group.name}" constrains "${name}", which is not declared at the top level`,
                    group.name,
                );
    for (const [name, bound] of Object.entries(manifest.constraints))
        if (bound.min !== undefined && bound.max !== undefined && bound.min > bound.max)
            error("constraint.range", `Constraint ${name} has min > max`, name);
    for (const group of groups)
        for (const [name, bound] of Object.entries(group.constraints))
            if (bound.min !== undefined && bound.max !== undefined && bound.min > bound.max)
                error("constraint.range", `Group "${group.name}": constraint ${name} has min > max`, group.name);

    // solutions
    const solutions: PlannedSolution[] = [];
    const seen = new Set<string>();
    for (const solution of manifest.solutions) {
        if (seen.has(solution.path)) {
            error("solution.duplicate", `Solution ${solution.path} is listed twice`, solution.path);
            continue;
        }
        seen.add(solution.path);
        let resolved: Pick<PlannedSolution, "path" | "language" | "outputs"> | undefined;
        const directory = `${solution.path.replace(/\/+$/, "")}/`;
        if (manifest.type === "output-only" && !fileSet.has(solution.path) && files.some((file) => file.startsWith(directory))) {
            const outputs: Record<string, string> = {};
            const expected = new Set<string>();
            for (const test of tests) {
                const file = `${directory}${test.id}.out`;
                expected.add(file);
                if (fileSet.has(file)) outputs[test.id] = file;
            }
            const stray = files.filter((file) => file.startsWith(directory) && !expected.has(file));
            if (stray.length > 0)
                warning(
                    "solution.stray-output",
                    `${solution.path} has ${stray.length} file(s) that match no test (for example ${stray[0]}); outputs are named <group>/<index>.out`,
                    solution.path,
                );
            if (solution.role === "main") {
                const missing = tests.filter((test) => !outputs[test.id]).map((test) => test.id);
                if (missing.length > 0)
                    error(
                        "solution.main-output",
                        `The main solution has no output for ${missing.length} test(s): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`,
                        solution.path,
                    );
            }
            resolved = { path: solution.path, outputs };
        } else resolved = program(solution.path, "Solution");
        if (!resolved) continue;
        if (grader && resolved.language && !grader.files[resolved.language])
            error(
                "grader.language",
                `Solution ${solution.path} is written in ${resolved.language}, for which the problem has no grader`,
                solution.path,
            );
        const main = solution.role === "main";
        const expect: Record<string, string> = {};
        if (main && solution.expect !== undefined && solution.expect !== "AC")
            error("solution.main-expect", "The main solution is always expected to be AC", solution.path);
        if (main || solution.expect === undefined || typeof solution.expect === "string") {
            const value = main ? "AC" : ((solution.expect as string | undefined) ?? "AC");
            for (const group of manifest.groups) expect[group.name] = value;
        } else {
            for (const [group, value] of Object.entries(solution.expect)) {
                if (!groupNames.has(group)) {
                    error(
                        "solution.expect-group",
                        `Solution ${solution.path} has an expectation for unknown group "${group}"`,
                        solution.path,
                    );
                    continue;
                }
                expect[group] = value;
            }
        }
        solutions.push({ ...resolved, main, expect });
    }
    const mains = solutions.filter((solution) => solution.main);
    if (mains.length === 0 && manifest.solutions.every((s) => s.role !== "main"))
        error("solution.no-main", "No solution has role: main; answers cannot be produced");
    if (mains.length > 1) error("solution.many-main", "More than one solution has role: main");
    if (!solutions.some((solution) => Object.values(solution.expect).some((value) => value !== "AC")))
        warning(
            "solution.no-wrong",
            "No solution is expected to fail, so nothing measures whether the tests are strong",
        );

    const statements: Record<string, string> = {};
    if (manifest.statements) {
        for (const [language, path] of Object.entries(manifest.statements)) {
            if (!fileSet.has(path)) error("file.missing", `Statement ${path} does not exist`, path);
            else statements[language] = path;
        }
    } else {
        for (const path of files) {
            const match = /^statement\/([A-Za-z-]+)\.md$/.exec(path);
            if (match?.[1]) statements[match[1]] = path;
        }
    }
    if (Object.keys(statements).length === 0) warning("statement.missing", "The problem has no statement");

    if (manifest.scoring.mode === "sum" && groups.every((group) => group.points === 0))
        warning("scoring.no-points", "No group awards points");

    // the constants prelude exists for C, C++ and Python only
    const hasConstraints = Object.keys(manifest.constraints).length > 0 || manifest.groups.some((group) => Object.keys(group.constraints).length > 0);
    if (hasConstraints)
        for (const tool of [validator, checker, manager, ...Object.values(generators)])
            if (tool && !PRELUDE_LANGUAGES.includes(tool.language))
                warning(
                    "prelude.unsupported",
                    `${tool.path} is written in ${tool.language}, which does not receive the constraint constants (N_MAX, ...); only C, C++ and Python do`,
                    tool.path,
                );

    // what kontestis cannot score today
    if (manifest.judge === "kontestis") {
        const incompatible = (message: string, ref?: string) => warning("kontestis.incompatible", `kontestis: ${message}`, ref);
        if (manifest.type === "grader" || manifest.type === "communication")
            incompatible(`it has no "${manifest.type}" tasks: it runs the contestant's file alone, once per test`);
        if (manifest.scoring.mode === "binary")
            incompatible("there is no binary (all-or-nothing) scoring; clusters are summed, so give one cluster all the points");
        for (const group of manifest.groups) {
            if (group.aggregate === "sum" && (ownTests[group.name]?.length ?? 0) > 1)
                incompatible(`cluster "${group.name}" uses aggregate: sum, but a cluster scores the minimum over its tests`, group.name);
            if (group.depends.length > 0)
                incompatible(`cluster "${group.name}" depends on other groups; clusters are scored independently, so the dependency is not enforced`, group.name);
            if (!Number.isInteger(group.points))
                incompatible(`cluster "${group.name}" awards ${group.points} points; cluster scores are whole numbers`, group.name);
            if (manifest.type === "output-only" && (ownTests[group.name]?.length ?? 0) > 1)
                incompatible(`output-only cluster "${group.name}" has several tests; a submission is one output judged against the first test of each cluster`, group.name);
        }
    }

    return {
        plan: {
            manifest,
            runnable,
            tests,
            groups,
            solutions,
            main: mains.length === 1 ? mains[0] : undefined,
            validator,
            checker,
            builtinChecker,
            grader,
            manager,
            simultaneous:
                manifest.type === "communication" && manifest.communication?.simultaneous
                    ? { processes: manifest.communication.processes }
                    : undefined,
            statements,
        },
        issues,
    };
};
