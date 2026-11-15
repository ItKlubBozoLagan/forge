import { createHash, randomBytes } from "node:crypto";

import { FastifyRequest } from "fastify";

import { App } from "./app";

export class HttpError extends Error {
    constructor(public status: number, public code: string, message: string, public detail?: unknown) {
        super(message);
    }
}

export const notFound = (what = "Not found") => new HttpError(404, "not_found", what);
export const forbidden = (message = "You do not have access to this") => new HttpError(403, "forbidden", message);
export const badRequest = (message: string, detail?: unknown) => new HttpError(400, "bad_request", message, detail);
export const conflict = (message: string, detail?: unknown) => new HttpError(409, "conflict", message, detail);

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

export const SESSION_COOKIE = "forge_session";

export type User = { id: string; name: string; email: string | null; picture: string | null };

/** Resolves the caller from a session cookie (web) or a personal access token (CLI). */
export const currentUser = async (app: App, req: FastifyRequest): Promise<User> => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
        const rows = await app.sql<User[]>`
            update tokens set last_used_at = now() from users
            where tokens.token_hash = ${hashToken(header.slice(7))} and users.id = tokens.user_id
            returning users.id, users.name, users.email, users.picture`;
        if (rows[0]) return rows[0];
        throw new HttpError(401, "unauthenticated", "Invalid access token");
    }
    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie) {
        // A custom header cannot be sent cross-site without a CORS preflight, which makes
        // cookie-authenticated writes safe from cross-site request forgery.
        if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-forge-csrf"] !== "1")
            throw new HttpError(403, "csrf", "Missing X-Forge-Csrf header");
        const rows = await app.sql<User[]>`
            select users.id, users.name, users.email, users.picture from sessions join users on users.id = sessions.user_id
            where sessions.token_hash = ${hashToken(cookie)} and sessions.expires_at > now()`;
        if (rows[0]) return rows[0];
    }
    throw new HttpError(401, "unauthenticated", "Sign in first");
};

export type ProblemRole = "owner" | "author" | "viewer" | "tester";

const CAPABILITIES = {
    /** See the problem exists, its statement and limits; discuss it; run own solutions. */
    participate: ["owner", "author", "viewer", "tester"],
    /** Read every file, build and revision. Testers are blind and do not have this. */
    read: ["owner", "author", "viewer"],
    write: ["owner", "author"],
    manage: ["owner"],
} as const satisfies Record<string, readonly ProblemRole[]>;
export type Capability = keyof typeof CAPABILITIES;

export const can = (role: ProblemRole, capability: Capability) =>
    (CAPABILITIES[capability] as readonly ProblemRole[]).includes(role);

export type ProblemRow = {
    id: string;
    workspace_id: string;
    name: string;
    title: string;
    draft_tree: Record<string, { hash: string; size: number }>;
    draft_version: number;
    created_at: Date;
};

export const workspaceRole = async (app: App, userId: string, workspaceId: string): Promise<"owner" | "member" | undefined> => {
    if (!/^\d+$/.test(workspaceId)) return undefined;
    const rows = await app.sql<{ role: "owner" | "member" }[]>`
        select role from memberships where workspace_id = ${workspaceId} and user_id = ${userId}`;
    return rows[0]?.role;
};

export const requireWorkspace = async (app: App, userId: string, workspaceId: string, owner = false) => {
    const role = await workspaceRole(app, userId, workspaceId);
    // unknown and inaccessible workspaces look the same from outside
    if (!role) throw notFound("Workspace not found");
    if (owner && role !== "owner") throw forbidden("Only workspace owners can do this");
    return role;
};

/** Loads a problem and the caller's role on it. Problems are private inside a workspace. */
export const requireProblem = async (
    app: App,
    userId: string,
    problemId: string,
    capability: Capability,
): Promise<{ problem: ProblemRow; role: ProblemRole }> => {
    if (!/^\d+$/.test(problemId)) throw notFound("Problem not found");
    const rows = await app.sql<(ProblemRow & { ws_role: string | null; access_role: ProblemRole | null })[]>`
        select problems.*, memberships.role as ws_role, problem_access.role as access_role
        from problems
        left join memberships on memberships.workspace_id = problems.workspace_id and memberships.user_id = ${userId}
        left join problem_access on problem_access.problem_id = problems.id and problem_access.user_id = ${userId}
        where problems.id = ${problemId}`;
    const row = rows[0];
    const role: ProblemRole | undefined = row?.ws_role === "owner" ? "owner" : row?.ws_role ? (row.access_role ?? undefined) : undefined;
    if (!row || !role) throw notFound("Problem not found");
    if (!can(role, capability)) throw forbidden();
    return { problem: row, role };
};

export const audit = (
    app: App,
    entry: { workspaceId: string; problemId?: string; userId: string; action: string; detail?: Record<string, unknown> },
) =>
    app.sql`insert into audit_log (workspace_id, problem_id, user_id, action, detail)
        values (${entry.workspaceId}, ${entry.problemId ?? null}, ${entry.userId}, ${entry.action}, ${app.sql.json((entry.detail ?? {}) as never)})`;
