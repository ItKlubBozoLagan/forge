import { FastifyInstance } from "fastify";
import postgres from "postgres";

import { App, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { LocalRunner } from "../src/runner/local";
import { CheckRequest, Runner, RunRequest } from "../src/runner/types";
import { createServer } from "../src/server";

const TEST_DATABASE = process.env.TEST_DATABASE_URL ?? "postgresql://kontestis:kontestis@localhost:5432/forge_test";

/** Counts runner calls so tests can assert what the build cache skipped. */
export class CountingRunner implements Runner {
    readonly pool = "test";
    readonly hardwareClass = "test-box";
    calls = 0;
    private inner = new LocalRunner();
    run(request: RunRequest) {
        this.calls += 1;
        return this.inner.run(request);
    }
    check(request: CheckRequest) {
        this.calls += 1;
        return this.inner.check(request);
    }
    close() {
        return this.inner.close();
    }
}

export type Harness = { app: App; server: FastifyInstance; runner: CountingRunner; close(): Promise<void> };

export const startHarness = async (env: Record<string, string> = {}): Promise<Harness> => {
    const admin = postgres(TEST_DATABASE, { onnotice: () => {} });
    await admin`drop schema public cascade`;
    await admin`create schema public`;
    await admin.end();
    Object.assign(process.env, {
        NODE_ENV: "test",
        DATABASE_URL: TEST_DATABASE,
        S3_BUCKET: "forge-blobs-test",
        AUTH_DEV_LOGIN: "true",
        WEB_URL: "http://web.test",
        PUBLIC_API_URL: "http://web.test/api",
        ...env,
    });
    const runner = new CountingRunner();
    const app = await createApp(loadConfig(), runner);
    const server = await createServer(app);
    return {
        app,
        server,
        runner,
        close: async () => {
            await server.close();
            await app.close();
        },
    };
};

export type Client = {
    get(path: string): Promise<{ status: number; body: any; raw: Buffer }>;
    post(path: string, body?: unknown): Promise<{ status: number; body: any }>;
    put(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
    patch(path: string, body?: unknown): Promise<{ status: number; body: any }>;
    delete(path: string): Promise<{ status: number; body: any }>;
    workspaceId: string;
    userId: string;
};

const parse = (payload: string) => {
    try {
        return JSON.parse(payload);
    } catch {
        return payload;
    }
};

/** Signs a user in through dev login and returns a client that carries their session. */
export const login = async (harness: Harness, name: string): Promise<Client> => {
    const response = await harness.server.inject({ method: "POST", url: "/api/auth/dev-login", payload: { name } });
    const cookie = response.cookies.find((entry) => entry.name === "forge_session")!;
    const headers = { cookie: `forge_session=${cookie.value}`, "x-forge-csrf": "1" };
    const send = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
        const binary = Buffer.isBuffer(body);
        const result = await harness.server.inject({
            method: method as "GET",
            url: `/api${path}`,
            headers: { ...headers, ...(binary ? { "content-type": "application/octet-stream" } : {}), ...extra },
            payload: body as never,
        });
        return { status: result.statusCode, body: parse(result.payload), raw: result.rawPayload };
    };
    const client: Client = {
        get: (path) => send("GET", path),
        post: (path, body) => send("POST", path, body ?? {}),
        put: (path, body, extra) => send("PUT", path, body, extra),
        patch: (path, body) => send("PATCH", path, body),
        delete: (path) => send("DELETE", path),
        workspaceId: "",
        userId: "",
    };
    const me = await client.get("/me");
    client.workspaceId = me.body.workspaces[0].id;
    client.userId = me.body.user.id;
    return client;
};

/** Waits for a build to finish and returns it. */
export const finished = async (harness: Harness, client: Client, buildId: string) => {
    await harness.app.worker.idle();
    const build = await client.get(`/builds/${buildId}`);
    if (build.body.status !== "done") throw new Error(`build ${buildId} is ${build.body.status}: ${build.body.error}`);
    return build.body;
};

export const writeFile = (client: Client, problemId: string, path: string, content: string) =>
    client.put(`/problems/${problemId}/file?path=${encodeURIComponent(path)}`, Buffer.from(content));

export const readFile = async (client: Client, problemId: string, path: string) =>
    (await client.get(`/problems/${problemId}/file?path=${encodeURIComponent(path)}`)).raw.toString("utf8");

/** Creates a template problem with a short time limit so the slow solution fails quickly. */
export const createProblem = async (client: Client, name: string, template = "ioi") => {
    const created = await client.post(`/workspaces/${client.workspaceId}/problems`, { name, title: name, template });
    if (created.status !== 200) throw new Error(JSON.stringify(created.body));
    const id = created.body.id as string;
    const manifest = await readFile(client, id, "problem.yaml");
    await writeFile(client, id, "problem.yaml", manifest.replace("time_ms: 1000", "time_ms: 400"));
    return id;
};
