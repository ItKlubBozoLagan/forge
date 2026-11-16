import { renderStatement, withPrelude } from "@forge/core";
import { FastifyInstance } from "fastify";
import { strToU8 } from "fflate";
import { z } from "zod";

import { App } from "../app";
import { zipFiles } from "../zip";
import { Tree } from "../blobs";
import { BuildOutput, Engine } from "../engine/engine";
import { audit, badRequest, conflict, currentUser, forbidden, notFound, requireProblem, requireWorkspace } from "../http";

type SetRow = { id: string; workspace_id: string; name: string; created_by: string };

export const setRoutes = (server: FastifyInstance, app: App) => {
    // A problem set reveals which problems exist, so it is visible to workspace owners and
    // to the member who created it.
    const loadSet = async (userId: string, id: string) => {
        if (!/^\d+$/.test(id)) throw notFound("Problem set not found");
        const [set] = await app.sql<SetRow[]>`select * from problem_sets where id = ${id}`;
        if (!set) throw notFound("Problem set not found");
        const role = await requireWorkspace(app, userId, set.workspace_id).catch(() => undefined);
        if (!role || (role !== "owner" && set.created_by !== userId)) throw notFound("Problem set not found");
        return set;
    };

    const entriesOf = (setId: string) =>
        app.sql<{ label: string; problemId: string; revisionId: string; name: string; title: string; number: number; result: string | null; status: string | null }[]>`
            select e.label, e.problem_id as "problemId", e.revision_id as "revisionId", p.name, p.title, r.number,
                (select result from builds b where b.revision_id = r.id and b.kind = 'build' order by b.id desc limit 1) as result,
                (select status from builds b where b.revision_id = r.id and b.kind = 'build' order by b.id desc limit 1) as status
            from problem_set_entries e join problems p on p.id = e.problem_id join revisions r on r.id = e.revision_id
            where e.set_id = ${setId} order by e.position`;

    server.get("/workspaces/:id/sets", async (req) => {
        const user = await currentUser(app, req);
        const { id } = req.params as { id: string };
        const role = await requireWorkspace(app, user.id, id);
        return app.sql`
            select id, name, created_at as "createdAt",
                (select count(*)::int from problem_set_entries where set_id = problem_sets.id) as problems
            from problem_sets where workspace_id = ${id} ${role === "owner" ? app.sql`` : app.sql`and created_by = ${user.id}`}
            order by id desc`;
    });

    server.post("/workspaces/:id/sets", async (req) => {
        const user = await currentUser(app, req);
        const { id } = req.params as { id: string };
        await requireWorkspace(app, user.id, id);
        const body = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(req.body);
        if (!body.success) throw badRequest("A name is required");
        const [set] = await app.sql<{ id: string }[]>`
            insert into problem_sets (workspace_id, name, created_by) values (${id}, ${body.data.name}, ${user.id}) returning id`;
        await audit(app, { workspaceId: id, userId: user.id, action: "set.create", detail: { name: body.data.name } });
        return { id: set!.id, name: body.data.name };
    });

    server.get("/sets/:id", async (req) => {
        const user = await currentUser(app, req);
        const set = await loadSet(user.id, (req.params as { id: string }).id);
        return { id: set.id, name: set.name, workspaceId: set.workspace_id, entries: await entriesOf(set.id) };
    });

    server.delete("/sets/:id", async (req) => {
        const user = await currentUser(app, req);
        const set = await loadSet(user.id, (req.params as { id: string }).id);
        await app.sql`delete from problem_sets where id = ${set.id}`;
        return { ok: true };
    });

    /** Replaces the set's entries; each entry pins one revision of one problem. */
    server.put("/sets/:id/entries", async (req) => {
        const user = await currentUser(app, req);
        const set = await loadSet(user.id, (req.params as { id: string }).id);
        const body = z
            .object({
                entries: z
                    .array(z.object({ label: z.string().regex(/^[A-Za-z0-9]{1,8}$/), problemId: z.string().regex(/^\d+$/), revisionId: z.string().regex(/^\d+$/) }))
                    .max(100),
            })
            .safeParse(req.body);
        if (!body.success) throw badRequest("Invalid entries");
        const labels = new Set(body.data.entries.map((entry) => entry.label));
        if (labels.size !== body.data.entries.length) throw badRequest("Labels must be unique");
        for (const entry of body.data.entries) {
            const { problem } = await requireProblem(app, user.id, entry.problemId, "read");
            if (problem.workspace_id !== set.workspace_id) throw badRequest("Problems must belong to the set's workspace");
            const revision = await app.sql`select 1 from revisions where id = ${entry.revisionId} and problem_id = ${entry.problemId}`;
            if (revision.length === 0) throw badRequest(`Revision ${entry.revisionId} does not belong to problem ${entry.problemId}`);
        }
        await app.sql.begin(async (tx) => {
            await tx`delete from problem_set_entries where set_id = ${set.id}`;
            for (const [position, entry] of body.data.entries.entries())
                await tx`insert into problem_set_entries (set_id, label, problem_id, revision_id, position)
                    values (${set.id}, ${entry.label}, ${entry.problemId}, ${entry.revisionId}, ${position})`;
        });
        await audit(app, { workspaceId: set.workspace_id, userId: user.id, action: "set.update", detail: { set: set.id, entries: body.data.entries } });
        return { entries: await entriesOf(set.id) };
    });

    /**
     * The judge bundle: everything a judge needs to run the contest, frozen. Only revisions
     * whose build is green can be exported.
     */
    server.get("/sets/:id/export", async (req, reply) => {
        const user = await currentUser(app, req);
        const set = await loadSet(user.id, (req.params as { id: string }).id);
        const role = await requireWorkspace(app, user.id, set.workspace_id);
        if (role !== "owner") throw forbidden("Only workspace owners can export a judge bundle");
        const entries = await entriesOf(set.id);
        if (entries.length === 0) throw conflict("The problem set is empty");
        const blocked = entries.filter((entry) => entry.result !== "green");
        if (blocked.length > 0)
            throw conflict(
                "Every pinned revision needs a green build before export",
                blocked.map((entry) => ({ label: entry.label, problem: entry.name, revision: entry.number, result: entry.result ?? entry.status ?? "not built" })),
            );

        const files: Record<string, Uint8Array> = {};
        const problems = [];
        for (const entry of entries) {
            const [revision] = await app.sql<{ tree: Tree }[]>`select tree from revisions where id = ${entry.revisionId}`;
            const [build] = await app.sql<{ report: BuildOutput }[]>`
                select report from builds where revision_id = ${entry.revisionId} and kind = 'build' and status = 'done' order by id desc limit 1`;
            const tree = revision!.tree;
            const output = build!.report;
            const engine = new Engine({ workspaceId: set.workspace_id, tree, blobs: app.blobs, sql: app.sql, runner: app.runner, scheduler: app.scheduler });
            const { plan } = await engine.plan();
            if (!plan) throw conflict(`Revision ${entry.number} of ${entry.name} no longer parses`);
            const base = `${entry.label}/`;
            const read = (hash: string) => app.blobs.get(set.workspace_id, hash).then((data) => new Uint8Array(data ?? Buffer.alloc(0)));

            const tests = [];
            for (const test of output.tests) {
                const stem = `tests/${test.group}-${String(test.index).padStart(3, "0")}`;
                files[`${base}${stem}.in`] = await read(test.inputHash!);
                files[`${base}${stem}.out`] = await read(test.answerHash!);
                tests.push({ id: test.id, group: test.group, input: `${stem}.in`, output: `${stem}.out` });
            }
            const samples = [];
            for (const test of output.tests) {
                if (!plan.groups.find((group) => group.name === test.group)?.sample) continue;
                samples.push({
                    input: await app.blobs.text(set.workspace_id, test.inputHash!),
                    output: await app.blobs.text(set.workspace_id, test.answerHash!),
                });
            }
            const statements: Record<string, string> = {};
            const constraints = Object.fromEntries(plan.groups.map((group) => [group.name, group.constraints]));
            for (const [language, path] of Object.entries(plan.statements)) {
                const text = await app.blobs.text(set.workspace_id, tree[path]!.hash);
                files[`${base}statement/${language}.md`] = strToU8(renderStatement(text, plan.manifest, constraints, samples).markdown);
                statements[language] = `statement/${language}.md`;
            }
            // images and other files a statement links to
            for (const [path, entry] of Object.entries(tree))
                if (path.startsWith("statement/") && !path.endsWith(".md")) files[`${base}${path}`] = await read(entry.hash);
            let checker;
            const checkerProgram = await engine.checker(plan);
            if (checkerProgram) {
                const extension = plan.checker ? plan.checker.path.split(".").pop() : "py";
                const name = `checker.${extension}`;
                // constraints, testlib and built-in checkers are baked in, so the judge needs nothing else
                files[`${base}${name}`] = strToU8(checkerProgram.source);
                checker = { path: name, language: checkerProgram.language };
            }
            // kontestis stores a reference solution with every problem
            let solution = null;
            if (plan.main?.language) {
                const name = `solution.${plan.main.path.split(".").pop()}`;
                files[`${base}${name}`] = await read(tree[plan.main.path]!.hash);
                solution = { path: name, language: plan.main.language };
            }
            const title = plan.manifest.title;
            const description = {
                label: entry.label,
                name: entry.name,
                title: typeof title === "string" ? title : (title?.en ?? entry.title),
                revision: entry.number,
                type: plan.manifest.type,
                limits: plan.manifest.limits,
                scoring: plan.manifest.scoring.mode,
                checker: checker ?? null,
                solution,
                titles: typeof title === "string" || !title ? {} : title,
                groups: plan.groups.map((group) => ({
                    name: group.name,
                    points: group.points,
                    aggregate: group.aggregate,
                    sample: group.sample,
                    depends: group.depends,
                    tests: group.closure,
                })),
                tests,
                statements,
            };
            files[`${base}problem.json`] = strToU8(JSON.stringify(description, null, 2));
            problems.push({ label: entry.label, name: entry.name, revision: entry.number });
        }
        files["bundle.json"] = strToU8(JSON.stringify({ format: "forge-bundle/1", name: set.name, problems }, null, 2));
        await audit(app, { workspaceId: set.workspace_id, userId: user.id, action: "set.export", detail: { set: set.id, problems } });
        const archive = await zipFiles(files);
        return reply
            .header("content-type", "application/zip")
            .header("content-disposition", `attachment; filename="${set.name.replace(/[^A-Za-z0-9._-]+/g, "-")}.zip"`)
            .send(archive);
    });
};
