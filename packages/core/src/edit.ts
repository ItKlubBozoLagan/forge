/**
 * Structured edits of `problem.yaml`. Every function takes the manifest text and returns the new
 * text; comments, key order and the formatting of parts that are not touched survive because
 * the edits go through the `yaml` document model instead of re-serialising plain objects.
 *
 * Keys and fields these functions do not know about are kept as they are.
 */
import { Document, isMap, isScalar, isSeq, Pair, parseDocument, Scalar, YAMLMap, YAMLSeq } from "yaml";

import type { BuiltinChecker } from "./manifest";

export class ManifestEditError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ManifestEditError";
    }
}

export type BoundEdit = { min?: number; max?: number };
export type GroupFields = {
    name: string;
    points?: number;
    aggregate?: "min" | "sum";
    sample?: boolean;
    depends?: string[];
};
export type ManualTestEdit = { manual: string; answer?: string; desc?: string };
export type GeneratedTestEdit = { gen: string; args?: string; count?: number; desc?: string };
export type TestEdit = ManualTestEdit | GeneratedTestEdit;
export type CheckerEdit = string | { builtin: BuiltinChecker; eps?: number };
export type SolutionEdit = { path: string; role?: "main"; expect?: string | Record<string, string> };

// canonical key order, used to place keys that are added
const TOP_ORDER = [
    "name",
    "title",
    "type",
    "judge",
    "limits",
    "scoring",
    "constraints",
    "validator",
    "checker",
    "generators",
    "groups",
    "solutions",
    "statements",
];
const GROUP_ORDER = ["name", "points", "aggregate", "sample", "depends", "constraints", "tests"];
const TEST_ORDER = ["manual", "answer", "gen", "args", "count", "desc"];
const SOLUTION_ORDER = ["path", "role", "expect"];
const BOUND_ORDER = ["min", "max"];
const LIMITS_ORDER = ["time_ms", "memory_mb"];

// ---- document helpers ----

const load = (text: string): Document => {
    const doc = parseDocument(text);
    if (doc.errors.length > 0)
        throw new ManifestEditError(`problem.yaml is not valid YAML: ${doc.errors[0]!.message}`);
    if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null))
        doc.contents = new YAMLMap() as never;
    if (!isMap(doc.contents)) throw new ManifestEditError("problem.yaml must be a mapping");
    return doc;
};

/**
 * Applies `change` to the document. Returns the original text when the change did not alter
 * any value, so no-op edits never reformat the file.
 */
const edit = (text: string, change: (doc: Document, root: YAMLMap) => void): string => {
    const doc = load(text);
    const before = JSON.stringify(doc.toJS());
    const baseline = doc.toString(STRINGIFY);
    change(doc, doc.contents as YAMLMap);
    if (JSON.stringify(doc.toJS()) === before) return text;
    return restoreUntouchedLines(text, baseline, doc.toString(STRINGIFY));
};

const STRINGIFY = { lineWidth: 0 } as const;

/**
 * Serialising normalises some formatting of untouched lines (`[a]` becomes `[ a ]`, spacing
 * before comments). `baseline` is the unedited document serialised the same way; every line of
 * `next` that is unchanged from it gets its original text back.
 */
const restoreUntouchedLines = (original: string, baseline: string, next: string): string => {
    const source = original.split("\n");
    const base = baseline.split("\n");
    const lines = next.split("\n");
    if (source.length !== base.length || base.length * lines.length > 4_000_000) return next;
    // longest common subsequence of the baseline and the new lines
    const n = base.length;
    const m = lines.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            table[i]![j] =
                base[i] === lines[j]
                    ? table[i + 1]![j + 1]! + 1
                    : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    const result = [...lines];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (base[i] === lines[j]) {
            result[j] = source[i]!;
            i++;
            j++;
        } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
        else j++;
    }
    return result.join("\n");
};

const keyOf = (pair: Pair): unknown => (isScalar(pair.key) ? pair.key.value : pair.key);

const pairOf = (map: YAMLMap, key: string): Pair | undefined =>
    (map.items as Pair[]).find((pair) => keyOf(pair) === key);

const valueOf = (map: YAMLMap, key: string): unknown => {
    const value = pairOf(map, key)?.value;
    return isScalar(value) ? value.value : value;
};

