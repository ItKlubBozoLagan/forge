/** Loading, saving and keeping problem.yaml consistent with file operations. */
import { MANIFEST_PATH, removeReferences, renameReferences } from "@forge/core";

import { api, decodeText, encodeText, q } from "./api";
import { SyncChange, syncChanges, uploadBlob } from "./files";
import type { TreeFile } from "./types";

const hashOf = (etag: string | undefined) => etag?.replace(/^W\//, "").replace(/"/g, "");

/** A text file of the working copy and the hash it had when read (sent back as If-Match). */
export const loadTextFile = async (problemId: string, path: string) => {
    const { bytes, etag } = await api.bytes(`/problems/${problemId}/file${q({ path })}`);
    return { text: decodeText(bytes), base: hashOf(etag) };
};

/** Saves a text file; a 409 means it changed on the server since `base`. */
export const saveTextFile = (problemId: string, path: string, text: string, base?: string) =>
    api.putBytes<{ hash: string; size: number }>(
        `/problems/${problemId}/file${q({ path })}`,
        encodeText(text),
        base ? { "If-Match": base } : undefined,
    );

/**
 * The change to problem.yaml that keeps it consistent with a file operation, for the same
 * atomic sync as the operation. Undefined when there is no problem.yaml, it is not YAML, or the
 * edit leaves it as it is.
 */
export const manifestChange = async (
    problemId: string,
    hasManifest: boolean,
    edit: (text: string) => string,
): Promise<{ change: SyncChange; text: string } | undefined> => {
    if (!hasManifest) return undefined;
    const { text, base } = await loadTextFile(problemId, MANIFEST_PATH);
    let next: string;
    try {
        next = edit(text);
    } catch {
        return undefined;
    }
    if (next === text || !base) return undefined;
    const blob = await uploadBlob(problemId, encodeText(next));
    return { change: { path: MANIFEST_PATH, base, hash: blob.hash }, text: next };
};

/** problem.yaml as saved by a file operation, when the operation changed it. */
export type ManifestUpdate = { text: string; hash: string } | undefined;

/**
 * Renames a file. When problem.yaml refers to it, the references are updated in the same atomic
 * sync, so the manifest never points at a path that does not exist.
 */
export const renameFile = async (
    problemId: string,
    files: TreeFile[],
    from: string,
    to: string,
): Promise<ManifestUpdate> => {
    const entry = files.find((file) => file.path === from);
    const hasManifest = from !== MANIFEST_PATH && files.some((f) => f.path === MANIFEST_PATH);
    const manifest =
        entry && (await manifestChange(problemId, hasManifest, (t) => renameReferences(t, from, to)));
    if (!entry || !manifest) {
        await api.post(`/problems/${problemId}/rename`, { from, to });
        return undefined;
    }
    await syncChanges(problemId, [
        { path: from, base: entry.hash, hash: null },
        { path: to, base: null, hash: entry.hash },
        manifest.change,
    ]);
    return { text: manifest.text, hash: manifest.change.hash! };
};

/** Deletes a file, removing references to it from problem.yaml in the same atomic sync. */
export const deleteFile = async (
    problemId: string,
    files: TreeFile[],
    path: string,
): Promise<ManifestUpdate> => {
    const entry = files.find((file) => file.path === path);
    const hasManifest = path !== MANIFEST_PATH && files.some((f) => f.path === MANIFEST_PATH);
    const manifest =
        entry && (await manifestChange(problemId, hasManifest, (t) => removeReferences(t, path)));
    if (!entry || !manifest) {
        await api.del(`/problems/${problemId}/file${q({ path })}`);
        return undefined;
    }
    await syncChanges(problemId, [{ path, base: entry.hash, hash: null }, manifest.change]);
    return { text: manifest.text, hash: manifest.change.hash! };
};

/**
 * Brings an open problem.yaml editor up to date after a file operation changed the file:
 * unsaved edits get the same change applied, so they can still be saved without a conflict.
 */
export const followManifest = <
    D extends { path: string; kind: string; base?: string; original: string; text: string },
>(
    doc: D | undefined,
    update: ManifestUpdate,
    edit: (text: string) => string,
): D | undefined => {
    if (!doc || !update || doc.path !== MANIFEST_PATH || doc.kind !== "text") return doc;
    let text = update.text;
    if (doc.text !== doc.original) {
        try {
            text = edit(doc.text);
        } catch {
            text = doc.text;
        }
    }
    return { ...doc, base: update.hash, original: update.text, text };
};
