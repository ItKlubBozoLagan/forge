import { LANGUAGES, MANIFEST_PATH, renderStatement, Sample } from "@forge/core";
import { FastifyInstance } from "fastify";
import { isMap, isSeq, parseDocument } from "yaml";
import { z } from "zod";

import { App } from "../app";
import { Tree } from "../blobs";
import { BuildOutput, Engine } from "../engine/engine";
import { StressOutput } from "../engine/stress";
import { audit, badRequest, can, conflict, currentUser, forbidden, notFound, ProblemRow, requireProblem } from "../http";
import { resolveTree, updateDraft } from "./problems";

type BuildRecord = {
    id: string;
    problem_id: string;
    revision_id: string | null;
    kind: "build" | "invocation" | "stress";
    tree: Tree;
    params: Record<string, unknown>;
    status: string;
    result: string | null;
    progress: unknown;
    report: unknown;
    error: string | null;
    created_by: string;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
};

const summary = (build: BuildRecord) => ({
    id: build.id,
    kind: build.kind,
    revisionId: build.revision_id,
    status: build.status,
    result: build.result,
    progress: build.progress,
    error: build.error ? build.error.split("\n")[0] : null,
    createdBy: build.created_by,
    createdAt: build.created_at,
    startedAt: build.started_at,
    finishedAt: build.finished_at,
});

/** What a blind tester may see of their own invocation: outcomes per group, nothing else. */
const redact = (output: BuildOutput | null) =>
    output && {
        report: {
            status: output.report.status,
            solutions: output.report.solutions,
            calibration: { timeLimitMs: output.report.calibration.timeLimitMs },
            kills: [],
            decisiveTests: [],
            issues: output.report.issues.filter((issue) => issue.code.startsWith("run.")),
        },
        groups: output.groups.map((group) => ({ name: group.name, points: group.points, sample: group.sample })),
        limits: output.limits,
    };

const headRevision = async (app: App, problemId: string) => {
    const [head] = await app.sql<{ id: string; tree: Tree }[]>`
        select id, tree from revisions where problem_id = ${problemId} order by number desc limit 1`;
    return head;
};

