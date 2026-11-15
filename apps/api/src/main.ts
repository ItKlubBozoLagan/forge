import { createApp } from "./app";
import { loadConfig } from "./config";
import { createServer } from "./server";

const config = loadConfig();
const app = await createApp(config);
const server = await createServer(app);
await server.listen({ port: config.port, host: config.host });
console.log(`forge api listening on http://${config.host}:${config.port} (runner: ${config.runner.kind}, queue: ${config.runner.queueKey})`);

const shutdown = async () => {
    await server.close();
    await app.close();
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
