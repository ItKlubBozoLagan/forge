import { defineConfig, devices } from "@playwright/test";

// The suite starts its own API and web server on separate ports with a separate database, so
// it never touches a development instance. FORGE_E2E_RUNNER=evaluator runs the same tests on
// a real kontestis evaluator instead of the unsandboxed local runner.
const API_PORT = 8191;
const WEB_PORT = 3291;
const runner = process.env.FORGE_E2E_RUNNER ?? "local";

export default defineConfig({
    testDir: "tests",
    timeout: runner === "evaluator" ? 240_000 : 120_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL: `http://localhost:${WEB_PORT}`,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
    webServer: [
        {
            command: "node reset-db.mjs && pnpm --filter @forge/api exec tsx src/main.ts",
            url: `http://127.0.0.1:${API_PORT}/api/health`,
            reuseExistingServer: false,
            timeout: 60_000,
            env: {
                NODE_ENV: "test",
                PORT: String(API_PORT),
                DATABASE_URL: process.env.E2E_DATABASE_URL ?? "postgresql://kontestis:kontestis@localhost:5432/forge_e2e",
                S3_BUCKET: "forge-blobs-e2e",
                RUNNER: runner,
                EVALUATOR_QUEUE_KEY: process.env.EVALUATOR_QUEUE_KEY ?? "forge_evaluator_queue",
                RUNNER_HARDWARE_CLASS: "e2e-box",
                AUTH_DEV_LOGIN: "true",
                WEB_URL: `http://localhost:${WEB_PORT}`,
                PUBLIC_API_URL: `http://localhost:${WEB_PORT}/api`,
            },
        },
        {
            command: `pnpm --filter @forge/web exec vite --port ${WEB_PORT} --strictPort`,
            url: `http://localhost:${WEB_PORT}`,
            reuseExistingServer: false,
            timeout: 60_000,
            env: { FORGE_API_URL: `http://127.0.0.1:${API_PORT}` },
        },
    ],
});