const stringAt = (map: YAMLMap, key: string): string | undefined => {
    const value = valueOf(map, key);
    return typeof value === "string" ? value : undefined;
};

const isFlow = (node: unknown) => (isMap(node) || isSeq(node)) && !!node.flow;

const toNode = (doc: Document, value: unknown, flow: boolean) => {
    if (value !== null && typeof value === "object") return doc.createNode(value, { flow });
    return doc.createNode(value);
};

/** Inserts a new pair, after the last key that comes before it in `order` (else at the end). */
const insertPair = (map: YAMLMap, pair: Pair, order: readonly string[]) => {
    const target = order.indexOf(String(keyOf(pair)));
    let position = map.items.length;
    if (target !== -1) {
        position = 0;
        map.items.forEach((item, index) => {
            const rank = order.indexOf(String(keyOf(item as Pair)));
            if (rank !== -1 && rank < target) position = index + 1;
        });
    }
    map.items.splice(position, 0, pair as never);
};

/** Sets `key` to a node, replacing the existing value or adding the key in order. */
const setNode = (doc: Document, map: YAMLMap, key: string, node: unknown, order: readonly string[] = []) => {
    const existing = pairOf(map, key);
    if (existing) existing.value = node;
    else insertPair(map, new Pair(doc.createNode(key), node), order);
};

/** Sets `key` in `map`, keeping an existing scalar node (and its style) or adding the key in order. */
const setKey = (
    doc: Document,
    map: YAMLMap,
    key: string,
    value: unknown,
    order: readonly string[] = [],
    flow = isFlow(map),
) => {
    if (value === undefined) {
        deleteKey(map, key);
        return;
    }
    const existing = pairOf(map, key);
    if (existing && isScalar(existing.value) && (value === null || typeof value !== "object"))
        existing.value.value = value;
    else setNode(doc, map, key, toNode(doc, value, flow || isFlow(existing?.value)), order);
};

/** Removes an item, moving a comment or blank line in front of it to the next item. */
const removeItem = (items: unknown[], index: number) => {
    const [removed] = items.splice(index, 1);
    const next = items[index];
    if (!removed || !next) return;
    const from = (removed instanceof Pair ? removed.key : removed) as {
        commentBefore?: string | null;
        spaceBefore?: boolean;
    } | null;
    const to = (next instanceof Pair ? next.key : next) as {
        commentBefore?: string | null;
        spaceBefore?: boolean;
    } | null;
    if (!from || !to || typeof to !== "object") return;
    if (from.commentBefore && !to.commentBefore) to.commentBefore = from.commentBefore;
    if (from.spaceBefore) to.spaceBefore = true;
};

const deleteKey = (map: YAMLMap, key: string) => {
    const index = (map.items as Pair[]).findIndex((pair) => keyOf(pair) === key);
    if (index !== -1) removeItem(map.items, index);
};

const mapAt = (
    doc: Document,
    parent: YAMLMap,
    key: string,
    order: readonly string[],
    flow: boolean,
): YAMLMap => {
    const node = pairOf(parent, key)?.value;
    if (isMap(node)) return node;
    if (node !== undefined && node !== null && !(isScalar(node) && node.value === null))
        throw new ManifestEditError(`"${key}" must be a mapping`);
    const map = new YAMLMap();
    map.flow = flow || isFlow(parent);
    setNode(doc, parent, key, map, order);
    return map;
};

const seqAt = (doc: Document, parent: YAMLMap, key: string, order: readonly string[]): YAMLSeq => {
    const node = pairOf(parent, key)?.value;
    if (isSeq(node)) return node;
    if (node !== undefined && node !== null && !(isScalar(node) && node.value === null))
        throw new ManifestEditError(`"${key}" must be a list`);
    const seq = new YAMLSeq();
    seq.flow = isFlow(parent);
    setNode(doc, parent, key, seq, order);
    return seq;
};

const optionalMap = (parent: YAMLMap, key: string): YAMLMap | undefined => {
    const node = pairOf(parent, key)?.value;
    return isMap(node) ? node : undefined;
};

const optionalSeq = (parent: YAMLMap, key: string): YAMLSeq | undefined => {
    const node = pairOf(parent, key)?.value;
    return isSeq(node) ? node : undefined;
};

