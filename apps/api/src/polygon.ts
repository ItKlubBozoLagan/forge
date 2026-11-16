import { languageOf } from "@forge/core";
import { XMLParser } from "fast-xml-parser";
import { stringify } from "yaml";

/**
 * Turns a Polygon package (the zip Polygon offers for download) into a Forge package.
 * Polygon tools are written against testlib.h, which Forge inlines at build time, so the
 * generators, validator and checker are taken over as they are.
 */
export type PolygonImport = {
    name: string;
    title: string;
    files: Record<string, Uint8Array>;
    /** What could not be carried over, for the author to look at. */
    notes: string[];
};

const asArray = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const text = (data: Uint8Array) => Buffer.from(data).toString("utf8");
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "utf8"));
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const LANGUAGE_CODES: Record<string, string> = { english: "en", russian: "ru", croatian: "hr", german: "de", french: "fr", spanish: "es", polish: "pl", ukrainian: "uk" };

/** Polygon solution tags as Forge expectations. `null` cannot be expressed. */
const TAGS: Record<string, string | null> = {
    main: "AC",
    accepted: "AC",
    "wrong-answer": "WA",
    "presentation-error": "WA",
    "time-limit-exceeded": "TLE",
    "memory-limit-exceeded": "MLE",
    "time-limit-exceeded-or-memory-limit-exceeded": "TLE|MLE",
    rejected: "FAIL",
    failed: "FAIL",
    "time-limit-exceeded-or-accepted": null,
};

const identifier = (name: string) => {
    const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_");
    return /^[A-Za-z]/.test(cleaned) ? cleaned : `g_${cleaned}`;
};
const groupName = (name: string) => {
    const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "-");
    return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `g${cleaned}`;
};
const pattern = (template: string, index: number) =>
    template.replace(/%0?(\d*)d/, (_whole, width: string) => String(index).padStart(Number(width || 0), "0"));

/** Polygon statements are TeX fragments; the common inline commands have Markdown equivalents. */
const texToMarkdown = (source: string) =>
    source
        .replace(/\\(?:textbf|bf)\{([^{}]*)\}/g, "**$1**")
        .replace(/\\(?:textit|it|emph)\{([^{}]*)\}/g, "*$1*")
        .replace(/\\(?:texttt|t)\{([^{}]*)\}/g, "`$1`")
        .replace(/\\begin\{itemize\}|\\end\{itemize\}|\\begin\{enumerate\}|\\end\{enumerate\}/g, "")
        .replace(/^\s*\\item\s*/gm, "- ")
        .replace(/\$\$\$([^$]+)\$\$\$/g, "$$$1$$")
        .replace(/~---/g, " —")
        .replace(/<<|>>/g, '"');

