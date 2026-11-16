/** Helpers for bulk file changes, revision trees, file contents and downloads. */
import { useQuery } from "@tanstack/react-query";

import { api, ApiError, decodeText, isBinary, q, send } from "./api";
import { keys } from "./queries";
import type { Thread, Tree, TreeFile } from "./types";

/** The API's per-file limit (MAX_FILE_BYTES, 16 MB by default). */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Files above this size are not shown or diffed in the browser. */
export const VIEW_LIMIT = 2 * 1024 * 1024;

/** Mirrors the API's path check: a relative path of letters, digits, `._-` and `/`. */
export const pathProblem = (path: string): string | undefined => {
    if (!path) return "empty path";
    if (path.length > 200) return "path longer than 200 characters";
    if (!/^[A-Za-z0-9._\-/]+$/.test(path))
        return "only letters, digits, dot, dash, underscore and / are allowed";
    if (path.startsWith("/") || path.endsWith("/")) return "path starts or ends with /";
    if (path.split("/").some((part) => part === "" || part === "." || part === ".."))
        return "empty, . or .. folder name";
    return undefined;
};

/** Cleans a target directory typed by the user: no leading, trailing or doubled slashes. */
export const normalizeDir = (dir: string) =>
    dir
        .trim()
        .split("/")
        .filter((part) => part !== "")
        .join("/");

export const joinPath = (dir: string, path: string) => (dir ? `${dir}/${path}` : path);

/** Folders that contain at least one file, sorted. */
export const foldersOf = (files: TreeFile[]) => {
    const folders = new Set<string>();
    for (const file of files) {
        const parts = file.path.split("/");
        for (let k = 1; k < parts.length; k++) folders.add(parts.slice(0, k).join("/"));
    }
    return [...folders].sort();
};

/** SHA-256 in hex, as the API hashes blobs; undefined when WebCrypto is not available. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string | undefined> => {
    if (!globalThis.crypto?.subtle) return undefined;
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const uploadBlob = async (problemId: string, bytes: Uint8Array) => {
    const response = await send("POST", `/problems/${problemId}/blobs`, {
        bytes: bytes as BodyInit,
    });
    return (await response.json()) as { hash: string; size: number };
};

export type SyncChange = { path: string; base: string | null; hash: string | null };

/** Applies changes atomically. A 409 carries `detail: [{ path, current }]`. */
export const syncChanges = (problemId: string, changes: SyncChange[], force = false) =>
    api.post<Tree>(`/problems/${problemId}/sync`, { changes, force });

/** Paths named in a sync conflict, if the error is one. */
export const conflictPaths = (error: unknown): string[] | undefined => {
    if (!(error instanceof ApiError) || error.status !== 409 || !Array.isArray(error.detail))
        return undefined;
    return (error.detail as Array<{ path?: string }>)
        .map((item) => item.path)
        .filter((path): path is string => typeof path === "string");
};

export const archiveUrl = (problemId: string, revisionId?: string) =>
    `/problems/${problemId}/archive${q({ revision: revisionId })}`;

/** Downloads a response as a file, named by its content-disposition header. */
export const downloadFrom = async (path: string, fallbackName: string) => {
    const response = await send("GET", path);
    const disposition = response.headers.get("content-disposition") ?? "";
    const match =
        /filename\*=UTF-8''([^;]+)/i.exec(disposition) ??
        /filename="?([^";]+)"?/i.exec(disposition);
    const name = match ? decodeURIComponent(match[1]!) : fallbackName;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

/** The file listing of a revision (immutable, so cached for good). */
export const useRevisionTree = (problemId: string, revisionId: string | undefined) =>
    useQuery({
        queryKey: [...keys.tree(problemId), "revision", revisionId ?? ""],
        queryFn: () => api.get<Tree>(`/problems/${problemId}/tree${q({ revision: revisionId })}`),
        enabled: !!revisionId,
        staleTime: Infinity,
    });

export type Content =
    { kind: "text"; text: string; size: number } | { kind: "binary" | "large"; size: number };

/** A file's content by its hash; binary and large files are not decoded. */
export const useContent = (problemId: string, file: TreeFile | undefined, enabled = true) =>
    useQuery({
        queryKey: ["blob", problemId, file?.hash ?? ""],
        enabled: enabled && !!file,
        staleTime: Infinity,
        queryFn: async (): Promise<Content> => {
            if (file!.size > VIEW_LIMIT) return { kind: "large", size: file!.size };
            const { bytes } = await api.bytes(`/problems/${problemId}/blobs/${file!.hash}`);
            if (isBinary(bytes)) return { kind: "binary", size: bytes.length };
            return { kind: "text", text: decodeText(bytes), size: bytes.length };
        },
    });

export const useThreads = (problemId: string, enabled = true) =>
    useQuery({
        queryKey: keys.threads(problemId),
        queryFn: () => api.get<Thread[]>(`/problems/${problemId}/threads`),
        enabled,
    });