const mapsIn = (seq: YAMLSeq | undefined): YAMLMap[] =>
    (seq?.items ?? []).filter((item): item is YAMLMap => isMap(item));

const groupsOf = (root: YAMLMap) => mapsIn(optionalSeq(root, "groups"));
const solutionsOf = (root: YAMLMap) => mapsIn(optionalSeq(root, "solutions"));

const findGroup = (root: YAMLMap, name: string) => {
    const seq = optionalSeq(root, "groups");
    const index = (seq?.items ?? []).findIndex(
        (item) => isMap(item) && stringAt(item, "name") === name,
    );
    if (!seq || index === -1) throw new ManifestEditError(`There is no group "${name}"`);
    return { seq, index, map: seq.items[index] as YAMLMap };
};

const findSolution = (root: YAMLMap, path: string) => {
    const seq = optionalSeq(root, "solutions");
    const index = (seq?.items ?? []).findIndex(
        (item) => isMap(item) && stringAt(item, "path") === path,
    );
    if (!seq || index === -1) throw new ManifestEditError(`There is no solution ${path}`);
    return { seq, index, map: seq.items[index] as YAMLMap };
};

const testsOf = (doc: Document, group: YAMLMap) => seqAt(doc, group, "tests", GROUP_ORDER);

const testAt = (doc: Document, root: YAMLMap, group: string, index: number) => {
    const seq = testsOf(doc, findGroup(root, group).map);
    const node = seq.items[index];
    if (!isMap(node)) throw new ManifestEditError(`Group "${group}" has no test ${index + 1}`);
    return { seq, map: node };
};

const move = (items: unknown[], from: number, to: number) => {
    if (from < 0 || from >= items.length) throw new ManifestEditError("Nothing to move");
    const target = Math.max(0, Math.min(items.length - 1, to));
    if (target === from) return;
    const [item] = items.splice(from, 1);
    items.splice(target, 0, item);
};

/** A new item of a list follows the style of its last sibling, or `fallback` for the first. */
const siblingFlow = (seq: YAMLSeq, fallback: boolean) => {
    const last = seq.items[seq.items.length - 1];
    return last === undefined ? fallback : isFlow(last);
};

const clean = <T extends Record<string, unknown>>(value: T): T =>
    Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

// ---- general ----

export const setTitle = (text: string, title: string, language?: string) =>
    edit(text, (doc, root) => {
        const current = optionalMap(root, "title");
        if (current) {
            const first = current.items[0] ? String(keyOf(current.items[0] as Pair)) : "en";
            setKey(doc, current, language ?? first, title);
        } else setKey(doc, root, "title", title, TOP_ORDER);
    });

export const setType = (text: string, type: string) =>
    edit(text, (doc, root) => setKey(doc, root, "type", type, TOP_ORDER));

/** Sets the target judge, or removes the key when `judge` is undefined. */
export const setJudge = (text: string, judge: "kontestis" | undefined) =>
    edit(text, (doc, root) => setKey(doc, root, "judge", judge, TOP_ORDER));

export const setLimits = (text: string, limits: { time_ms?: number; memory_mb?: number }) =>
    edit(text, (doc, root) => {
        const map = mapAt(doc, root, "limits", TOP_ORDER, true);
        for (const key of LIMITS_ORDER) {
            const value = limits[key as keyof typeof limits];
            if (value !== undefined) setKey(doc, map, key, value, LIMITS_ORDER);
        }
    });

export const setScoringMode = (text: string, mode: "sum" | "binary") =>
    edit(text, (doc, root) =>
        setKey(doc, mapAt(doc, root, "scoring", TOP_ORDER, true), "mode", mode),
    );

/** Sets the validator path, or removes the validator when `path` is undefined. */
export const setValidator = (text: string, path: string | undefined) =>
    edit(text, (doc, root) => setKey(doc, root, "validator", path, TOP_ORDER));

/**
 * Sets the checker: a file path, a built-in (`{ builtin, eps? }`), or undefined for the default
 * token comparison.
 */
