import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Config = { apiUrl: string; webUrl: string; token?: string };

export const DEFAULT_API = "http://localhost:3200/api";
export const DEFAULT_WEB = "http://localhost:3200";

export const configPath = () =>
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "forge", "config.json");

const readStored = (): Partial<Config> => {
    const path = configPath();
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    } catch {
        return {};
    }
};

export const loadConfig = (): Config => {
    const stored = readStored();
    return {
        apiUrl: process.env.FORGE_API_URL || stored.apiUrl || DEFAULT_API,
        webUrl: stored.webUrl || DEFAULT_WEB,
        token: process.env.FORGE_TOKEN || stored.token,
    };
};

export const saveConfig = (config: Config) => {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 4) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
};

export const stripSlash = (url: string) => url.replace(/\/+$/, "");
