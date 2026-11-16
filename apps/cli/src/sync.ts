/** Pure sync logic. Maps are `path -> sha256 hex`; an absent key means the file does not exist. */
export type Hashes = Record<string, string>;

export type Diff = { added: string[]; modified: string[]; deleted: string[] };

const diff = (base: Hashes, current: Hashes): Diff => {
    const result: Diff = { added: [], modified: [], deleted: [] };
    for (const [path, hash] of Object.entries(current)) {
        const before = base[path];
        if (before === undefined) result.added.push(path);
        else if (before !== hash) result.modified.push(path);
    }
    for (const path of Object.keys(base)) if (current[path] === undefined) result.deleted.push(path);
    result.added.sort();
    result.modified.sort();
    result.deleted.sort();
    return result;
};

/** Local changes relative to the base. */
export const diffLocal = (base: Hashes, local: Hashes): Diff => diff(base, local);
/** Remote changes relative to the base. */
export const diffRemote = (base: Hashes, remote: Hashes): Diff => diff(base, remote);

export const changedPaths = (d: Diff): string[] => [...d.added, ...d.modified, ...d.deleted].sort();

/** Paths changed on both sides to different content (including deleted on one, changed on the other). */
export const findConflicts = (base: Hashes, local: Hashes, remote: Hashes): string[] => {
    const paths = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    const conflicts: string[] = [];
    for (const path of paths) {
        const [b, l, r] = [base[path], local[path], remote[path]];
        if (l !== r && l !== b && r !== b) conflicts.push(path);
    }
    return conflicts.sort();
};

export type PullPlan = {
    /** Remote content to write over (or create) locally. */
    download: string[];
    /** Files the remote deleted and that are unchanged locally. */
    deleteLocal: string[];
    /** Local file kept; remote version goes to `<path>.remote` (`remoteHash` undefined: remote deleted it). */
    conflicts: Array<{ path: string; remoteHash: string | undefined }>;
    /** Base after a clean pull: conflicting paths keep their old base entry. */
    base: Hashes;
};

export const planPull = (base: Hashes, local: Hashes, remote: Hashes): PullPlan => {
    const plan: PullPlan = { download: [], deleteLocal: [], conflicts: [], base: { ...base } };
    const paths = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    for (const path of [...paths].sort()) {
        const [b, l, r] = [base[path], local[path], remote[path]];
        const set = (hash: string | undefined) => {
            if (hash === undefined) delete plan.base[path];
            else plan.base[path] = hash;
        };
        if (l === r) set(r); // identical (or both gone): nothing to do, adopt the remote state as base
        else if (r === b) continue; // only local changed
        else if (l === b) {
            // only remote changed
            if (r === undefined) plan.deleteLocal.push(path);
            else plan.download.push(path);
            set(r);
        } else plan.conflicts.push({ path, remoteHash: r });
    }
    return plan;
};

export type Change = { path: string; base: string | null; hash: string | null };

export type PushPlan = {
    changes: Change[];
    /** Paths whose content must be uploaded to `/blobs` first. */
    upload: string[];
    /** Paths whose local content already equals the remote one: only the base moves. */
    adopt: string[];
    /** Base after a successful push. */
    base: Hashes;
};

/** `remote` is optional: when given, paths already identical on the server are not re-sent. */
export const planPush = (
    originalBase: Hashes,
    local: Hashes,
    remote?: Hashes,
    /** Conflicted paths the user resolved locally: pushed on top of the remote hash seen at pull time. */
    resolved: Record<string, string | null> = {},
): PushPlan => {
    const base = { ...originalBase };
    for (const [path, hash] of Object.entries(resolved)) {
        if (hash === null) delete base[path];
        else base[path] = hash;
    }
    const plan: PushPlan = { changes: [], upload: [], adopt: [], base: { ...base } };
    const d = diffLocal(base, local);
    for (const path of changedPaths(d)) {
        const hash = local[path];
        if (remote && remote[path] === hash) {
            plan.adopt.push(path);
        } else {
            plan.changes.push({ path, base: base[path] ?? null, hash: hash ?? null });
            if (hash !== undefined) plan.upload.push(path);
        }
        if (hash === undefined) delete plan.base[path];
        else plan.base[path] = hash;
    }
    return plan;
};