export const setChecker = (text: string, checker: CheckerEdit | undefined) =>
    edit(text, (doc, root) => {
        if (typeof checker === "object") {
            const value = clean({ builtin: checker.builtin, eps: checker.eps });
            setNode(doc, root, "checker", doc.createNode(value, { flow: true }), TOP_ORDER);
        } else setKey(doc, root, "checker", checker, TOP_ORDER);
    });

// ---- constraints ----

const constraintsMap = (doc: Document, root: YAMLMap, group: string | undefined) =>
    group === undefined
        ? mapAt(doc, root, "constraints", TOP_ORDER, false)
        : mapAt(doc, findGroup(root, group).map, "constraints", GROUP_ORDER, true);

/**
 * Sets a constraint's bounds globally, or a group's override when `group` is given. A bound left
 * undefined is removed; `bound` undefined removes the constraint.
 */
export const setConstraint = (
    text: string,
    name: string,
    bound: BoundEdit | undefined,
    group?: string,
) =>
    edit(text, (doc, root) => {
        const map = constraintsMap(doc, root, group);
        if (bound === undefined) deleteKey(map, name);
        else {
            const existing = pairOf(map, name)?.value;
            if (isMap(existing))
                for (const key of BOUND_ORDER)
                    setKey(doc, existing, key, bound[key as keyof BoundEdit], BOUND_ORDER);
            else setKey(doc, map, name, clean({ min: bound.min, max: bound.max }), [], true);
        }
        if (group !== undefined && map.items.length === 0)
            deleteKey(findGroup(root, group).map, "constraints");
    });

export const removeConstraint = (text: string, name: string, group?: string) =>
    setConstraint(text, name, undefined, group);

/** Renames a constraint; a global rename also renames the groups' overrides. */
export const renameConstraint = (text: string, from: string, to: string, group?: string) =>
    edit(text, (doc, root) => {
        if (from === to) return;
        const maps =
            group === undefined
                ? [
                      optionalMap(root, "constraints"),
                      ...groupsOf(root).map((g) => optionalMap(g, "constraints")),
                  ]
                : [optionalMap(findGroup(root, group).map, "constraints")];
        for (const map of maps) {
            const pair = map && pairOf(map, from);
            if (!pair) continue;
            if (pairOf(map, to)) throw new ManifestEditError(`Constraint ${to} already exists`);
            pair.key = doc.createNode(to);
        }
    });

// ---- generators ----

export const setGenerator = (text: string, name: string, path: string) =>
    edit(text, (doc, root) =>
        setKey(doc, mapAt(doc, root, "generators", TOP_ORDER, false), name, path),
    );

/** Removes a generator. Tests that use it stay, and are then reported as using an unknown one. */
export const removeGenerator = (text: string, name: string) =>
    edit(text, (_doc, root) => {
        const map = optionalMap(root, "generators");
        if (map) deleteKey(map, name);
    });

/** Renames a generator and every test that uses it. */
export const renameGenerator = (text: string, from: string, to: string) =>
    edit(text, (doc, root) => {
        if (from === to) return;
        const map = optionalMap(root, "generators");
        const pair = map && pairOf(map, from);
        if (!map || !pair) throw new ManifestEditError(`There is no generator "${from}"`);
        if (pairOf(map, to)) throw new ManifestEditError(`Generator "${to}" already exists`);
        pair.key = doc.createNode(to);
        for (const group of groupsOf(root))
            for (const test of mapsIn(optionalSeq(group, "tests")))
                if (stringAt(test, "gen") === from) setKey(doc, test, "gen", to);
    });

// ---- groups ----

const writeGroupFields = (doc: Document, map: YAMLMap, fields: Partial<GroupFields>) => {
    if ("name" in fields && fields.name !== undefined)
        setKey(doc, map, "name", fields.name, GROUP_ORDER);
    if ("points" in fields) setKey(doc, map, "points", fields.points, GROUP_ORDER);
    if ("aggregate" in fields) setKey(doc, map, "aggregate", fields.aggregate, GROUP_ORDER);
    if ("sample" in fields) setKey(doc, map, "sample", fields.sample ? true : undefined, GROUP_ORDER);
    if ("depends" in fields) {
        const depends = fields.depends ?? [];
        setKey(doc, map, "depends", depends.length > 0 ? depends : undefined, GROUP_ORDER, true);
    }
};

