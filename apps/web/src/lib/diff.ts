/** Tree and line diffs computed in the browser. */
import type { TreeFile } from "./types";

export type FileChange = {
    path: string;
    status: "added" | "removed" | "changed";
    before?: TreeFile;
    after?: TreeFile;
};

/** Compares two tree listings by content hash. */
export const diffTrees = (before: TreeFile[], after: TreeFile[]): FileChange[] => {
    const old = new Map(before.map((file) => [file.path, file]));
    const changes: FileChange[] = [];
    for (const file of after) {
        const previous = old.get(file.path);
        if (!previous) changes.push({ path: file.path, status: "added", after: file });
        else if (previous.hash !== file.hash)
            changes.push({ path: file.path, status: "changed", before: previous, after: file });
        old.delete(file.path);
    }
    for (const file of old.values())
        changes.push({ path: file.path, status: "removed", before: file });
    return changes.sort((a, b) => a.path.localeCompare(b.path));
};

export type DiffLine = {
    kind: "same" | "add" | "del";
    text: string;
    /** 1-based line numbers in the old and new text. */
    oldLine?: number;
    newLine?: number;
};

/** Above this many cells of the LCS table the diff is not computed. */
const MAX_CELLS = 16_000_000;

const splitLines = (text: string) => {
    if (text === "") return [];
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
};

/**
 * A line diff by longest common subsequence, after trimming the common prefix and suffix.
 * Returns undefined when the changed middle part is too large to compare.
 */
export const diffLines = (before: string, after: string): DiffLine[] | undefined => {
    const a = splitLines(before);
    const b = splitLines(after);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const n = endA - start;
    const m = endB - start;
    if ((n + 1) * (m + 1) > MAX_CELLS) return undefined;

    // lengths[i][j] = LCS of a[start+i..endA) and b[start+j..endB)
    const width = m + 1;
    const lengths = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            lengths[i * width + j] =
                a[start + i] === b[start + j]
                    ? lengths[(i + 1) * width + j + 1]! + 1
                    : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);

    const result: DiffLine[] = [];
    for (let k = 0; k < start; k++)
        result.push({ kind: "same", text: a[k]!, oldLine: k + 1, newLine: k + 1 });
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[start + i] === b[start + j]) {
            result.push({
                kind: "same",
                text: a[start + i]!,
                oldLine: start + i + 1,
                newLine: start + j + 1,
            });
            i++;
            j++;
        } else if (
            j < m &&
            (i >= n || lengths[i * width + j + 1]! >= lengths[(i + 1) * width + j]!)
        ) {
            result.push({ kind: "add", text: b[start + j]!, newLine: start + j + 1 });
            j++;
        } else {
            result.push({ kind: "del", text: a[start + i]!, oldLine: start + i + 1 });
            i++;
        }
    }
    for (let k = 0; k < a.length - endA; k++)
        result.push({
            kind: "same",
            text: a[endA + k]!,
            oldLine: endA + k + 1,
            newLine: endB + k + 1,
        });
    // within a change block show removals before additions
    return reorderBlocks(result);
};

const reorderBlocks = (lines: DiffLine[]): DiffLine[] => {
    const out: DiffLine[] = [];
    let dels: DiffLine[] = [];
    let adds: DiffLine[] = [];
    const flush = () => {
        out.push(...dels, ...adds);
        dels = [];
        adds = [];
    };
    for (const line of lines) {
        if (line.kind === "same") {
            flush();
            out.push(line);
        } else if (line.kind === "del") dels.push(line);
        else adds.push(line);
    }
    flush();
    return out;
};

export type Hunk = { lines: DiffLine[]; hiddenBefore: number };

/** Groups a diff into hunks with `context` unchanged lines around each change. */
export const toHunks = (lines: DiffLine[], context = 3): Hunk[] => {
    const keep = new Array<boolean>(lines.length).fill(false);
    lines.forEach((line, index) => {
        if (line.kind === "same") return;
        for (
            let k = Math.max(0, index - context);
            k <= Math.min(lines.length - 1, index + context);
            k++
        )
            keep[k] = true;
    });
    const hunks: Hunk[] = [];
    let hidden = 0;
    let current: Hunk | undefined;
    lines.forEach((line, index) => {
        if (!keep[index]) {
            hidden++;
            current = undefined;
            return;
        }
        if (!current) {
            current = { lines: [], hiddenBefore: hidden };
            hunks.push(current);
            hidden = 0;
        }
        current.lines.push(line);
    });
    return hunks;
};
