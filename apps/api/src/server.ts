import cookie from "@fastify/cookie";
import Fastify from "fastify";

import { App } from "./app";
import { HttpError } from "./http";
import { authRoutes } from "./routes/auth";
import { buildRoutes } from "./routes/builds";
import { problemRoutes } from "./routes/problems";
import { reviewRoutes } from "./routes/review";
import { setRoutes } from "./routes/sets";
import { workspaceRoutes } from "./routes/workspaces";

export const createServer = async (app: App) => {
    const server = Fastify({ bodyLimit: app.config.maxFileBytes + 1024, logger: app.config.mode === "development" ? { level: "warn" } : false });
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
            api.get("/health", async () => ({ ok: true, runner: { kind: app.config.runner.kind, pool: app.runner.pool, hardwareClass: app.runner.hardwareClass } }));
            authRoutes(api, app);
            workspaceRoutes(api, app);
            problemRoutes(api, app);
            buildRoutes(api, app);
            reviewRoutes(api, app);
            setRoutes(api, app);
        },
        { prefix: "/api" },
    );
    return server;
};