/** Adds a group (with no tests) at `index`, or at the end. */
export const addGroup = (text: string, fields: GroupFields, index?: number) =>
    edit(text, (doc, root) => {
        const seq = seqAt(doc, root, "groups", TOP_ORDER);
        if (groupsOf(root).some((group) => stringAt(group, "name") === fields.name))
            throw new ManifestEditError(`Group "${fields.name}" already exists`);
        const map = new YAMLMap();
        map.flow = false;
        writeGroupFields(doc, map, fields);
        const tests = new YAMLSeq();
        tests.flow = true;
        map.items.push(new Pair(doc.createNode("tests"), tests) as never);
        seq.items.splice(index ?? seq.items.length, 0, map);
    });

/**
 * Changes a group's fields. A key present with the value undefined is removed. Renaming a group
 * also renames it in `depends` and in solutions' expectations.
 */
export const updateGroup = (text: string, name: string, fields: Partial<GroupFields>) =>
    edit(text, (doc, root) => {
        const { map } = findGroup(root, name);
        const rename = fields.name !== undefined && fields.name !== name ? fields.name : undefined;
        if (rename && groupsOf(root).some((group) => stringAt(group, "name") === rename))
            throw new ManifestEditError(`Group "${rename}" already exists`);
        writeGroupFields(doc, map, fields);
        if (!rename) return;
        for (const group of groupsOf(root)) {
            const depends = optionalSeq(group, "depends");
            for (const item of depends?.items ?? [])
                if (isScalar(item) && item.value === name) item.value = rename;
        }
        for (const solution of solutionsOf(root)) {
            const expect = optionalMap(solution, "expect");
            const pair = expect && pairOf(expect, name);
            if (pair) pair.key = doc.createNode(rename);
        }
    });

/** Removes a group, and its name from `depends` and from solutions' expectations. */
export const removeGroup = (text: string, name: string) =>
    edit(text, (_doc, root) => {
        const { seq, index } = findGroup(root, name);
        removeItem(seq.items, index);
        for (const group of groupsOf(root)) {
            const depends = optionalSeq(group, "depends");
            if (!depends) continue;
            depends.items = depends.items.filter((item) => !(isScalar(item) && item.value === name));
            if (depends.items.length === 0) deleteKey(group, "depends");
        }
        for (const solution of solutionsOf(root)) {
            const expect = optionalMap(solution, "expect");
            if (expect) deleteKey(expect, name);
        }
    });

/** Moves a group to position `to` (0-based, clamped). */
export const moveGroup = (text: string, name: string, to: number) =>
    edit(text, (_doc, root) => {
        const { seq, index } = findGroup(root, name);
        move(seq.items, index, to);
    });

// ---- tests ----

const KNOWN_TEST_KEYS = ["manual", "answer", "gen", "args", "count", "desc"];

const testValue = (test: TestEdit): Record<string, unknown> =>
    "manual" in test
        ? clean({ manual: test.manual, answer: test.answer || undefined, desc: test.desc || undefined })
        : clean({
              gen: test.gen,
              args: test.args ?? "",
              count: test.count !== undefined && test.count !== 1 ? test.count : undefined,
              desc: test.desc || undefined,
          });

const quoted = (doc: Document, key: string, value: unknown) => {
    const node = doc.createNode(value);
    if (key === "args" && isScalar(node)) node.type = Scalar.QUOTE_DOUBLE;
    return node;
};

/** Adds a test to a group at `index`, or at the end. */
export const addTest = (text: string, group: string, test: TestEdit, index?: number) =>
    edit(text, (doc, root) => {
        const seq = testsOf(doc, findGroup(root, group).map);
        const map = new YAMLMap();
        map.flow = isFlow(seq) || siblingFlow(seq, !("manual" in test));
        for (const [key, value] of Object.entries(testValue(test)))
            map.items.push(new Pair(doc.createNode(key), quoted(doc, key, value)) as never);
        seq.items.splice(index ?? seq.items.length, 0, map);
    });

/**
 * Replaces the test at `index` (0-based inside its group). Keys the editor does not know about
 * are kept.
 */
