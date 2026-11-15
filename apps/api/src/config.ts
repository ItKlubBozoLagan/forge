const env = (name: string, fallback?: string): string => {
    const value = process.env[name] ?? fallback;
    if (value === undefined) throw new Error(`Missing environment variable ${name}`);
    return value;
};
const flag = (name: string, fallback = false) => (process.env[name] ?? String(fallback)) === "true";
const int = (name: string, fallback: number) => Number.parseInt(process.env[name] ?? String(fallback), 10);

export const loadConfig = () => {
    const mode = env("NODE_ENV", "development");
    const config = {
        mode,
        port: int("PORT", 8090),
        host: env("HOST", "127.0.0.1"),
        /** Public URL of the web app; used for redirects after login. */
        webUrl: env("WEB_URL", "http://localhost:3200"),
        /** Public URL of this API as the browser sees it (behind the web app's /api proxy). */
        publicApiUrl: env("PUBLIC_API_URL", "http://localhost:3200/api"),
        databaseUrl: env("DATABASE_URL", "postgresql://kontestis:kontestis@localhost:5432/forge"),
        redisUrl: env("REDIS_URL", "redis://localhost:6379"),
        s3: {
            endPoint: env("S3_ENDPOINT", "localhost"),
            port: int("S3_PORT", 9000),
            useSSL: flag("S3_SSL"),
            accessKey: env("S3_ACCESS_KEY", "root"),
            secretKey: env("S3_SECRET_KEY", "password"),
            bucket: env("S3_BUCKET", "forge-blobs"),
        },
        runner: {
            /** `evaluator`: the kontestis evaluator over Redis. `local`: unsandboxed, dev/test only. */
            kind: env("RUNNER", "evaluator") as "evaluator" | "local",
            /** Queue the evaluator instances consume. Point it at the judge's queue to share them. */
            queueKey: env("EVALUATOR_QUEUE_KEY", "evaluator_msg_queue"),
            /** Name of the pool behind that queue and the hardware it runs on. */
            pool: env("RUNNER_POOL", "default"),
            hardwareClass: env("RUNNER_HARDWARE_CLASS", "unclassified"),
            /** Evaluator jobs in flight at once, in total and per workspace. */
            concurrency: int("RUNNER_CONCURRENCY", 4),
            workspaceConcurrency: int("RUNNER_WORKSPACE_CONCURRENCY", 2),
            jobTimeoutMs: int("RUNNER_JOB_TIMEOUT_MS", 15 * 60_000),
        },
        auth: {
            /** Password-less login for local development and tests. Never enable in production. */
            devLogin: flag("AUTH_DEV_LOGIN"),
            sessionDays: int("SESSION_DAYS", 30),
            oauth: process.env.OAUTH_CLIENT_ID
                ? {
                      clientId: env("OAUTH_CLIENT_ID"),
                      clientSecret: env("OAUTH_CLIENT_SECRET"),
                      /** The kontestis consent page, e.g. https://kontestis.example/oauth/authorize */
                      authorizeUrl: env("OAUTH_AUTHORIZE_URL"),
                      tokenUrl: env("OAUTH_TOKEN_URL"),
                      userinfoUrl: env("OAUTH_USERINFO_URL"),
                  }
                : undefined,
        },
        maxFileBytes: int("MAX_FILE_BYTES", 16 * 1024 * 1024),
    };
    if (mode === "production" && config.auth.devLogin)
        throw new Error("AUTH_DEV_LOGIN must not be enabled in production");
    if (mode === "production" && config.runner.kind === "local")
        throw new Error("RUNNER=local runs untrusted code without a sandbox and is refused in production");
    return config;
};

export type Config = ReturnType<typeof loadConfig>;
