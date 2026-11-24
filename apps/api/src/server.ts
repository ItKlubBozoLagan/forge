import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import { App } from "./app";
import { HttpError } from "./http";
import { currentUser } from "./http";
import { authRoutes } from "./routes/auth";
import { buildRoutes } from "./routes/builds";
import { problemRoutes } from "./routes/problems";
import { reviewRoutes } from "./routes/review";
import { setRoutes } from "./routes/sets";
import { workspaceRoutes } from "./routes/workspaces";

/** Production logs every request; tests log nothing. */
const LOG_LEVEL: Record<string, string | undefined> = { development: "warn", production: "info" };

export const createServer = async (app: App) => {
    const server = Fastify({ bodyLimit: app.config.maxFileBytes + 1024, logger: LOG_LEVEL[app.config.mode] ? { level: LOG_LEVEL[app.config.mode]! } : false });
    await server.register(cookie);
    // file contents are opaque bytes
    server.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    server.setErrorHandler((error, _req, reply) => {
        if (error instanceof HttpError)
            return reply.status(error.status).send({ error: { code: error.code, message: error.message, detail: error.detail } });
        const status = (error as { statusCode?: number }).statusCode;
        if (status && status < 500)
            return reply.status(status).send({ error: { code: "bad_request", message: (error as Error).message } });
        server.log.error(error);
        console.error(error);
        return reply.status(500).send({ error: { code: "internal", message: "Something went wrong" } });
    });

    await server.register(
        async (api) => {
            // `?runner=1` also asks the runner whether it is answering, which takes up to a few seconds
            // `?runner=1` also asks whether the runner is answering; it can put a probe on the
            // runner's queue, so it needs a signed-in user
            // probed every few seconds in production, so its requests are not logged
            api.get("/health", { logLevel: "warn" }, async (req) => {
                const probe = Boolean((req.query as { runner?: string }).runner);
                if (probe) await currentUser(app, req);
                return {
                    ok: true,
                    runner: {
                        kind: app.config.runner.kind,
                        pool: app.runner.pool,
                        hardwareClass: app.runner.hardwareClass,
                        ...(probe ? { alive: await app.runner.alive() } : {}),
                    },
                };
            });
            authRoutes(api, app);
            workspaceRoutes(api, app);
            problemRoutes(api, app);
            buildRoutes(api, app);
            reviewRoutes(api, app);
            setRoutes(api, app);
        },
        { prefix: "/api" },
    );

    const webDist = app.config.webDist;
    if (webDist) {
        await server.register(fastifyStatic, {
            root: webDist,
            wildcard: false,
            // the headers below replace the plugin's own
            cacheControl: false,
            // built assets carry a content hash in their name; the entry page must be revalidated
            setHeaders: (res, path) => {
                res.setHeader("cache-control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
            },
        });
        // client-side routes: anything that is not the API or a file gets the entry page
        server.setNotFoundHandler((req, reply) => {
            const path = req.url.split("?")[0]!;
            if (req.method !== "GET" || path === "/api" || path.startsWith("/api/") || path.startsWith("/assets/"))
                return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
            return reply.header("cache-control", "no-cache").sendFile("index.html");
        });
    }
    return server;
};