export const updateTest = (text: string, group: string, index: number, test: TestEdit) =>
    edit(text, (doc, root) => {
        const { map } = testAt(doc, root, group, index);
        const value = testValue(test);
        for (const key of KNOWN_TEST_KEYS)
            if (!(key in value)) deleteKey(map, key);
        for (const [key, item] of Object.entries(value)) {
            const pair = pairOf(map, key);
            if (pair && isScalar(pair.value)) pair.value.value = item;
            else setNode(doc, map, key, quoted(doc, key, item), TEST_ORDER);
        }
    });

export const removeTest = (text: string, group: string, index: number) =>
    edit(text, (doc, root) => {
        const { seq } = testAt(doc, root, group, index);
        removeItem(seq.items, index);
    });

/** Moves a test inside its group from `from` to `to` (0-based, clamped). */
export const moveTest = (text: string, group: string, from: number, to: number) =>
    edit(text, (doc, root) => move(testsOf(doc, findGroup(root, group).map).items, from, to));

// ---- solutions ----

export const addSolution = (text: string, solution: SolutionEdit) =>
    edit(text, (doc, root) => {
        const seq = seqAt(doc, root, "solutions", TOP_ORDER);
        if (solutionsOf(root).some((item) => stringAt(item, "path") === solution.path))
            throw new ManifestEditError(`${solution.path} is already a solution`);
        const flow = isFlow(seq) || siblingFlow(seq, true);
        seq.items.push(
            doc.createNode(
                clean({ path: solution.path, role: solution.role, expect: solution.expect }),
                { flow },
            ),
        );
    });

/** Changes a solution's fields; a key present with the value undefined is removed. */
export const updateSolution = (text: string, path: string, fields: Partial<SolutionEdit>) =>
    edit(text, (doc, root) => {
        const { map } = findSolution(root, path);
        if (fields.path !== undefined && fields.path !== path) {
            if (solutionsOf(root).some((item) => stringAt(item, "path") === fields.path))
                throw new ManifestEditError(`${fields.path} is already a solution`);
            setKey(doc, map, "path", fields.path, SOLUTION_ORDER);
        }
        if ("role" in fields) setKey(doc, map, "role", fields.role, SOLUTION_ORDER);
        if ("expect" in fields) {
            if (fields.expect === undefined) deleteKey(map, "expect");
            else if (typeof fields.expect === "object")
                setNode(doc, map, "expect", doc.createNode(fields.expect, { flow: true }), SOLUTION_ORDER);
            else setKey(doc, map, "expect", fields.expect, SOLUTION_ORDER);
        }
    });

export const removeSolution = (text: string, path: string) =>
    edit(text, (_doc, root) => {
        const { seq, index } = findSolution(root, path);
        removeItem(seq.items, index);
    });

/** Makes `path` the only main solution. The main solution is always AC, so its `expect` goes. */
export const setMainSolution = (text: string, path: string) =>
    edit(text, (doc, root) => {
        findSolution(root, path);
        for (const solution of solutionsOf(root)) {
            if (stringAt(solution, "path") === path) {
                setKey(doc, solution, "role", "main", SOLUTION_ORDER);
                deleteKey(solution, "expect");
            } else if (valueOf(solution, "role") === "main") deleteKey(solution, "role");
        }
    });

/**
 * Sets what a solution is expected to do on one group, or removes the expectation for that group
 * when `value` is undefined. A solution that states one expectation for every group (or none,
 * which means AC everywhere) is first expanded to one entry per group.
 */
export const setExpectation = (
    text: string,
    path: string,
    group: string,
    value: string | undefined,
) =>
    edit(text, (doc, root) => {
        const { map } = findSolution(root, path);
        let expect = optionalMap(map, "expect");
        if (!expect) {
            const current = valueOf(map, "expect");
            const all = typeof current === "string" ? current : "AC";
            const expanded: Record<string, string> = {};
            for (const item of groupsOf(root)) {
                const name = stringAt(item, "name");
                if (name !== undefined) expanded[name] = all;
            }
            expect = doc.createNode(expanded, { flow: true }) as YAMLMap;
            setNode(doc, map, "expect", expect, SOLUTION_ORDER);
        }
        const order = groupsOf(root).map((item) => stringAt(item, "name") ?? "");
        setKey(doc, expect, group, value, order);
    });

