import { FastifyInstance } from "fastify";
import { z } from "zod";

import { App } from "../app";
import { resolveTree } from "./problems";
import { badRequest, can, currentUser, forbidden, notFound, requireProblem } from "../http";

export const reviewRoutes = (server: FastifyInstance, app: App) => {
    server.get("/problems/:id/threads", async (req) => {
        const user = await currentUser(app, req);
        const { problem, role } = await requireProblem(app, user.id, (req.params as { id: string }).id, "participate");
        // blind testers only see threads that are not anchored to a file
        const blind = !can(role, "read");
        return app.sql`
            select threads.id, threads.path, threads.line, threads.resolved, threads.revision_id as "revisionId",
                threads.created_at as "createdAt",
                (select coalesce(json_agg(json_build_object('id', c.id, 'body', c.body, 'author', u.name, 'authorId', u.id, 'createdAt', c.created_at) order by c.id), '[]')
                    from comments c join users u on u.id = c.author_id where c.thread_id = threads.id) as comments
            from threads where threads.problem_id = ${problem.id} ${blind ? app.sql`and threads.path is null` : app.sql``}
            order by threads.resolved, threads.id desc`;
    });

    server.post("/problems/:id/threads", async (req) => {
        const user = await currentUser(app, req);
        const { problem, role } = await requireProblem(app, user.id, (req.params as { id: string }).id, "participate");
        const body = z
            .object({
                body: z.string().trim().min(1).max(10_000),
                path: z.string().max(200).optional(),
                line: z.number().int().min(1).optional(),
                revision: z.string().regex(/^\d+$/).optional(),
            })
            .safeParse(req.body);
        if (!body.success) throw badRequest("A comment is required");
        if (body.data.path && !can(role, "read")) throw forbidden();
        // an anchor has to point at something that exists in this problem
        if (body.data.path || body.data.revision) {
            const { tree } = await resolveTree(app, problem, body.data.revision);
            if (body.data.path && !tree[body.data.path]) throw badRequest(`${body.data.path} is not a file of this problem`);
        }
        const thread = await app.sql.begin(async (tx) => {
            const [created] = await tx<{ id: string }[]>`
                insert into threads (problem_id, revision_id, path, line, created_by)
                values (${problem.id}, ${body.data.revision ?? null}, ${body.data.path ?? null}, ${body.data.line ?? null}, ${user.id}) returning id`;
            await tx`insert into comments (thread_id, author_id, body) values (${created!.id}, ${user.id}, ${body.data.body})`;
            return created!;
        });
        return { id: thread.id };
    });

    const loadThread = async (userId: string, id: string) => {
        if (!/^\d+$/.test(id)) throw notFound("Thread not found");
        const [thread] = await app.sql<{ id: string; problem_id: string; path: string | null }[]>`select id, problem_id, path from threads where id = ${id}`;
        if (!thread) throw notFound("Thread not found");
        const { role } = await requireProblem(app, userId, thread.problem_id, "participate");
        if (thread.path && !can(role, "read")) throw notFound("Thread not found");
        return thread;
    };

    server.post("/threads/:id/comments", async (req) => {
        const user = await currentUser(app, req);
        const thread = await loadThread(user.id, (req.params as { id: string }).id);
        const body = z.object({ body: z.string().trim().min(1).max(10_000) }).safeParse(req.body);
        if (!body.success) throw badRequest("A comment is required");
        await app.sql`insert into comments (thread_id, author_id, body) values (${thread.id}, ${user.id}, ${body.data.body})`;
        return { ok: true };
    });

    server.patch("/threads/:id", async (req) => {
        const user = await currentUser(app, req);
        const thread = await loadThread(user.id, (req.params as { id: string }).id);
        const body = z.object({ resolved: z.boolean() }).safeParse(req.body);
        if (!body.success) throw badRequest("Invalid request");
        await app.sql`update threads set resolved = ${body.data.resolved} where id = ${thread.id}`;
        return { ok: true };
    });
};
