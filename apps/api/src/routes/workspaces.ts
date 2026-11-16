import { FastifyInstance } from "fastify";
import { z } from "zod";

import { App } from "../app";
import { audit, badRequest, conflict, currentUser, notFound, requireWorkspace } from "../http";

export const workspaceRoutes = (server: FastifyInstance, app: App) => {
    server.post("/workspaces", async (req) => {
        const user = await currentUser(app, req);
        const body = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(req.body);
        if (!body.success) throw badRequest("A workspace name is required");
        const [workspace] = await app.sql<{ id: string }[]>`insert into workspaces (name) values (${body.data.name}) returning id`;
        await app.sql`insert into memberships (workspace_id, user_id, role) values (${workspace!.id}, ${user.id}, 'owner')`;
        await audit(app, { workspaceId: workspace!.id, userId: user.id, action: "workspace.create", detail: { name: body.data.name } });
        return { id: workspace!.id, name: body.data.name, role: "owner" };
    });

    server.patch("/workspaces/:id", async (req) => {
        const user = await currentUser(app, req);
        const { id } = req.params as { id: string };
        await requireWorkspace(app, user.id, id, true);
        const body = z
            .object({ name: z.string().trim().min(1).max(80).optional(), referenceClass: z.string().trim().max(80).nullable().optional() })
            .safeParse(req.body);
        if (!body.success) throw badRequest("Invalid workspace settings");
        if (body.data.name !== undefined) await app.sql`update workspaces set name = ${body.data.name} where id = ${id}`;
        if (body.data.referenceClass !== undefined)
            await app.sql`update workspaces set reference_class = ${body.data.referenceClass || null} where id = ${id}`;
        await audit(app, { workspaceId: id, userId: user.id, action: "workspace.update", detail: body.data });
        return { ok: true };
    });

    server.get("/workspaces/:id/members", async (req) => {
        const user = await currentUser(app, req);
        const { id } = req.params as { id: string };
        await requireWorkspace(app, user.id, id);
        return app.sql`
            select users.id, users.name, users.email, memberships.role
            from memberships join users on users.id = memberships.user_id
            where memberships.workspace_id = ${id} order by users.name`;
    });

    server.post("/workspaces/:id/members", async (req) => {
        const user = await currentUser(app, req);
        const { id } = req.params as { id: string };
        await requireWorkspace(app, user.id, id, true);
        const body = z.object({ email: z.string().trim().email(), role: z.enum(["owner", "member"]).default("member") }).safeParse(req.body);
        if (!body.success) throw badRequest("An email address is required");
        const [workspace] = await app.sql<{ kontestis_org_id: string | null }[]>`select kontestis_org_id from workspaces where id = ${id}`;
        if (workspace?.kontestis_org_id)
            throw conflict("Members of this workspace are managed in its kontestis organisation");
        const [member] = await app.sql<{ id: string; name: string }[]>`select id, name from users where lower(email) = ${body.data.email.toLowerCase()}`;
        if (!member) throw notFound("No user with that email has signed in yet");
        await app.sql`
            insert into memberships (workspace_id, user_id, role) values (${id}, ${member.id}, ${body.data.role})
            on conflict (workspace_id, user_id) do update set role = excluded.role`;
        await audit(app, { workspaceId: id, userId: user.id, action: "member.add", detail: { member: member.id, role: body.data.role } });
        return { id: member.id, name: member.name, role: body.data.role };
    });

    server.delete("/workspaces/:id/members/:userId", async (req) => {
        const user = await currentUser(app, req);
        const { id, userId } = req.params as { id: string; userId: string };
        await requireWorkspace(app, user.id, id, true);
        if (!/^\d+$/.test(userId)) throw notFound();
        if (userId === user.id) throw badRequest("You cannot remove yourself");
        const owners = await app.sql<{ user_id: string }[]>`select user_id from memberships where workspace_id = ${id} and role = 'owner'`;
        if (owners.length === 1 && owners[0]!.user_id === userId) throw conflict("A workspace needs at least one owner");
        await app.sql`delete from memberships where workspace_id = ${id} and user_id = ${userId}`;
        await app.sql`delete from problem_access using problems
            where problem_access.problem_id = problems.id and problems.workspace_id = ${id} and problem_access.user_id = ${userId}`;
        await audit(app, { workspaceId: id, userId: user.id, action: "member.remove", detail: { member: userId } });
        return { ok: true };
    });

    server.get("/workspaces/:id/audit", async (req) => {
        const user = await currentUser(app, req);
        const { id } = req.params as { id: string };
        await requireWorkspace(app, user.id, id, true);
        return app.sql`
            select audit_log.id, audit_log.action, audit_log.detail, audit_log.at, audit_log.problem_id as "problemId",
                users.name as "userName", problems.name as "problemName"
            from audit_log left join users on users.id = audit_log.user_id left join problems on problems.id = audit_log.problem_id
            where audit_log.workspace_id = ${id} order by audit_log.id desc limit 200`;
    });
};
