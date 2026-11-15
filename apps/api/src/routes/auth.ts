import { randomBytes } from "node:crypto";

import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { App } from "../app";
import { badRequest, currentUser, hashToken, HttpError, newToken, notFound, SESSION_COOKIE } from "../http";

const STATE_COOKIE = "forge_oauth_state";

type Userinfo = {
    sub: string;
    name?: string;
    email?: string;
    picture?: string;
    organisations?: Array<{ organisation_id: string; permissions: string }>;
};

/** Only same-site paths are accepted as post-login destinations. */
const safeRedirect = (value: unknown) =>
    typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";

export const startSession = async (app: App, reply: FastifyReply, userId: string) => {
    const token = newToken("fs");
    const days = app.config.auth.sessionDays;
    await app.sql`insert into sessions (token_hash, user_id, expires_at)
        values (${hashToken(token)}, ${userId}, now() + ${`${days} days`}::interval)`;
    reply.setCookie(SESSION_COOKIE, token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: app.config.mode === "production",
        maxAge: days * 86_400,
    });
};

/** Every user owns a personal workspace, so they can start without an organisation. */
const ensurePersonalWorkspace = async (app: App, userId: string, name: string) => {
    const owned = await app.sql`
        select 1 from memberships join workspaces on workspaces.id = memberships.workspace_id
        where memberships.user_id = ${userId} and memberships.role = 'owner' and workspaces.kontestis_org_id is null limit 1`;
    if (owned.length > 0) return;
    const [workspace] = await app.sql<{ id: string }[]>`insert into workspaces (name) values (${`${name}'s workspace`}) returning id`;
    await app.sql`insert into memberships (workspace_id, user_id, role) values (${workspace!.id}, ${userId}, 'owner')`;
};

/**
 * Workspaces mirror kontestis organisations. Membership of mirrored workspaces follows the
 * identity provider on every login; roles on individual problems stay local to this app.
 */
const syncOrganisations = async (app: App, userId: string, organisations: NonNullable<Userinfo["organisations"]>) => {
    const keep: string[] = [];
    for (const organisation of organisations) {
        // bit 0 of the organisation permission bitset is ADMIN
        let admin = false;
        try {
            admin = (BigInt(organisation.permissions) & 1n) === 1n;
        } catch {
            admin = false;
        }
        const [workspace] = await app.sql<{ id: string }[]>`
            insert into workspaces (name, kontestis_org_id)
            values (${`Organisation ${organisation.organisation_id}`}, ${organisation.organisation_id})
            on conflict (kontestis_org_id) do update set kontestis_org_id = excluded.kontestis_org_id
            returning id`;
        keep.push(workspace!.id);
        await app.sql`
            insert into memberships (workspace_id, user_id, role) values (${workspace!.id}, ${userId}, ${admin ? "owner" : "member"})
            on conflict (workspace_id, user_id) do update set role = excluded.role`;
    }
    await app.sql`
        delete from memberships using workspaces
        where memberships.workspace_id = workspaces.id and memberships.user_id = ${userId}
            and workspaces.kontestis_org_id is not null
            and ${keep.length === 0 ? app.sql`true` : app.sql`memberships.workspace_id not in ${app.sql(keep)}`}`;
};

