import { existsSync } from "node:fs";
import { join } from "node:path";

import { ApiError, Client, CliError } from "./client";
import { changedPaths, diffLocal, diffRemote, findConflicts, planPull, planPush, type Hashes } from "./sync";
import {
    deleteLocal,
    filterRemote,
    readLocal,
    readState,
    scan,
    sha256,
    writeLocal,
    writeState,
    type State,
} from "./workdir";
import { info, mapLimit, warn } from "./util";

export type Checkout = { root: string; state: State; client: Client };

export const scanLocal = (root: string, state?: State): Hashes => {
    const { hashes, skipped } = scan(root, Object.keys(state?.conflicts ?? {}));
    for (const path of skipped) warn(`skipping ${path}: only [A-Za-z0-9._-/] paths can be synced`);
    return hashes;
};

export const fetchRemote = async ({ root, state, client }: Checkout) => {
    const tree = await client.tree(state.problemId);
    const { hashes, skipped } = filterRemote(root, tree.files);
    for (const path of skipped) warn(`ignoring remote file ${path}: not a syncable path`);
    return { version: tree.version, hashes };
};

export const loadCheckout = (root: string, client: (apiUrl: string) => Client): Checkout => {
    const state = readState(root);
    return { root, state, client: client(state.apiUrl) };
};

/** Downloads `paths` (hash-addressed) into the working directory, verifying content hashes. */
export const downloadFiles = async ({ root, state, client }: Checkout, entries: Array<{ path: string; hash: string }>) => {
    await mapLimit(entries, 8, async ({ path, hash }) => {
        const bytes = await client.blob(state.problemId, hash);
        if (sha256(bytes) !== hash) throw new CliError(`hash mismatch downloading ${path}`);
        writeLocal(root, path, bytes);
    });
};

/** Returns true when conflicts were found. */
export const pull = async (checkout: Checkout): Promise<boolean> => {
    const { root, state } = checkout;
    const local = scanLocal(root, state);
    const remote = (await fetchRemote(checkout)).hashes;
    const plan = planPull(state.files, local, remote);
    await downloadFiles(
        checkout,
        plan.download.map((path) => ({ path, hash: remote[path]! })),
    );
    for (const path of plan.deleteLocal) deleteLocal(root, path);
    const conflictFiles = plan.conflicts.filter((conflict) => conflict.remoteHash !== undefined);
    await mapLimit(conflictFiles, 8, async ({ path, remoteHash }) => {
        writeLocal(root, `${path}.remote`, await checkout.client.blob(state.problemId, remoteHash!));
    });
    writeState(root, {
        ...state,
        files: plan.base,
        conflicts: Object.fromEntries(plan.conflicts.map((c) => [c.path, c.remoteHash ?? null])),
    });
    for (const path of plan.download) info(`updated  ${path}`);
    for (const path of plan.deleteLocal) info(`deleted  ${path}`);
    for (const { path, remoteHash } of plan.conflicts) {
        info(
            remoteHash === undefined
                ? `conflict ${path} (deleted remotely, modified locally; local file kept)`
                : `conflict ${path} (local kept, remote version written to ${path}.remote)`,
        );
    }
    if (plan.download.length + plan.deleteLocal.length + plan.conflicts.length === 0) info("already up to date");
    else if (plan.conflicts.length > 0)
        info("resolve the conflicts, delete the .remote files, then `forge push` (use --force to overwrite the server)");
    return plan.conflicts.length > 0;
};

export const push = async (checkout: Checkout, force = false): Promise<{ changed: number }> => {
    const { root, state, client } = checkout;
    const local = scanLocal(root, state);
    const pending = Object.keys(state.conflicts ?? {}).filter((path) => existsSync(join(root, `${path}.remote`)));
    if (pending.length > 0 && !force) {
        throw new CliError(
            `unresolved conflicts: merge into the local file, then delete the .remote copy:\n${pending.map((p) => `  ${p}.remote`).join("\n")}`,
        );
    }
    const remote = force ? undefined : (await fetchRemote(checkout)).hashes;
    const resolved = force ? {} : (state.conflicts ?? {});
    const plan = planPush(state.files, local, remote, resolved);
    if (plan.changes.length === 0 && plan.adopt.length === 0) {
        info("nothing to push");
        return { changed: 0 };
    }
    await mapLimit(plan.upload, 8, async (path) => {
        const bytes = readLocal(root, path);
        const result = await client.uploadBlob(state.problemId, bytes);
        if (result.hash !== sha256(bytes)) throw new CliError(`server hashed ${path} differently`);
    });
    if (plan.changes.length > 0) {
        try {
            await client.post(`/problems/${state.problemId}/sync`, { changes: plan.changes, ...(force ? { force: true } : {}) });
        } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
                const detail = Array.isArray(error.detail) ? (error.detail as Array<{ path: string }>) : [];
                const lines = detail.map((entry) => `  ${entry.path}`).join("\n");
                throw new CliError(
                    `push rejected: ${error.message}\n${lines}${lines ? "\n" : ""}run \`forge pull\` to merge the remote changes (or \`forge push --force\` to overwrite them)`,
                );
            }
            throw error;
        }
    }
    for (const path of Object.keys(state.conflicts ?? {})) {
        if (local[path] === undefined) delete plan.base[path];
        else plan.base[path] = local[path]!;
    }
    writeState(root, { ...state, files: plan.base, conflicts: {} });
    const change = new Map(plan.changes.map((c) => [c.path, c]));
    for (const path of [...plan.changes.map((c) => c.path), ...plan.adopt].sort()) {
        const c = change.get(path);
        info(`${c ? (c.hash === null ? "deleted " : c.base === null ? "added   " : "modified") : "in sync "} ${path}`);
    }
    return { changed: plan.changes.length };
};

export const status = async (checkout: Checkout) => {
    const { state } = checkout;
    const local = scanLocal(checkout.root, state);
    const remote = (await fetchRemote(checkout)).hashes;
    const dl = diffLocal(state.files, local);
    const dr = diffRemote(state.files, remote);
    const conflicts = new Set(findConflicts(state.files, local, remote));
    const print = (title: string, d: typeof dl) => {
        const paths = changedPaths(d);
        if (paths.length === 0) return;
        info(title);
        for (const path of paths) {
            const kind = d.added.includes(path) ? "added   " : d.modified.includes(path) ? "modified" : "deleted ";
            info(`  ${kind} ${path}${conflicts.has(path) ? "   (CONFLICT: changed on both sides)" : ""}`);
        }
    };
    print("Local changes (not pushed):", dl);
    print("Remote changes (not pulled):", dr);
    if (changedPaths(dl).length + changedPaths(dr).length === 0) info("clean: working copy matches the server");
    return { conflicts: conflicts.size };
};