export const buildRoutes = (server: FastifyInstance, app: App) => {
    const queue = async (problem: ProblemRow, userId: string, kind: string, tree: Tree, revisionId: string | undefined, params: object) => {
        const [build] = await app.sql<{ id: string }[]>`
            insert into builds (problem_id, revision_id, kind, tree, params, created_by)
            values (${problem.id}, ${revisionId ?? null}, ${kind}, ${app.sql.json(tree as never)}, ${app.sql.json(params as never)}, ${userId})
            returning id`;
        app.worker.kick();
        return { id: build!.id };
    };

    server.post("/problems/:id/builds", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "write");
        const body = z.object({ revision: z.string().optional(), remeasure: z.boolean().default(false) }).safeParse(req.body ?? {});
        if (!body.success) throw badRequest("Invalid build request");
        const { tree, revisionId } = await resolveTree(app, problem, body.data.revision);
        return queue(problem, user.id, "build", tree, revisionId, { remeasure: body.data.remeasure });
    });

    server.get("/problems/:id/builds", async (req) => {
        const user = await currentUser(app, req);
        const { problem, role } = await requireProblem(app, user.id, (req.params as { id: string }).id, "participate");
        const kind = (req.query as { kind?: string }).kind;
        const blind = !can(role, "read");
        const rows = await app.sql<BuildRecord[]>`
            select id, problem_id, revision_id, kind, params, status, result, progress, error, created_by, created_at, started_at, finished_at
            from builds where problem_id = ${problem.id}
                ${kind ? app.sql`and kind = ${kind}` : app.sql``}
                ${blind ? app.sql`and kind = 'invocation' and created_by = ${user.id}` : app.sql``}
            order by id desc limit 50`;
        return rows.map((row) => ({ ...summary(row), name: (row.params as { adhoc?: { name?: string } }).adhoc?.name }));
    });

    const loadBuild = async (userId: string, id: string) => {
        if (!/^\d+$/.test(id)) throw notFound("Build not found");
        const [build] = await app.sql<BuildRecord[]>`select * from builds where id = ${id}`;
        if (!build) throw notFound("Build not found");
        const { problem, role } = await requireProblem(app, userId, build.problem_id, "participate");
        const blind = !can(role, "read");
        if (blind && (build.kind !== "invocation" || build.created_by !== userId)) throw notFound("Build not found");
        return { build, problem, blind };
    };

    server.get("/builds/:id", async (req) => {
        const user = await currentUser(app, req);
        const { build, blind } = await loadBuild(user.id, (req.params as { id: string }).id);
        const output = build.report as BuildOutput | null;
        return {
            ...summary(build),
            params: blind ? undefined : { ...build.params, adhoc: undefined },
            name: (build.params as { adhoc?: { name?: string } }).adhoc?.name,
            output: blind ? redact(output) : output,
        };
    });

    /** Timing samples behind a build's runs, grouped by the hardware they were measured on. */
    server.get("/builds/:id/timing", async (req) => {
        const user = await currentUser(app, req);
        const { build, problem, blind } = await loadBuild(user.id, (req.params as { id: string }).id);
        if (blind) throw forbidden();
        const output = build.report as BuildOutput | null;
        const keys = [...new Set(Object.values(output?.runKeys ?? {}).flatMap((row) => Object.values(row)))];
        const stats = new Map<string, unknown[]>();
        for (let offset = 0; offset < keys.length; offset += 1000) {
            const rows = await app.sql<{ node_key: string }[]>`
                select node_key, hardware_class as "hardwareClass", count(*)::int as count, min(time_ms) as min, max(time_ms) as max,
                    percentile_cont(0.5) within group (order by time_ms)::int as median
                from timing_samples where workspace_id = ${problem.workspace_id} and node_key in ${app.sql(keys.slice(offset, offset + 1000))}
                group by node_key, hardware_class`;
            for (const { node_key: key, ...rest } of rows) stats.set(key, [...(stats.get(key) ?? []), rest]);
        }
        const samples: Record<string, Record<string, unknown[]>> = {};
        for (const [solution, row] of Object.entries(output?.runKeys ?? {})) {
            samples[solution] = {};
            for (const [test, key] of Object.entries(row)) samples[solution]![test] = stats.get(key) ?? [];
        }
        const [workspace] = await app.sql<{ reference_class: string | null }[]>`select reference_class from workspaces where id = ${problem.workspace_id}`;
        return { referenceClass: workspace?.reference_class ?? null, samples };
    });

    /**
     * Runs a solution that is not part of the package against the tests. Blind testers use
     * this to test a problem without seeing its solutions or data: they always run against
     * the latest revision and only get per-group outcomes back. Everyone else runs against
     * the working copy unless they name a revision.
     */
    server.post("/problems/:id/invocations", async (req) => {
        const user = await currentUser(app, req);
        const { problem, role } = await requireProblem(app, user.id, (req.params as { id: string }).id, "participate");
        const body = z
            .object({
                name: z.string().trim().min(1).max(80),
                language: z.enum(LANGUAGES),
                source: z.string().min(1).max(256 * 1024),
                revision: z.string().optional(),
            })
            .safeParse(req.body);
        if (!body.success) throw badRequest("A name, language and source are required");
        const head = await headRevision(app, problem.id);
        let target: { tree: Tree; revisionId?: string };
        if (!can(role, "read")) {
            if (!head) throw conflict("The problem has no revision to test yet");
            target = { tree: head.tree, revisionId: head.id };
        } else target = await resolveTree(app, problem, body.data.revision);
        const { name, language, source } = body.data;
        await audit(app, { workspaceId: problem.workspace_id, problemId: problem.id, userId: user.id, action: "invocation.run", detail: { name, language } });
        return queue(problem, user.id, "invocation", target.tree, target.revisionId, { adhoc: { name, language, source } });
    });

    server.post("/problems/:id/stress", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "write");
        const body = z
            .object({
                generator: z.string(),
                args: z.string().max(500),
                count: z.number().int().min(1).max(500),
                seedStart: z.number().int().min(0).max(1_000_000_000).default(1),
                solution: z.string(),
                group: z.string(),
            })
            .safeParse(req.body);
        if (!body.success) throw badRequest("Invalid stress request", body.error.issues);
        return queue(problem, user.id, "stress", problem.draft_tree, undefined, body.data);
    });

    /** Adds a failing stress case to the working copy's test plan. */
    server.post("/builds/:id/promote", async (req) => {
        const user = await currentUser(app, req);
        const { build, problem } = await loadBuild(user.id, (req.params as { id: string }).id);
        await requireProblem(app, user.id, problem.id, "write");
        if (build.kind !== "stress") throw badRequest("Only stress runs have cases to promote");
        const body = z.object({ args: z.string() }).safeParse(req.body);
        const params = build.params as { generator: string; group: string };
        const output = build.report as StressOutput | null;
        if (!body.success || !output?.failures.some((failure) => failure.args === body.data.args))
            throw badRequest("That case is not a failure of this stress run");
        const result = await updateDraft(app, problem.id, async (tree) => {
            const entry = tree[MANIFEST_PATH];
            if (!entry) throw conflict("The working copy has no problem.yaml");
            const document = parseDocument(await app.blobs.text(problem.workspace_id, entry.hash));
            const groups = document.get("groups");
            const group = isSeq(groups) ? groups.items.find((item) => isMap(item) && item.get("name") === params.group) : undefined;
            if (!isMap(group)) throw conflict(`Group "${params.group}" is no longer in problem.yaml`);
            let tests = group.get("tests");
            if (!isSeq(tests)) {
                tests = document.createNode([]);
                group.set("tests", tests);
            }
            const node = document.createNode({ gen: params.generator, args: body.data.args });
            (node as { flow?: boolean }).flow = true;
            (tests as { add(value: unknown): void }).add(node);
            tree[MANIFEST_PATH] = await app.blobs.put(problem.workspace_id, Buffer.from(document.toString(), "utf8"));
            return tree;
        });
        await audit(app, { workspaceId: problem.workspace_id, problemId: problem.id, userId: user.id, action: "stress.promote", detail: { ...params, args: body.data.args } });
        return { version: result.version };
    });

    /** The statement with constraints, limits and samples filled in from the package. */
    server.get("/problems/:id/statement", async (req) => {
        const user = await currentUser(app, req);
        const { problem, role } = await requireProblem(app, user.id, (req.params as { id: string }).id, "participate");
        const query = req.query as { lang?: string; revision?: string };
        let target: { tree: Tree; revisionId?: string };
        if (!can(role, "read")) {
            const head = await headRevision(app, problem.id);
            if (!head) return { languages: [], language: null, markdown: "", unresolved: [], samplesBuilt: false };
            target = { tree: head.tree, revisionId: head.id };
        } else target = await resolveTree(app, problem, query.revision);

        const engine = new Engine({ workspaceId: problem.workspace_id, tree: target.tree, blobs: app.blobs, sql: app.sql, runner: app.runner, scheduler: app.scheduler });
        const { plan } = await engine.plan();
        const languages = Object.keys(plan?.statements ?? {}).sort();
        const language = query.lang && languages.includes(query.lang) ? query.lang : (languages.includes("en") ? "en" : languages[0]);
        if (!plan || !language) return { languages, language: null, markdown: "", unresolved: [], samplesBuilt: false };

        // samples come from the latest finished build of exactly this tree
        const [build] = await app.sql<{ report: BuildOutput }[]>`
            select report from builds
            where problem_id = ${problem.id} and kind = 'build' and status = 'done' and tree = ${app.sql.json(target.tree as never)}
            order by id desc limit 1`;
        const samples: Sample[] = [];
        const sampleGroups = new Set(plan.groups.filter((group) => group.sample).map((group) => group.name));
        for (const test of build?.report.tests ?? []) {
            if (!sampleGroups.has(test.group) || !test.inputHash || !test.answerHash) continue;
            samples.push({
                input: await app.blobs.text(problem.workspace_id, test.inputHash),
                output: await app.blobs.text(problem.workspace_id, test.answerHash),
            });
        }
        const text = await app.blobs.text(problem.workspace_id, target.tree[plan.statements[language]!]!.hash);
        const rendered = renderStatement(text, plan.manifest, Object.fromEntries(plan.groups.map((group) => [group.name, group.constraints])), samples);
        return {
            languages,
            language,
            markdown: rendered.markdown,
            unresolved: rendered.unresolved,
            samplesBuilt: build !== undefined,
            limits: plan.manifest.limits,
            groups: plan.groups.map((group) => ({ name: group.name, points: group.points, sample: group.sample })),
        };
    });
};