export const importPolygon = (archive: Record<string, Uint8Array>): PolygonImport => {
    // some archives wrap everything in one top folder
    let prefix = "";
    if (!archive["problem.xml"]) {
        const found = Object.keys(archive).find((path) => /^[^/]+\/problem\.xml$/.test(path));
        if (!found) throw new Error("This is not a Polygon package: it has no problem.xml");
        prefix = found.slice(0, found.length - "problem.xml".length);
    }
    const file = (path: string): Uint8Array | undefined => archive[`${prefix}${path}`];
    const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", processEntities: false }).parse(text(file("problem.xml")!)) as { problem?: Record<string, any> };
    const problem = xml.problem;
    if (!problem) throw new Error("problem.xml has no <problem> element");

    const notes: string[] = [];
    const files: Record<string, Uint8Array> = {};
    const name = (String(problem["short-name"] ?? "imported").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "imported").slice(0, 60);
    const names = asArray<Record<string, string>>(problem.names?.name);
    // Polygon leaves the name empty when it is only set in the statement
    const properties = Object.keys(archive)
        .filter((path) => path.startsWith(`${prefix}statements/`) && path.endsWith("/problem-properties.json"))
        .sort((a, b) => Number(b.includes("/english/")) - Number(a.includes("/english/")));
    let statementName: string | undefined;
    try {
        statementName = properties[0] ? (JSON.parse(text(archive[properties[0]]!)) as { name?: string }).name : undefined;
    } catch {
        statementName = undefined;
    }
    const title = ((names.find((entry) => entry.language === "english") ?? names[0])?.value || statementName || name).trim() || name;

    // A testset with tests is a set of tests judged together. Packages for subtask scoring often
    // use one testset per subtask instead of groups inside "tests"; both shapes are imported.
    const testsets = asArray<Record<string, any>>(problem.judging?.testset).filter(
        (entry) => asArray(entry.tests?.test).length > 0 || Number(entry["test-count"] ?? 0) > 0,
    );
    if (testsets.length === 0) throw new Error("problem.xml has no testset with tests");
    const several = testsets.length > 1;
    const times = testsets.map((entry) => Number(entry["time-limit"] ?? 1000));
    const memories = testsets.map((entry) => Number(entry["memory-limit"] ?? 268435456));
    if (new Set(times).size > 1 || new Set(memories).size > 1)
        notes.push("The testsets have different limits; Forge has one pair of limits per problem, so the largest were taken.");

    const manifest: Record<string, any> = {
        name,
        title,
        type: "batch",
        limits: {
            time_ms: Math.min(60_000, Math.max(50, Math.max(...times))),
            memory_mb: Math.min(4096, Math.max(16, Math.round(Math.max(...memories) / (1024 * 1024)))),
        },
    };

    // tools
    const program = (source: string | undefined, target: string, what: string): string | undefined => {
        if (!source) return undefined;
        const data = file(source);
        if (!data) {
            notes.push(`${what} ${source} is named in problem.xml but missing from the archive.`);
            return undefined;
        }
        if (!languageOf(source)) {
            notes.push(`${what} ${source} is in a language Forge does not run; it was not imported.`);
            return undefined;
        }
        const path = `${target}.${source.split(".").pop()}`.replace(/[^A-Za-z0-9._/-]/g, "_");
        files[path] = data;
        return path;
    };
    const assets = problem.assets ?? {};
    const interactor = program(assets.interactor?.source?.path, "interactor", "Interactor");
    const checker = program(assets.checker?.source?.path, "checker", "Checker");
    const validator = program(asArray<any>(assets.validators?.validator)[0]?.source?.path, "validator", "Validator");
    if (assets.interactor) {
        manifest.type = "interactive";
        notes.push("The problem is interactive: its interactor decides the verdict, and what it writes to its output file (tout) is not passed on to a checker.");
        if (interactor) manifest.checker = interactor;
        if (checker) notes.push(`The checker was imported as ${checker} but is not used: an interactive task is judged by its interactor.`);
    } else if (checker) manifest.checker = checker;
    if (validator) manifest.validator = validator;

    // generators: every executable a test command uses
    const executables = new Map<string, string>();
    for (const executable of asArray<any>(problem.files?.executables?.executable)) {
        const source = executable?.source?.path as string | undefined;
        if (source) executables.set(basename(source).replace(/\.[^.]+$/, ""), source);
    }
    const generators: Record<string, string> = {};
    const generatorFor = (command: string): string | undefined => {
        const key = identifier(command);
        if (generators[key]) return key;
        const source = executables.get(command);
        const path = source ? program(source, `generators/${command}`, "Generator") : undefined;
        if (!path) return undefined;
        generators[key] = path;
        return key;
    };

    // tests and groups
    type Bucket = { name: string; sample: boolean; points: number; samples: number; perTest: boolean; depends: string[]; tests: Array<Record<string, unknown>> };
    const buckets = new Map<string, Bucket>();
    const bucket = (key: string, sample: boolean) => {
        let found = buckets.get(key);
        if (!found) buckets.set(key, (found = { name: key, sample, points: 0, samples: 0, perTest: false, depends: [], tests: [] }));
        return found;
    };
    /** Group a testset's tests end up in when the package gives it no groups of its own. */
    const plain = new Map<string, string>();
    let grouped = false;
    for (const testset of testsets) {
        const setName = String(testset.name ?? "tests");
        const declared = new Map(asArray<Record<string, any>>(testset.groups?.group).map((group) => [String(group.name), group]));
        const inputPattern = String(testset["input-path-pattern"] ?? "tests/%02d");
        let entries = asArray<Record<string, string>>(testset.tests?.test);
        // a testset can list no tests and still ship numbered files
        if (entries.length === 0) entries = Array.from({ length: Number(testset["test-count"] ?? 0) }, () => ({ method: "manual" }));
        const setGrouped = entries.some((test) => test.group !== undefined);
        grouped ||= setGrouped;
        entries.forEach((test, offset) => {
            const index = offset + 1;
            const sample = test.sample === "true";
            const key = setGrouped
                ? groupName(`${several ? `${setName}-` : ""}${test.group ?? "ungrouped"}`)
                : several
                  ? groupName(setName)
                  : sample
                    ? "samples"
                    : "tests";
            const target = bucket(key, !setGrouped && !several && sample);
            if (!setGrouped) plain.set(setName, key);
            if (test.points !== undefined) {
                target.points += Number(test.points) || 0;
                target.perTest = true;
            }
            if (sample) target.samples += 1;
            const [command, ...args] = String(test.cmd ?? "").trim().split(/\s+/);
            const generator = test.method === "generated" && command ? generatorFor(command) : undefined;
            if (generator) {
                target.tests.push({ gen: generator, args: args.join(" ") });
                return;
            }
            const input = file(pattern(inputPattern, index));
            if (!input) {
                notes.push(
                    test.method === "generated"
                        ? `Test ${index} of "${setName}" is generated by "${test.cmd}", whose generator source is not in the archive, and the test file is not either; it was skipped. Download the full package from Polygon to include generated tests.`
                        : `Test ${index} of "${setName}" has no input file in the archive; it was skipped.`,
                );
                return;
            }
            const path = `tests/${several ? `${groupName(setName)}/` : ""}${String(index).padStart(2, "0")}.in`;
            files[path] = input;
            target.tests.push({ manual: path });
        });
        for (const [groupKey, group] of declared) {
            const target = buckets.get(groupName(`${several ? `${setName}-` : ""}${groupKey}`));
            if (!target) continue;
            if (group.points !== undefined) target.points = Number(group.points) || 0;
            target.perTest = group["points-policy"] === "each-test";
            target.depends = asArray<Record<string, string>>(group.dependencies?.dependency).map((dependency) =>
                groupName(`${several ? `${setName}-` : ""}${dependency.group}`),
            );
        }
    }
    for (const [key, entry] of buckets) if (entry.tests.length === 0) buckets.delete(key);

    // where the samples are: a group holding only sample tests
    for (const entry of buckets.values()) {
        if (entry.sample || entry.samples === 0) continue;
        if (entry.samples === entry.tests.length) entry.sample = true;
        else notes.push(`Group "${entry.name}" mixes sample tests with others; Forge shows samples per group, so move them to a group with sample: true to have them in the statement.`);
    }
    if (![...buckets.values()].some((entry) => entry.sample)) notes.push("No test is marked as a sample, so the statement will show no samples; put the sample tests in a group with sample: true.");
    const resources = asArray<Record<string, string>>(problem.files?.resources?.file)
        .map((resource) => String(resource.path ?? ""))
        .filter((path) => path && !/(^|\/)(testlib\.h|olymp\.sty|problem\.tex|statements\.ftl|tutorial\.tex)$/.test(path));
    if (resources.length > 0)
        notes.push(`Resource files are not imported (${resources.slice(0, 5).join(", ")}${resources.length > 5 ? ", ..." : ""}); a tool that includes one of them must be made self-contained.`);

    const anyPoints = [...buckets.values()].some((entry) => entry.points > 0);
    if (!anyPoints && !several) manifest.scoring = { mode: "binary" };
    if (!anyPoints && several) notes.push("The package gives its testsets no points; set the points of each group in problem.yaml.");
    if (Object.keys(generators).length > 0) manifest.generators = generators;
    manifest.groups = [...buckets.values()].map((entry) => ({
        name: entry.name,
        ...(entry.sample ? { sample: true } : {}),
        ...(anyPoints ? { points: entry.points } : {}),
        ...(entry.perTest && anyPoints && !entry.sample ? { aggregate: "sum" } : {}),
        ...(!grouped && !several && !entry.sample && buckets.has("samples") ? { depends: ["samples"] } : {}),
        ...(entry.depends.length > 0 ? { depends: entry.depends.filter((dependency) => buckets.has(dependency)) } : {}),
        tests: entry.tests,
    }));
    if (manifest.groups.length === 0) {
        manifest.groups = [{ name: "tests", tests: [] }];
        notes.push("No test could be imported.");
    }

    // solutions
    const solutions: Array<Record<string, unknown>> = [];
    const taken = new Set<string>();
    for (const solution of asArray<Record<string, any>>(assets.solutions?.solution)) {
        const source = solution?.source?.path as string | undefined;
        if (!source) continue;
        const tag = String(solution.tag ?? "accepted");
        if (!(tag in TAGS)) {
            notes.push(`Solution ${source} has the unknown tag "${tag}"; it was not imported.`);
            continue;
        }
        // tags given per testset say exactly where a solution is expected to fail
        const perSet: Record<string, string> = {};
        let unclear = 0;
        for (const extra of asArray<Record<string, string>>(solution["extra-tags"]?.["extra-tag"])) {
            const group = plain.get(String(extra.testset));
            if (!group || !buckets.has(group)) continue;
            const expected = TAGS[String(extra.tag)];
            if (expected) perSet[group] = expected;
            else unclear += 1;
        }
        const expectation = TAGS[tag];
        const hasPerSet = Object.keys(perSet).length > 0;
        if (expectation === null && !hasPerSet) {
            notes.push(`Solution ${source} is tagged "${tag}", which Forge cannot express (an expectation is either AC or a set of failures); it was not imported.`);
            continue;
        }
        let stem = `solutions/${basename(source).replace(/\.[^.]+$/, "")}`;
        while (taken.has(stem)) stem += "_";
        const path = program(source, stem, "Solution");
        if (!path) continue;
        taken.add(stem);
        if (path.endsWith(".java")) notes.push(`${path}: Java solutions must define their entry point in a class named Main.`);
        if (tag === "main") solutions.push({ path, role: "main" });
        else if (hasPerSet) {
            solutions.push({ path, expect: perSet });
            if (unclear > 0) notes.push(`Solution ${path} has testsets tagged with an either-or outcome; those groups were left without an expectation.`);
        } else if (expectation === "AC") solutions.push({ path });
        else if (!grouped && !several && buckets.has("tests")) {
            // a Polygon tag is about the whole test set: the solution may well pass the samples
            solutions.push({ path, expect: { tests: expectation } });
        } else {
            solutions.push({ path, expect: {} });
            notes.push(`Solution ${path} is tagged "${tag}" for the whole test set; say in problem.yaml on which groups it is expected to fail (${expectation}).`);
        }
    }
    if (!solutions.some((solution) => solution.role === "main")) notes.push("The package has no main solution Forge can run; add one before building.");
    manifest.solutions = solutions;

    // statements, from the per-language properties file Polygon writes next to the TeX
    for (const path of Object.keys(archive)) {
        const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}statements/([a-z]+)/problem-properties\\.json$`).exec(path);
        if (!match) continue;
        try {
            const properties = JSON.parse(text(archive[path]!)) as Record<string, string | undefined>;
            const section = (heading: string, body: string | undefined) => (body?.trim() ? `## ${heading}\n\n${texToMarkdown(body.trim())}\n\n` : "");
            const markdown =
                `# ${properties.name ?? title}\n\n${texToMarkdown(properties.legend?.trim() ?? "")}\n\n` +
                section("Input", properties.input) +
                section("Output", properties.output) +
                section("Interaction", properties.interaction) +
                section("Scoring", properties.scoring) +
                "{{samples}}\n\n" +
                section("Notes", properties.notes);
            files[`statement/${LANGUAGE_CODES[match[1]!] ?? match[1]!.slice(0, 2)}.md`] = bytes(markdown);
        } catch {
            notes.push(`The ${match[1]} statement could not be read.`);
        }
    }
    if (!Object.keys(files).some((path) => path.startsWith("statement/")))
        notes.push("No statement was imported: the archive has no statements/<language>/problem-properties.json.");
    else notes.push("Statements were converted from TeX to Markdown; check formulas, lists and figures.");

    files["problem.yaml"] = bytes(
        `# Imported from a Polygon package (revision ${problem.revision ?? "unknown"}).\n# Generators, validator and checker use testlib.h, which Forge provides.\n${stringify(manifest, { lineWidth: 0 })}`,
    );
    return { name, title, files, notes };
};
