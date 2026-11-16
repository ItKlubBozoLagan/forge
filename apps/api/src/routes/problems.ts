import { TEMPLATE_FORMATS, templateFiles } from "@forge/core";
import { FastifyInstance, FastifyReply } from "fastify";
import { unzipSync } from "fflate";
import { z } from "zod";

import { App } from "../app";
import { zipFiles } from "../zip";
import { importPolygon } from "../polygon";
import { Tree } from "../blobs";
import { audit, badRequest, can, conflict, currentUser, notFound, ProblemRow, requireProblem, requireWorkspace } from "../http";

const validPath = (path: unknown): path is string =>
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 200 &&
    /^[A-Za-z0-9._\-/]+$/.test(path) &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const pathOf = (query: unknown): string => {
    const path = (query as { path?: string }).path;
    if (!validPath(path)) throw badRequest("Invalid file path");
    return path;
};

const listTree = (tree: Tree) =>
    Object.entries(tree)
        .map(([path, entry]) => ({ path, hash: entry.hash, size: entry.size }))
        .sort((a, b) => a.path.localeCompare(b.path));

/** Applies a change to the working copy under a row lock and bumps its version. */
export const updateDraft = async (
    app: App,
    problemId: string,
    change: (tree: Tree) => Tree | Promise<Tree>,
): Promise<{ tree: Tree; version: number }> =>
    app.sql.begin(async (tx) => {
        const [row] = await tx<{ draft_tree: Tree; draft_version: number }[]>`
            select draft_tree, draft_version from problems where id = ${problemId} for update`;
        if (!row) throw notFound("Problem not found");
        const tree = await change({ ...row.draft_tree });
        const version = row.draft_version + 1;
        await tx`update problems set draft_tree = ${tx.json(tree as never)}, draft_version = ${version} where id = ${problemId}`;
        return { tree, version };
    });

/** The tree a request refers to: a revision when `revision` is given, else the working copy. */
export const resolveTree = async (app: App, problem: ProblemRow, revision: unknown): Promise<{ tree: Tree; revisionId?: string }> => {
    if (revision === undefined || revision === null || revision === "") return { tree: problem.draft_tree };
    if (!/^\d+$/.test(String(revision))) throw notFound("Revision not found");
    const [row] = await app.sql<{ id: string; tree: Tree }[]>`
        select id, tree from revisions where id = ${String(revision)} and problem_id = ${problem.id}`;
    if (!row) throw notFound("Revision not found");
    return { tree: row.tree, revisionId: row.id };
};

const POLYGON_MAX_ARCHIVE = 128 * 1024 * 1024;
const POLYGON_MAX_UNPACKED = 512 * 1024 * 1024;