// ---- file references ----

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

type Reference = {
    path: string;
    set: (path: string) => void;
    remove: () => void;
};

/** Every place the manifest names a file, with how to change or drop it. */
const references = (doc: Document, root: YAMLMap): Reference[] => {
    const result: Reference[] = [];
    const scalarRef = (map: YAMLMap, key: string, remove: () => void) => {
        const value = stringAt(map, key);
        if (value === undefined) return;
        result.push({ path: value, set: (path) => setKey(doc, map, key, path), remove });
    };
    scalarRef(root, "validator", () => deleteKey(root, "validator"));
    scalarRef(root, "checker", () => deleteKey(root, "checker"));
    const generators = optionalMap(root, "generators");
    if (generators)
        for (const pair of generators.items as Pair[]) {
            const name = String(keyOf(pair));
            scalarRef(generators, name, () => {
                deleteKey(generators, name);
                // tests of a generator that is gone cannot be produced
                for (const group of groupsOf(root)) {
                    const tests = optionalSeq(group, "tests");
                    if (tests)
                        tests.items = tests.items.filter(
                            (item) => !(isMap(item) && stringAt(item, "gen") === name),
                        );
                }
            });
        }
    for (const group of groupsOf(root)) {
        const tests = optionalSeq(group, "tests");
        for (const test of mapsIn(tests)) {
            scalarRef(test, "manual", () => {
                const index = tests!.items.indexOf(test);
                if (index !== -1) removeItem(tests!.items, index);
            });
            scalarRef(test, "answer", () => deleteKey(test, "answer"));
        }
    }
    const solutions = optionalSeq(root, "solutions");
    for (const solution of mapsIn(solutions))
        scalarRef(solution, "path", () => {
            const index = solutions!.items.indexOf(solution);
            if (index !== -1) removeItem(solutions!.items, index);
        });
    const statements = optionalMap(root, "statements");
    if (statements)
        for (const pair of statements.items as Pair[]) {
            const language = String(keyOf(pair));
            scalarRef(statements, language, () => deleteKey(statements, language));
        }
    return result;
};

const trimSlashes = (path: string) => path.replace(/\/+$/, "");

/**
 * Updates every reference to `fromPath` after a rename: the validator, a checker given as a
 * path, generators, manual tests and their answers, solutions and statements. Renaming a
 * directory (`fromPath` is a prefix ending at a `/`) updates every path under it.
 */
export const renameReferences = (text: string, fromPath: string, toPath: string) =>
    edit(text, (doc, root) => {
        const from = trimSlashes(fromPath);
        const to = trimSlashes(toPath);
        if (!from || from === to) return;
        for (const ref of references(doc, root))
            if (under(ref.path, from)) ref.set(to + ref.path.slice(from.length));
    });

/**
 * Removes every reference to a deleted file or directory: the validator or checker is unset, a
 * generator is removed with the tests it produced, manual tests and solutions are removed, and
 * an answer file is dropped from its test.
 */
export const removeReferences = (text: string, path: string) =>
    edit(text, (doc, root) => {
        const target = trimSlashes(path);
        if (!target) return;
        // removing changes the document, so collect first and remove from the end
        const matches = references(doc, root).filter((ref) => under(ref.path, target));
        for (const ref of matches.reverse()) ref.remove();
    });

/** True when the manifest names `path` (or a path under it) anywhere. */
export const refersTo = (text: string, path: string): boolean => {
    const doc = load(text);
    const target = trimSlashes(path);
    return references(doc, doc.contents as YAMLMap).some((ref) => under(ref.path, target));
};

// ---- reading for editors ----

export type DraftTest = {
    manual?: string;
    answer?: string;
    gen?: string;
    args?: string;
    count?: number;
    desc?: string;
};
export type DraftGroup = {
    name: string;
    points?: number;
    aggregate?: string;
    sample: boolean;
    depends: string[];
    constraints: Record<string, BoundEdit>;
    tests: DraftTest[];
};
export type DraftSolution = {
    path: string;
    role?: string;
    expect?: string | Record<string, string>;
};
/**
 * A loose, read-only view of `problem.yaml` for editors. Unlike `parseManifest` it does not
 * apply defaults or reject unknown values, so a form can show a manifest that is still invalid.
 */