export const authRoutes = (server: FastifyInstance, app: App) => {
    const oauth = app.config.auth.oauth;
    const callbackUrl = `${app.config.publicApiUrl}/auth/callback`;

    server.get("/auth/config", async () => ({ devLogin: app.config.auth.devLogin, oauth: oauth !== undefined }));

    server.get("/auth/login", async (req, reply) => {
        if (!oauth) throw notFound("OAuth login is not configured");
        const state = randomBytes(24).toString("base64url");
        const redirect = safeRedirect((req.query as { redirect?: string }).redirect);
        reply.setCookie(STATE_COOKIE, JSON.stringify({ state, redirect }), {
            path: "/",
            httpOnly: true,
            sameSite: "lax",
            secure: app.config.mode === "production",
            maxAge: 600,
        });
        const url = new URL(oauth.authorizeUrl);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", oauth.clientId);
        url.searchParams.set("redirect_uri", callbackUrl);
        url.searchParams.set("state", state);
        return reply.redirect(url.toString());
    });

    server.get("/auth/callback", async (req, reply) => {
        if (!oauth) throw notFound("OAuth login is not configured");
        const query = req.query as { code?: string; state?: string; error?: string };
        let saved: { state?: string; redirect?: string } = {};
        try {
            saved = JSON.parse(req.cookies[STATE_COOKIE] ?? "{}");
        } catch {
            saved = {};
        }
        reply.clearCookie(STATE_COOKIE, { path: "/" });
        const failed = (reason: string) => reply.redirect(`${app.config.webUrl}/login?error=${encodeURIComponent(reason)}`);
        if (query.error) return failed(query.error);
        if (!query.code || !query.state || !saved.state || query.state !== saved.state) return failed("invalid_state");

        const tokenResponse = await fetch(oauth.tokenUrl, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                authorization: `Basic ${Buffer.from(`${encodeURIComponent(oauth.clientId)}:${encodeURIComponent(oauth.clientSecret)}`).toString("base64")}`,
            },
            body: new URLSearchParams({ grant_type: "authorization_code", code: query.code, redirect_uri: callbackUrl }),
        });
        if (!tokenResponse.ok) return failed("token_exchange_failed");
        const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: string };
        if (!accessToken) return failed("token_exchange_failed");
        // the provider's token is used once, here; from now on the session is ours
        const infoResponse = await fetch(oauth.userinfoUrl, { headers: { authorization: `Bearer ${accessToken}` } });
        if (!infoResponse.ok) return failed("userinfo_failed");
        const info = (await infoResponse.json()) as Userinfo;
        if (!info.sub) return failed("userinfo_failed");

        const name = info.name || info.email || `User ${info.sub}`;
        const [user] = await app.sql<{ id: string }[]>`
            insert into users (external_id, name, email, picture)
            values (${info.sub}, ${name}, ${info.email ?? null}, ${info.picture ?? null})
            on conflict (external_id) do update set name = excluded.name, email = excluded.email, picture = excluded.picture
            returning id`;
        await ensurePersonalWorkspace(app, user!.id, name);
        await syncOrganisations(app, user!.id, info.organisations ?? []);
        await startSession(app, reply, user!.id);
        return reply.redirect(`${app.config.webUrl}${safeRedirect(saved.redirect)}`);
    });

    server.post("/auth/dev-login", async (req, reply) => {
        if (!app.config.auth.devLogin) throw notFound();
        const body = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(req.body);
        if (!body.success) throw badRequest("A name is required");
        const email = `${body.data.name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@dev.local`;
        const existing = await app.sql<{ id: string }[]>`select id from users where email = ${email} and external_id is null`;
        const user =
            existing[0] ??
            (await app.sql<{ id: string }[]>`insert into users (name, email) values (${body.data.name}, ${email}) returning id`)[0]!;
        await ensurePersonalWorkspace(app, user.id, body.data.name);
        await startSession(app, reply, user.id);
        return { ok: true };
    });

    server.post("/auth/logout", async (req, reply) => {
        const cookie = req.cookies[SESSION_COOKIE];
        if (cookie) await app.sql`delete from sessions where token_hash = ${hashToken(cookie)}`;
        reply.clearCookie(SESSION_COOKIE, { path: "/" });
        return { ok: true };
    });

    server.get("/me", async (req) => {
        const user = await currentUser(app, req);
        const workspaces = await app.sql`
            select workspaces.id, workspaces.name, workspaces.kontestis_org_id as "kontestisOrgId",
                workspaces.reference_class as "referenceClass", memberships.role
            from memberships join workspaces on workspaces.id = memberships.workspace_id
            where memberships.user_id = ${user.id} order by workspaces.id`;
        return { user, workspaces };
    });

    // personal access tokens, used by the CLI
    server.get("/tokens", async (req) => {
        const user = await currentUser(app, req);
        return app.sql`select id, name, created_at as "createdAt", last_used_at as "lastUsedAt" from tokens where user_id = ${user.id} order by id desc`;
    });

    server.post("/tokens", async (req) => {
        const user = await currentUser(app, req);
        const body = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(req.body);
        if (!body.success) throw badRequest("A token name is required");
        const token = newToken("fpat");
        const [row] = await app.sql<{ id: string }[]>`
            insert into tokens (user_id, name, token_hash) values (${user.id}, ${body.data.name}, ${hashToken(token)}) returning id`;
        // the token is shown once and only its hash is stored
        return { id: row!.id, name: body.data.name, token };
    });

    server.delete("/tokens/:id", async (req) => {
        const user = await currentUser(app, req);
        const { id } = req.params as { id: string };
        if (!/^\d+$/.test(id)) throw notFound();
        const deleted = await app.sql`delete from tokens where id = ${id} and user_id = ${user.id} returning id`;
        if (deleted.length === 0) throw new HttpError(404, "not_found", "Token not found");
        return { ok: true };
    });
};