/** Content types the browser needs to show a package file inline; everything else downloads. */
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
export const sendFile = (reply: FastifyReply, path: string, data: Buffer, hash: string) => {
    const type = IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
    reply.header("etag", hash).header("x-content-type-options", "nosniff");
    // an SVG is a document: sandboxed, it cannot run scripts against the app's origin
    if (type === "image/svg+xml") reply.header("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    return reply.header("content-type", type ?? "application/octet-stream").send(data);
};

/**
 * Blobs are stored per workspace, but access to a problem only covers its own content: files
 * of its working copy and revisions, what its builds produced, and what was uploaded for it.
 */
export const blobBelongs = async (app: App, problem: ProblemRow, hash: string): Promise<boolean> => {
    if (!/^[0-9a-f]{64}$/.test(hash)) return false;
    if (Object.values(problem.draft_tree).some((entry) => entry.hash === hash)) return true;
    const pattern = `%${hash}%`;
    const known = await app.sql`select 1 from problem_uploads where problem_id = ${problem.id} and hash = ${hash}`;
    if (known.length > 0) return true;
    // searching revisions and build reports is slow, so a hit is remembered
    const found = await app.sql`
        select 1 where exists (select 1 from revisions where problem_id = ${problem.id} and tree::text like ${pattern})
            or exists (select 1 from builds where problem_id = ${problem.id} and (report::text like ${pattern} or tree::text like ${pattern}))`;
    if (found.length === 0) return false;
    await app.sql`insert into problem_uploads (problem_id, hash) values (${problem.id}, ${hash}) on conflict do nothing`;
    return true;
};

export const problemRoutes = (server: FastifyInstance, app: App) => {
    server.get("/workspaces/:id/problems", async (req) => {
        const user = await currentUser(app, req);
        const { id } = req.params as { id: string };
        const role = await requireWorkspace(app, user.id, id);
        // members only see the problems they were added to
        return app.sql`
            select problems.id, problems.name, problems.title, problems.created_at as "createdAt",
                ${role === "owner" ? app.sql`'owner'` : app.sql`problem_access.role`} as role,
                (select count(*)::int from revisions where revisions.problem_id = problems.id) as revisions,
                (select result from builds where builds.problem_id = problems.id and kind = 'build' and status = 'done' order by id desc limit 1) as "lastResult"
            from problems
            left join problem_access on problem_access.problem_id = problems.id and problem_access.user_id = ${user.id}
            where problems.workspace_id = ${id} ${role === "owner" ? app.sql`` : app.sql`and problem_access.role is not null`}
            order by problems.id desc`;
    });

    server.post("/workspaces/:id/problems", async (req) => {
        const user = await currentUser(app, req);
        const { id } = req.params as { id: string };
        await requireWorkspace(app, user.id, id);
        const body = z
            .object({
                name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/, "Use lowercase letters, digits and dashes"),
                title: z.string().trim().min(1).max(120),
                template: z.enum(TEMPLATE_FORMATS).default("ioi"),
            })
            .safeParse(req.body);
        if (!body.success) throw badRequest(body.error.issues[0]?.message ?? "Invalid problem", body.error.issues);
        const taken = await app.sql`select 1 from problems where workspace_id = ${id} and name = ${body.data.name}`;
        if (taken.length > 0) throw conflict(`A problem named "${body.data.name}" already exists in this workspace`);

        const tree: Tree = {};
        for (const [path, content] of Object.entries(templateFiles(body.data.template, body.data.name, body.data.title)))
            tree[path] = await app.blobs.put(id, Buffer.from(content, "utf8"));
        const [problem] = await app.sql<{ id: string }[]>`
            insert into problems (workspace_id, name, title, draft_tree, created_by)
            values (${id}, ${body.data.name}, ${body.data.title}, ${app.sql.json(tree as never)}, ${user.id}) returning id`;
        await app.sql`insert into problem_access (problem_id, user_id, role) values (${problem!.id}, ${user.id}, 'owner')`;
        await audit(app, { workspaceId: id, problemId: problem!.id, userId: user.id, action: "problem.create", detail: { name: body.data.name, template: body.data.template } });
        return { id: problem!.id, name: body.data.name, title: body.data.title };
    });

    /** Creates a problem from a Polygon package: the zip Polygon offers for download. */
    server.post("/workspaces/:id/import/polygon", { bodyLimit: POLYGON_MAX_ARCHIVE }, async (req) => {
        const user = await currentUser(app, req);
        const { id } = req.params as { id: string };
        await requireWorkspace(app, user.id, id);
        if (!Buffer.isBuffer(req.body)) throw badRequest("Send the Polygon package as application/octet-stream");
        let imported;
        try {
            // Only what the importer reads is unpacked, and never more than a fixed amount: an
            // archive is small on the wire and can be huge once inflated.
            let total = 0;
            const wanted = /(^|\/)(problem\.xml|files\/[^/]+|solutions\/[^/]+|tests\/[^/]+|statements\/[^/]+\/problem-properties\.json)$/;
            const unpacked = unzipSync(new Uint8Array(req.body), {
                filter: (entry) => {
                    if (!wanted.test(entry.name) || /\.(exe|jar|class|o|a|pdf)$/i.test(entry.name)) return false;
                    if (entry.originalSize > app.config.maxFileBytes) return false;
                    total += entry.originalSize;
                    if (total > POLYGON_MAX_UNPACKED) throw new Error("the package unpacks to more than 512 MB");
                    return true;
                },
            });
            imported = importPolygon(unpacked);
        } catch (error) {
            throw badRequest(`The package could not be imported: ${(error as Error).message}`);
        }
        // a second import of the same problem gets a numbered name
        let name = imported.name;
        for (let attempt = 2; (await app.sql`select 1 from problems where workspace_id = ${id} and name = ${name}`).length > 0; attempt++)
            name = `${imported.name.slice(0, 56)}-${attempt}`;
        const tree: Tree = {};
        const skipped: string[] = [];
        for (const [path, content] of Object.entries(imported.files)) {
            if (content.length > app.config.maxFileBytes) {
                skipped.push(`${path} is larger than the file size limit and was not imported.`);
                continue;
            }
            const data = path === "problem.yaml" && name !== imported.name ? Buffer.from(Buffer.from(content).toString("utf8").replace(`name: ${imported.name}`, `name: ${name}`)) : Buffer.from(content);
            tree[path] = await app.blobs.put(id, data);
        }
        const [problem] = await app.sql<{ id: string }[]>`
            insert into problems (workspace_id, name, title, draft_tree, created_by)
            values (${id}, ${name}, ${imported.title.slice(0, 120)}, ${app.sql.json(tree as never)}, ${user.id}) returning id`;
        await app.sql`insert into problem_access (problem_id, user_id, role) values (${problem!.id}, ${user.id}, 'owner')`;
        await audit(app, { workspaceId: id, problemId: problem!.id, userId: user.id, action: "problem.import", detail: { name, from: "polygon" } });
        return { id: problem!.id, name, title: imported.title, notes: [...imported.notes, ...skipped] };
    });

    server.get("/problems/:id", async (req) => {
        const user = await currentUser(app, req);
        const { problem, role } = await requireProblem(app, user.id, (req.params as { id: string }).id, "participate");
        const [workspace] = await app.sql`select id, name, reference_class as "referenceClass" from workspaces where id = ${problem.workspace_id}`;
        const [head] = await app.sql<{ id: string; number: number; tree: Tree }[]>`
            select id, number, tree from revisions where problem_id = ${problem.id} order by number desc limit 1`;
        const dirty = !head || JSON.stringify(listTree(head.tree)) !== JSON.stringify(listTree(problem.draft_tree));
        return {
            id: problem.id,
            name: problem.name,
            title: problem.title,
            role,
            workspace,
            draftVersion: problem.draft_version,
            head: head ? { id: head.id, number: head.number } : null,
            /** Whether the working copy differs from the latest revision. */
            dirty: can(role, "read") ? dirty : undefined,
        };
    });

    server.patch("/problems/:id", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "write");
        const body = z.object({ title: z.string().trim().min(1).max(120) }).safeParse(req.body);
        if (!body.success) throw badRequest("A title is required");
        await app.sql`update problems set title = ${body.data.title} where id = ${problem.id}`;
        return { ok: true };
    });

    server.delete("/problems/:id", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "manage");
        const pinned = await app.sql`select 1 from problem_set_entries where problem_id = ${problem.id} limit 1`;
        if (pinned.length > 0) throw conflict("The problem is part of a problem set; remove it from the set first");
        await app.sql`delete from problems where id = ${problem.id}`;
        await audit(app, { workspaceId: problem.workspace_id, problemId: problem.id, userId: user.id, action: "problem.delete", detail: { name: problem.name } });
        return { ok: true };
    });

    // ---- access ----
    server.get("/problems/:id/access", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "read");
        return app.sql`
            select users.id, users.name, users.email, problem_access.role
            from problem_access join users on users.id = problem_access.user_id
            where problem_access.problem_id = ${problem.id} order by users.name`;
    });

    server.put("/problems/:id/access/:userId", async (req) => {
        const user = await currentUser(app, req);
        const { id, userId } = req.params as { id: string; userId: string };
        const { problem } = await requireProblem(app, user.id, id, "manage");
        const body = z.object({ role: z.enum(["owner", "author", "viewer", "tester"]) }).safeParse(req.body);
        if (!body.success || !/^\d+$/.test(userId)) throw badRequest("Invalid role");
        const member = await app.sql`select 1 from memberships where workspace_id = ${problem.workspace_id} and user_id = ${userId}`;
        if (member.length === 0) throw badRequest("That user is not a member of the workspace");
        await app.sql`
            insert into problem_access (problem_id, user_id, role) values (${problem.id}, ${userId}, ${body.data.role})
            on conflict (problem_id, user_id) do update set role = excluded.role`;
        await audit(app, { workspaceId: problem.workspace_id, problemId: problem.id, userId: user.id, action: "access.grant", detail: { user: userId, role: body.data.role } });
        return { ok: true };
    });

    server.delete("/problems/:id/access/:userId", async (req) => {
        const user = await currentUser(app, req);
        const { id, userId } = req.params as { id: string; userId: string };
        const { problem } = await requireProblem(app, user.id, id, "manage");
        if (!/^\d+$/.test(userId)) throw notFound();
        await app.sql`delete from problem_access where problem_id = ${problem.id} and user_id = ${userId}`;
        await audit(app, { workspaceId: problem.workspace_id, problemId: problem.id, userId: user.id, action: "access.revoke", detail: { user: userId } });
        return { ok: true };
    });

    // ---- files ----
    server.get("/problems/:id/tree", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "read");
        const { tree } = await resolveTree(app, problem, (req.query as { revision?: string }).revision);
        return { version: problem.draft_version, files: listTree(tree) };
    });

    server.get("/problems/:id/file", async (req, reply) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "read");
        const { tree } = await resolveTree(app, problem, (req.query as { revision?: string }).revision);
        const entry = tree[pathOf(req.query)];
        if (!entry) throw notFound("File not found");
        const data = await app.blobs.get(problem.workspace_id, entry.hash);
        if (!data) throw notFound("File not found");
        return sendFile(reply, pathOf(req.query), data, entry.hash);
    });

    /** The package as a zip: the working copy, or a revision. */
    server.get("/problems/:id/archive", async (req, reply) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "read");
        const { tree, revisionId } = await resolveTree(app, problem, (req.query as { revision?: string }).revision);
        const files: Record<string, Uint8Array> = {};
        for (const [path, entry] of Object.entries(tree)) {
            const data = await app.blobs.get(problem.workspace_id, entry.hash);
            if (data) files[path] = new Uint8Array(data);
        }
        let suffix = "";
        if (revisionId) {
            const [revision] = await app.sql<{ number: number }[]>`select number from revisions where id = ${revisionId}`;
            suffix = `-r${revision?.number ?? revisionId}`;
        }
        return reply
            .header("content-type", "application/zip")
            .header("content-disposition", `attachment; filename="${problem.name}${suffix}.zip"`)
            .send(await zipFiles(files));
    });

    server.get("/problems/:id/blobs/:hash", async (req, reply) => {
        const user = await currentUser(app, req);
        const { id, hash } = req.params as { id: string; hash: string };
        const { problem } = await requireProblem(app, user.id, id, "read");
        if (!(await blobBelongs(app, problem, hash))) throw notFound("Blob not found");
        const data = await app.blobs.get(problem.workspace_id, hash);
        if (!data) throw notFound("Blob not found");
        return reply.header("content-type", "application/octet-stream").send(data);
    });

    /** Uploads content without touching the working copy; `sync` then refers to it by hash. */
    server.post("/problems/:id/blobs", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "write");
        if (!Buffer.isBuffer(req.body)) throw badRequest("Send the content as application/octet-stream");
        const entry = await app.blobs.put(problem.workspace_id, req.body);
        await app.sql`insert into problem_uploads (problem_id, hash) values (${problem.id}, ${entry.hash}) on conflict do nothing`;
        return entry;
    });

    server.put("/problems/:id/file", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "write");
        const path = pathOf(req.query);
        if (!Buffer.isBuffer(req.body)) throw badRequest("Send the file content as application/octet-stream");
        const entry = await app.blobs.put(problem.workspace_id, req.body);
        // If-Match carries the hash the editor loaded, so a concurrent edit is not overwritten
        const expected = req.headers["if-match"];
        const result = await updateDraft(app, problem.id, (tree) => {
            const current = tree[path]?.hash;
            if (typeof expected === "string" && expected !== "*" && current !== undefined && current !== expected && current !== entry.hash)
                throw conflict(`${path} was changed by someone else`, { path, current });
            tree[path] = entry;
            return tree;
        });
        return { ...entry, version: result.version };
    });

    server.delete("/problems/:id/file", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "write");
        const path = pathOf(req.query);
        const result = await updateDraft(app, problem.id, (tree) => {
            if (!tree[path]) throw notFound("File not found");
            delete tree[path];
            return tree;
        });
        return { version: result.version };
    });

    server.post("/problems/:id/rename", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "write");
        const body = req.body as { from?: string; to?: string };
        if (!validPath(body?.from) || !validPath(body?.to)) throw badRequest("Invalid file path");
        const { from, to } = body as { from: string; to: string };
        const result = await updateDraft(app, problem.id, (tree) => {
            if (!tree[from]) throw notFound("File not found");
            if (tree[to]) throw conflict(`${to} already exists`);
            tree[to] = tree[from]!;
            delete tree[from];
            return tree;
        });
        return { version: result.version };
    });

    /**
     * Applies a set of changes atomically (the CLI's push). Each change names the hash the
     * client last saw for the path; a path that moved on the server since is a conflict and
     * nothing is applied.
     */
    server.post("/problems/:id/sync", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "write");
        const hash = z.string().regex(/^[0-9a-f]{64}$/).nullable();
        const body = z
            .object({ changes: z.array(z.object({ path: z.string(), base: hash, hash })).max(5000), force: z.boolean().default(false) })
            .safeParse(req.body);
        if (!body.success) throw badRequest("Invalid sync request");
        const entries = new Map<string, { hash: string; size: number }>();
        for (const change of body.data.changes) {
            if (!validPath(change.path)) throw badRequest(`Invalid file path "${change.path}"`);
            if (change.hash === null) continue;
            const size = (await blobBelongs(app, problem, change.hash)) ? await app.blobs.has(problem.workspace_id, change.hash) : undefined;
            if (size === undefined) throw badRequest(`Content of ${change.path} has not been uploaded`, { path: change.path });
            entries.set(change.path, { hash: change.hash, size });
        }
        const result = await updateDraft(app, problem.id, (tree) => {
            const conflicts = body.data.force
                ? []
                : body.data.changes.filter((change) => {
                      const current = tree[change.path]?.hash ?? null;
                      return current !== change.base && current !== change.hash;
                  });
            if (conflicts.length > 0)
                throw conflict(
                    "The working copy changed on the server",
                    conflicts.map((change) => ({ path: change.path, current: tree[change.path]?.hash ?? null })),
                );
            for (const change of body.data.changes) {
                if (change.hash === null) delete tree[change.path];
                else tree[change.path] = entries.get(change.path)!;
            }
            return tree;
        });
        return { version: result.version, files: listTree(result.tree) };
    });

    // ---- revisions ----
    server.get("/problems/:id/revisions", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "read");
        return app.sql`
            select revisions.id, revisions.number, revisions.message, revisions.created_at as "createdAt", users.name as author,
                (select row_to_json(b) from (
                    select id, status, result from builds
                    where builds.revision_id = revisions.id and kind = 'build' order by id desc limit 1
                ) b) as build
            from revisions join users on users.id = revisions.author_id
            where revisions.problem_id = ${problem.id} order by revisions.number desc`;
    });

    /** Freezes the working copy as an immutable revision and builds it. */
    server.post("/problems/:id/revisions", async (req) => {
        const user = await currentUser(app, req);
        const { problem } = await requireProblem(app, user.id, (req.params as { id: string }).id, "write");
        const body = z.object({ message: z.string().trim().min(1).max(500) }).safeParse(req.body);
        if (!body.success) throw badRequest("A message describing the change is required");
        const revision = await app.sql.begin(async (tx) => {
            const [current] = await tx<{ draft_tree: Tree }[]>`select draft_tree from problems where id = ${problem.id} for update`;
            const [head] = await tx<{ id: string; number: number; tree: Tree }[]>`
                select id, number, tree from revisions where problem_id = ${problem.id} order by number desc limit 1`;
            if (head && JSON.stringify(listTree(head.tree)) === JSON.stringify(listTree(current!.draft_tree)))
                throw conflict("Nothing changed since the latest revision");
            const [created] = await tx<{ id: string; number: number }[]>`
                insert into revisions (problem_id, number, parent_id, tree, message, author_id)
                values (${problem.id}, ${(head?.number ?? 0) + 1}, ${head?.id ?? null}, ${tx.json(current!.draft_tree as never)}, ${body.data.message}, ${user.id})
                returning id, number`;
            const [build] = await tx<{ id: string }[]>`
                insert into builds (problem_id, revision_id, kind, tree, created_by)
                values (${problem.id}, ${created!.id}, 'build', ${tx.json(current!.draft_tree as never)}, ${user.id}) returning id`;
            return { ...created!, buildId: build!.id };
        });
        app.worker.kick();
        await audit(app, { workspaceId: problem.workspace_id, problemId: problem.id, userId: user.id, action: "revision.create", detail: { number: revision.number, message: body.data.message } });
        return revision;
    });

    server.post("/problems/:id/revisions/:revision/restore", async (req) => {
        const user = await currentUser(app, req);
        const { id, revision } = req.params as { id: string; revision: string };
        const { problem } = await requireProblem(app, user.id, id, "write");
        const { tree } = await resolveTree(app, problem, revision);
        const result = await updateDraft(app, problem.id, () => ({ ...tree }));
        await audit(app, { workspaceId: problem.workspace_id, problemId: problem.id, userId: user.id, action: "revision.restore", detail: { revision } });
        return { version: result.version };
    });
};