export type ManifestDraft = {
    name?: string;
    title?: string | Record<string, string>;
    type?: string;
    judge?: string;
    limits: { time_ms?: number; memory_mb?: number };
    scoring: { mode?: string };
    constraints: Record<string, BoundEdit>;
    validator?: string;
    /** A path, a built-in (`{ builtin, eps? }`) or anything else, kept as it is. */
    checker?: unknown;
    generators: Record<string, string>;
    groups: DraftGroup[];
    solutions: DraftSolution[];
    statements?: Record<string, string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) => (typeof value === "number" ? value : undefined);

const bounds = (value: unknown, where: string, problems: string[]) => {
    const result: Record<string, BoundEdit> = {};
    if (value === undefined || value === null) return result;
    if (!isRecord(value)) {
        problems.push(`${where} must be a mapping`);
        return result;
    }
    for (const [name, bound] of Object.entries(value))
        result[name] = isRecord(bound) ? clean({ min: num(bound.min), max: num(bound.max) }) : {};
    return result;
};

/**
 * Reads `problem.yaml` for a structured editor. Fails only when the text is not YAML or its
 * shape (lists and mappings) is not one a form can show.
 */
export const readManifestDraft = (
    text: string,
): { draft: ManifestDraft; problems: [] } | { draft: undefined; problems: string[] } => {
    const doc = parseDocument(text);
    if (doc.errors.length > 0)
        return {
            draft: undefined,
            problems: doc.errors.map((error) => `problem.yaml is not valid YAML: ${error.message}`),
        };
    const raw: unknown = doc.toJS() ?? {};
    if (!isRecord(raw)) return { draft: undefined, problems: ["problem.yaml must be a mapping"] };
    const problems: string[] = [];
    const list = (value: unknown, where: string): Record<string, unknown>[] => {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value) || !value.every(isRecord)) {
            problems.push(`${where} must be a list of mappings`);
            return [];
        }
        return value;
    };
    const record = (value: unknown, where: string): Record<string, unknown> => {
        if (value === undefined || value === null) return {};
        if (!isRecord(value)) {
            problems.push(`${where} must be a mapping`);
            return {};
        }
        return value;
    };
    const strings = (value: Record<string, unknown>) =>
        Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? item : ""]),
        );

    const limits = record(raw.limits, "limits");
    const scoring = record(raw.scoring, "scoring");
    const groups = list(raw.groups, "groups").map((group, index): DraftGroup => {
        const depends = group.depends;
        return {
            name: str(group.name) ?? "",
            points: num(group.points),
            aggregate: str(group.aggregate),
            sample: group.sample === true,
            depends: Array.isArray(depends) ? depends.filter((d) => typeof d === "string") : [],
            constraints: bounds(group.constraints, `groups.${index}.constraints`, problems),
            tests: list(group.tests, `groups.${index}.tests`).map((test) =>
                clean({
                    manual: str(test.manual),
                    answer: str(test.answer),
                    gen: str(test.gen),
                    args: str(test.args),
                    count: num(test.count),
                    desc: str(test.desc),
                }),
            ),
        };
    });
    const solutions = list(raw.solutions, "solutions").map(
        (solution): DraftSolution =>
            clean({
                path: str(solution.path) ?? "",
                role: str(solution.role),
                expect: isRecord(solution.expect)
                    ? strings(solution.expect)
                    : str(solution.expect),
            }),
    );
    const draft: ManifestDraft = {
        name: str(raw.name),
        title: isRecord(raw.title) ? strings(raw.title) : str(raw.title),
        type: str(raw.type),
        judge: str(raw.judge),
        limits: clean({ time_ms: num(limits.time_ms), memory_mb: num(limits.memory_mb) }),
        scoring: clean({ mode: str(scoring.mode) }),
        constraints: bounds(raw.constraints, "constraints", problems),
        validator: str(raw.validator),
        checker: raw.checker ?? undefined,
        generators: strings(record(raw.generators, "generators")),
        groups,
        solutions,
        statements: raw.statements === undefined ? undefined : strings(record(raw.statements, "statements")),
    };
    if (problems.length > 0) return { draft: undefined, problems };
    return { draft, problems: [] };
};
