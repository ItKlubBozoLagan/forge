import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { CliError } from "./client";
import { info, openBrowser } from "./util";

const page = (message: string) =>
    `<!doctype html><meta charset="utf-8"><title>Forge CLI</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto"><h1>Forge CLI</h1><p>${message}</p></body>`;

const sameState = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Loopback login: resolves with the token delivered to `http://127.0.0.1:<port>/callback`. */
export const loopbackLogin = (webUrl: string, timeoutMs = 5 * 60_000): Promise<string> =>
    new Promise((resolve, reject) => {
        const state = randomBytes(24).toString("hex");
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (url.pathname !== "/callback") {
                res.writeHead(404).end();
                return;
            }
            const token = url.searchParams.get("token");
            if (!token || !sameState(url.searchParams.get("state") ?? "", state)) {
                res.writeHead(400, { "content-type": "text/html" }).end(page("Invalid login callback. Run <code>forge login</code> again."));
                return;
            }
            res.writeHead(200, { "content-type": "text/html" }).end(page("You can close this tab and return to the terminal."));
            finish(() => resolve(token));
        });
        const timer = setTimeout(() => finish(() => reject(new CliError("login timed out after 5 minutes"))), timeoutMs);
        const finish = (settle: () => void) => {
            clearTimeout(timer);
            server.close();
            server.closeAllConnections();
            settle();
        };
        server.on("error", (error) => finish(() => reject(error)));
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;
            const url = `${webUrl.replace(/\/+$/, "")}/cli-login?port=${port}&state=${state}`;
            info(`Open this URL to log in:\n  ${url}\nWaiting for the browser (5 minutes) ...`);
            openBrowser(url);
        });
    });
