/** Reading files the user picked or dropped, and unpacking zip archives, in the browser. */
import { unzipSync } from "fflate";

import { MAX_FILE_BYTES, sha256Hex } from "../../../lib/files";

/** What the user chose: loose files with relative paths, or one zip archive to unpack. */
export type Picked =
    { kind: "files"; files: Array<{ path: string; file: File }> } | { kind: "zip"; file: File };

/** A file ready for the upload plan. `bytes` is missing for files over the size limit. */
export type Prepared = { path: string; size: number; bytes?: Uint8Array; hash?: string };

const IGNORED = (path: string) =>
    path.startsWith("__MACOSX/") || path.split("/").pop() === ".DS_Store";

export const isZip = (file: File) =>
    file.name.toLowerCase().endsWith(".zip") ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed";

const withHash = async (path: string, bytes: Uint8Array): Promise<Prepared> => ({
    path,
    size: bytes.length,
    bytes,
    hash: await sha256Hex(bytes),
});

export const prepare = async (picked: Picked): Promise<Prepared[]> => {
    if (picked.kind === "zip") {
        const data = new Uint8Array(await picked.file.arrayBuffer());
        let entries: Record<string, Uint8Array>;
        try {
            entries = unzipSync(data);
        } catch (error) {
            throw new Error(`${picked.file.name} is not a readable zip archive (${String(error)})`);
        }
        const out: Prepared[] = [];
        for (const [path, bytes] of Object.entries(entries)) {
            if (path.endsWith("/") || IGNORED(path)) continue;
            out.push(
                bytes.length > MAX_FILE_BYTES
                    ? { path, size: bytes.length }
                    : await withHash(path, bytes),
            );
        }
        return out.sort((a, b) => a.path.localeCompare(b.path));
    }
    const out: Prepared[] = [];
    for (const { path, file } of picked.files) {
        if (IGNORED(path)) continue;
        if (file.size > MAX_FILE_BYTES) out.push({ path, size: file.size });
        else out.push(await withHash(path, new Uint8Array(await file.arrayBuffer())));
    }
    return out;
};

/** The single top folder all paths share, if there is one (common in zip archives). */
export const commonTop = (paths: string[]): string | undefined => {
    if (paths.length === 0) return undefined;
    const first = paths[0]!.split("/")[0]!;
    return paths.every((path) => path.includes("/") && path.split("/")[0] === first)
        ? first
        : undefined;
};

const readAll = (reader: FileSystemDirectoryReader) =>
    new Promise<FileSystemEntry[]>((resolve, reject) => {
        const all: FileSystemEntry[] = [];
        const next = () =>
            reader.readEntries((batch) => {
                if (batch.length === 0) resolve(all);
                else {
                    all.push(...batch);
                    next();
                }
            }, reject);
        next();
    });

const walk = async (
    entry: FileSystemEntry,
    prefix: string,
    out: Array<{ path: string; file: File }>,
) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
            (entry as FileSystemFileEntry).file(resolve, reject),
        );
        out.push({ path, file });
    } else if (entry.isDirectory) {
        const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
        for (const child of children) await walk(child, path, out);
    }
};

/**
 * What was dropped: folders keep their relative paths; a single dropped zip is unpacked.
 * Must be called synchronously inside the drop event (the entries vanish afterwards).
 */
export const readDrop = (transfer: DataTransfer): Promise<Picked | undefined> => {
    const entries = [...transfer.items]
        .filter((item) => item.kind === "file")
        .map((item) => item.webkitGetAsEntry?.())
        .filter((entry): entry is FileSystemEntry => !!entry);
    const plain = [...transfer.files];
    return (async () => {
        if (entries.length === 0) {
            if (plain.length === 0) return undefined;
            if (plain.length === 1 && isZip(plain[0]!)) return { kind: "zip", file: plain[0]! };
            return { kind: "files", files: plain.map((file) => ({ path: file.name, file })) };
        }
        const files: Array<{ path: string; file: File }> = [];
        for (const entry of entries) await walk(entry, "", files);
        if (files.length === 1 && entries[0]!.isFile && isZip(files[0]!.file))
            return { kind: "zip", file: files[0]!.file };
        return { kind: "files", files };
    })();
};
