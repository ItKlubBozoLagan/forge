import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CliError } from "./client";
import { createIgnore, isSyncable } from "./ignore";
import type { Hashes } from "./sync";

/** `conflicts`: paths left conflicted by `forge pull`, with the remote hash seen then (null: deleted remotely). */
export type State = { apiUrl: string; problemId: string; files: Hashes; conflicts?: Record<string, string | null> };

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Walks up from `from` to find the checkout root (the directory holding `.forge/state.json`). */
export const findRoot = (from = process.cwd()): string => {
    let dir = resolve(from);
    for (;;) {
        if (existsSync(join(dir, ".forge", "state.json"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) throw new CliError("not inside a forge checkout (no .forge/state.json found)");
        dir = parent;
    }
};

export const readState = (root: string): State => JSON.parse(readFileSync(join(root, ".forge", "state.json"), "utf8")) as State;

export const writeState = (root: string, state: State) => {
    mkdirSync(join(root, ".forge"), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(state.files).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(join(root, ".forge", "state.json"), JSON.stringify({ ...state, files: sorted, conflicts: state.conflicts && Object.keys(state.conflicts).length > 0 ? state.conflicts : undefined }, null, 2) + "\n");
};

export type Scan = { hashes: Hashes; skipped: string[] };

export const scan = (root: string, conflicts: string[] = []): Scan => {
    const forgeignorePath = join(root, ".forgeignore");
    const ignored = createIgnore(existsSync(forgeignorePath) ? readFileSync(forgeignorePath, "utf8") : "");
    const sideFiles = new Set(conflicts.map((path) => `${path}.remote`));
    const result: Scan = { hashes: {}, skipped: [] };
    const walk = (rel: string) => {
        for (const entry of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
            if (entry.isDirectory()) {
                if (!ignored(path, true)) walk(path);
            } else if (entry.isFile()) {
                if (ignored(path) || sideFiles.has(path)) continue;
                if (!isSyncable(path)) result.skipped.push(path);
                else result.hashes[path] = sha256(readFileSync(join(root, path)));
            }
        }
    };
    walk("");
    return result;
};

/** Remote tree filtered the same way the local scan is, so both sides compare like with like. */
export const filterRemote = (root: string, files: Array<{ path: string; hash: string }>): { hashes: Hashes; skipped: string[] } => {
    const forgeignorePath = join(root, ".forgeignore");
    const ignored = createIgnore(existsSync(forgeignorePath) ? readFileSync(forgeignorePath, "utf8") : "");
    const hashes: Hashes = {};
    const skipped: string[] = [];
    for (const file of files) {
        if (!isSyncable(file.path)) skipped.push(file.path);
        else if (!ignored(file.path)) hashes[file.path] = file.hash;
    }
    return { hashes, skipped };
};

export const writeLocal = (root: string, path: string, bytes: Uint8Array) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
};

export const deleteLocal = (root: string, path: string) => {
    rmSync(join(root, path), { force: true });
    // prune now-empty directories, never the root itself
    let dir = dirname(join(root, path));
    while (dir !== resolve(root) && dir.startsWith(resolve(root))) {
        try {
            if (statSync(dir).isDirectory() && readdirSync(dir).length === 0) rmdirSync(dir);
            else break;
        } catch {
            break;
        }
        dir = dirname(dir);
    }
};

export const readLocal = (root: string, path: string) => new Uint8Array(readFileSync(join(root, path)));
