import { FileArchive, FolderOpen, Upload } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ApiError, errorMessage } from "../../../lib/api";
import {
    conflictPaths,
    foldersOf,
    joinPath,
    MAX_FILE_BYTES,
    normalizeDir,
    pathProblem,
    SyncChange,
    syncChanges,
    uploadBlob,
} from "../../../lib/files";
import { formatBytes, plural } from "../../../lib/format";
import type { TreeFile } from "../../../lib/types";
import { Badge, Tone } from "../../../ui/Badge";
import { Button } from "../../../ui/Button";
import { cx } from "../../../ui/cx";
import { Dialog } from "../../../ui/Dialog";
import { Field, Input } from "../../../ui/Field";
import { ErrorNotice, Notice, Progress, Spinner } from "../../../ui/misc";
import { commonTop, isZip, Picked, prepare, Prepared, readDrop } from "./pick";

type Status = "new" | "overwrite" | "unchanged" | "invalid" | "too large" | "duplicate";

type PlanRow = {
    path: string;
    size: number;
    status: Status;
    reason?: string;
    item: Prepared;
    base: string | null;
};

const TONES: Record<Status, Tone> = {
    new: "success",
    overwrite: "warning",
    unchanged: "neutral",
    invalid: "danger",
    "too large": "danger",
    duplicate: "neutral",
};

const UPLOADS_AT_ONCE = 4;

const makePlan = (
    items: Prepared[],
    dir: string,
    strip: string | undefined,
    files: TreeFile[],
): PlanRow[] => {
    const current = new Map(files.map((file) => [file.path, file.hash]));
    const rows = items.map((item): PlanRow => {
        const relative = strip ? item.path.slice(strip.length + 1) : item.path;
        const path = joinPath(dir, relative);
        const base = current.get(path) ?? null;
        const problem = pathProblem(path);
        if (problem)
            return { path, size: item.size, status: "invalid", reason: problem, item, base };
        if (!item.bytes)
            return {
                path,
                size: item.size,
                status: "too large",
                reason: `over the ${formatBytes(MAX_FILE_BYTES)} limit`,
                item,
                base,
            };
        if (base === null) return { path, size: item.size, status: "new", item, base };
        if (item.hash && item.hash === base)
            return { path, size: item.size, status: "unchanged", item, base };
        return { path, size: item.size, status: "overwrite", item, base };
    });
    // when two items land on the same path the later one wins
    const last = new Map(rows.map((row, index) => [row.path, index]));
    return rows.map((row, index) =>
        last.get(row.path) !== index && row.status !== "invalid" && row.status !== "too large"
            ? { ...row, status: "duplicate", reason: "a later file has the same path" }
            : row,
    );
};

type Failure = { path: string; reason: string };
type Phase =
    | { step: "plan" }
    | { step: "uploading"; done: number; total: number }
    | { step: "conflict"; paths: string[]; uploaded: SyncChange[]; failures: Failure[] }
    | { step: "done"; applied: number; failures: Failure[] };

export const UploadDialog = ({
    open,
    onClose,
    problemId,
    files,
    initial,
    initialDir = "",
    onApplied,
    onReloadTree,
}: {
    open: boolean;
    onClose: () => void;
    problemId: string;
    files: TreeFile[];
    /** Files dropped on the tree before the dialog opened. */
    initial?: Picked;
    initialDir?: string;
    onApplied: (paths: string[]) => Promise<void> | void;
    onReloadTree: () => Promise<unknown>;
}) => {
    const [picked, setPicked] = useState<Picked>();
    const [items, setItems] = useState<Prepared[]>();
    const [reading, setReading] = useState(false);
    const [readError, setReadError] = useState<unknown>();
    const [dir, setDir] = useState("");
    const [stripTop, setStripTop] = useState(true);
    const [phase, setPhase] = useState<Phase>({ step: "plan" });
    const [syncError, setSyncError] = useState<unknown>();
    const filesInput = useRef<HTMLInputElement>(null);
    const folderInput = useRef<HTMLInputElement>(null);
    const zipInput = useRef<HTMLInputElement>(null);
    const listId = useId();

    useEffect(() => {
        if (!open) return;
        setPicked(initial);
        setItems(undefined);
        setReadError(undefined);
        setDir(initialDir);
        setStripTop(true);
        setPhase({ step: "plan" });
        setSyncError(undefined);
    }, [open, initial, initialDir]);

    useEffect(() => {
        if (!picked) return;
        let cancelled = false;
        setReading(true);
        setReadError(undefined);
        prepare(picked)
            .then((prepared) => {
                if (!cancelled) setItems(prepared);
            })
            .catch((error) => {
                if (!cancelled) {
                    setItems(undefined);
                    setReadError(error);
                }
            })
            .finally(() => {
                if (!cancelled) setReading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [picked]);

    const top =
        picked?.kind === "zip" && items ? commonTop(items.map((item) => item.path)) : undefined;
    const strip = top && stripTop ? top : undefined;
    const target = normalizeDir(dir);
    const plan = useMemo(
        () => (items ? makePlan(items, target, strip, files) : []),
        [items, target, strip, files],
    );
    const actionable = plan.filter((row) => row.status === "new" || row.status === "overwrite");
    const skipped = plan.filter((row) => row.status === "invalid" || row.status === "too large");
    const counts = plan.reduce<Record<string, number>>((all, row) => {
        all[row.status] = (all[row.status] ?? 0) + 1;
        return all;
    }, {});
    const folders = useMemo(() => foldersOf(files), [files]);
    const busy = phase.step === "uploading";

    const choose = (list: FileList | null, folder: boolean) => {
        if (!list || list.length === 0) return;
        const chosen = [...list];
        if (!folder && chosen.length === 1 && isZip(chosen[0]!)) {
            setPicked({ kind: "zip", file: chosen[0]! });
            return;
        }
        setPicked({
            kind: "files",
            files: chosen.map((file) => ({
                path: (folder && file.webkitRelativePath) || file.name,
                file,
            })),
        });
    };

    const apply = async (changes: SyncChange[], failures: Failure[], force: boolean) => {
        setSyncError(undefined);
        try {
            if (changes.length > 0) await syncChanges(problemId, changes, force);
            await onApplied(changes.map((change) => change.path));
            setPhase({ step: "done", applied: changes.length, failures });
        } catch (error) {
            const paths = conflictPaths(error);
            if (paths) setPhase({ step: "conflict", paths, uploaded: changes, failures });
            else {
                setSyncError(error);
                setPhase({ step: "plan" });
            }
        }
    };

    const upload = async () => {
        const rows = actionable;
        const failures: Failure[] = skipped.map((row) => ({
            path: row.path,
            reason: row.reason ?? row.status,
        }));
        const uploaded: SyncChange[] = [];
        let done = 0;
        setPhase({ step: "uploading", done, total: rows.length });
        const queue = [...rows];
        const worker = async () => {
            for (let row = queue.shift(); row; row = queue.shift()) {
                try {
                    const blob = await uploadBlob(problemId, row.item.bytes!);
                    uploaded.push({ path: row.path, base: row.base, hash: blob.hash });
                } catch (error) {
                    failures.push({
                        path: row.path,
                        reason:
                            error instanceof ApiError && error.status === 413
                                ? "too large for the server"
                                : errorMessage(error),
                    });
                }
                done++;
                setPhase({ step: "uploading", done, total: rows.length });
            }
        };
        await Promise.all(Array.from({ length: UPLOADS_AT_ONCE }, worker));
        uploaded.sort((a, b) => a.path.localeCompare(b.path));
        await apply(uploaded, failures, false);
    };

    const footer =
        phase.step === "done" ? (
            <Button variant="primary" onClick={onClose}>
                Close
            </Button>
        ) : phase.step === "conflict" ? (
            <>
                <Button onClick={onClose}>Cancel</Button>
                <Button
                    onClick={async () => {
                        await onReloadTree();
                        setPhase({ step: "plan" });
                    }}
                >
                    Review again
                </Button>
                <Button
                    variant="danger"
                    onClick={() => void apply(phase.uploaded, phase.failures, true)}
                >
                    Overwrite anyway
                </Button>
            </>
        ) : (
            <>
                <Button onClick={onClose} disabled={busy}>
                    Cancel
                </Button>
                <Button
                    variant="primary"
                    pending={busy}
                    disabled={actionable.length === 0 || reading}
                    onClick={() => void upload()}
                >
                    {actionable.length > 0
                        ? `Upload ${plural(actionable.length, "file")}`
                        : "Upload"}
                </Button>
            </>
        );

    return (
        <Dialog
            open={open}
            onClose={busy ? () => {} : onClose}
            title="Upload files"
            description="Add many files, a folder or a zip archive to the working copy in one change."
            width="min(720px, calc(100vw - 32px))"
            footer={footer}
        >
            {phase.step === "done" ? (
                <div className="flex flex-col gap-3" data-testid="upload-result">
                    <Notice tone={phase.failures.length ? "warning" : "success"}>
                        {phase.applied > 0
                            ? `Uploaded ${plural(phase.applied, "file")} to the working copy.`
                            : "Nothing was uploaded."}
                        {phase.failures.length > 0 &&
                            ` ${plural(phase.failures.length, "file")} could not be uploaded.`}
                    </Notice>
                    {phase.failures.length > 0 && <FailureList failures={phase.failures} />}
                </div>
            ) : phase.step === "conflict" ? (
                <div className="flex flex-col gap-3">
                    <Notice tone="warning">
                        Someone changed these files after you opened the list. Nothing was applied.
                    </Notice>
                    <ul className="max-h-48 overflow-auto font-mono text-[12.5px]">
                        {phase.paths.map((path) => (
                            <li key={path} className="break-all">
                                {path}
                            </li>
                        ))}
                    </ul>
                    <p className="text-sm text-muted">
                        <strong>Review again</strong> reloads the file list so you can check the
                        plan. <strong>Overwrite anyway</strong> replaces their versions with yours.
                    </p>
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-2">
                        <Button
                            icon={<Upload className="size-4" />}
                            disabled={busy}
                            onClick={() => filesInput.current?.click()}
                        >
                            Choose files
                        </Button>
                        <Button
                            icon={<FolderOpen className="size-4" />}
                            disabled={busy}
                            onClick={() => folderInput.current?.click()}
                        >
                            Choose folder
                        </Button>
                        <Button
                            icon={<FileArchive className="size-4" />}
                            disabled={busy}
                            onClick={() => zipInput.current?.click()}
                        >
                            Choose zip
                        </Button>
                        <input
                            ref={filesInput}
                            type="file"
                            multiple
                            hidden
                            data-testid="upload-files-input"
                            onChange={(event) => {
                                choose(event.target.files, false);
                                event.target.value = "";
                            }}
                        />
                        <input
                            ref={(element) => {
                                folderInput.current = element;
                                element?.setAttribute("webkitdirectory", "");
                            }}
                            type="file"
                            multiple
                            hidden
                            data-testid="upload-folder-input"
                            onChange={(event) => {
                                choose(event.target.files, true);
                                event.target.value = "";
                            }}
                        />
                        <input
                            ref={zipInput}
                            type="file"
                            accept=".zip,application/zip"
                            hidden
                            data-testid="upload-zip-input"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) setPicked({ kind: "zip", file });
                                event.target.value = "";
                            }}
                        />
                    </div>
                    <DropArea disabled={busy} onPicked={setPicked} />
                    <Field
                        label="Target folder"
                        hint="Leave empty for the top level of the package, or pick a folder such as tests."
                    >
                        {(id, describedBy) => (
                            <>
                                <Input
                                    id={id}
                                    value={dir}
                                    list={listId}
                                    className="font-mono"
                                    placeholder="(top level)"
                                    aria-describedby={describedBy}
                                    disabled={busy}
                                    onChange={(event) => setDir(event.target.value)}
                                />
                                <datalist id={listId}>
                                    {folders.map((folder) => (
                                        <option key={folder} value={folder} />
                                    ))}
                                </datalist>
                            </>
                        )}
                    </Field>
                    {top && (
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={stripTop}
                                disabled={busy}
                                onChange={(event) => setStripTop(event.target.checked)}
                            />
                            Leave out the archive's top folder{" "}
                            <span className="font-mono">{top}/</span>
                        </label>
                    )}
                    {reading && <Spinner label="Reading files" />}
                    {readError !== undefined && <ErrorNotice error={readError} />}
                    {items && items.length === 0 && (
                        <Notice>
                            {picked?.kind === "zip" ? "The archive has no files." : "No files."}
                        </Notice>
                    )}
                    {plan.length > 0 && (
                        <section aria-label="Upload plan" className="flex flex-col gap-2">
                            <p className="text-sm" data-testid="upload-summary">
                                {[
                                    counts.new && `${counts.new} new`,
                                    counts.overwrite && `${counts.overwrite} overwritten`,
                                    counts.unchanged && `${counts.unchanged} unchanged`,
                                    skipped.length && `${skipped.length} skipped`,
                                    counts.duplicate && `${counts.duplicate} duplicate`,
                                ]
                                    .filter(Boolean)
                                    .join(", ")}
                                {picked?.kind === "zip" && (
                                    <span className="text-muted"> from {picked.file.name}</span>
                                )}
                            </p>
                            <ul
                                className="max-h-64 overflow-auto rounded-md border border-line"
                                data-testid="upload-plan"
                            >
                                {plan.map((row, index) => (
                                    <li
                                        key={`${row.path}-${index}`}
                                        className="flex items-center gap-2 border-b border-line px-2 py-1 text-[13px] last:border-b-0"
                                    >
                                        <Badge tone={TONES[row.status]} className="shrink-0">
                                            {row.status}
                                        </Badge>
                                        <span className="min-w-0 flex-1 font-mono text-[12.5px] break-all">
                                            {row.path}
                                            {row.reason && (
                                                <span className="block font-sans text-xs text-danger">
                                                    {row.reason}
                                                </span>
                                            )}
                                        </span>
                                        <span className="shrink-0 text-xs text-muted">
                                            {formatBytes(row.size)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                    {phase.step === "uploading" && (
                        <div className="flex flex-col gap-1">
                            <Progress
                                done={phase.done}
                                total={phase.total}
                                label="Upload progress"
                            />
                            <span className="text-xs text-muted">
                                Uploaded {phase.done} of {phase.total}
                            </span>
                        </div>
                    )}
                    {syncError !== undefined && <ErrorNotice error={syncError} />}
                </div>
            )}
        </Dialog>
    );
};

const FailureList = ({ failures }: { failures: Failure[] }) => (
    <ul
        className="max-h-64 overflow-auto rounded-md border border-line"
        data-testid="upload-failures"
    >
        {failures.map((failure) => (
            <li
                key={failure.path}
                className="border-b border-line px-2 py-1 text-[13px] last:border-b-0"
            >
                <span className="font-mono text-[12.5px] break-all">{failure.path}</span>
                <span className="block text-xs text-danger">{failure.reason}</span>
            </li>
        ))}
    </ul>
);

/** A drop target inside the dialog, for files and folders from the desktop. */
const DropArea = ({
    disabled,
    onPicked,
}: {
    disabled: boolean;
    onPicked: (picked: Picked) => void;
}) => {
    const [over, setOver] = useState(false);
    return (
        <div
            onDragOver={(event) => {
                if (disabled || !event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                if (disabled) return;
                event.preventDefault();
                setOver(false);
                void readDrop(event.dataTransfer).then((picked) => picked && onPicked(picked));
            }}
            className={cx(
                "rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted",
                over ? "border-accent bg-accent-soft text-accent" : "border-line-strong",
            )}
        >
            Or drop files, folders or a zip here.
        </div>
    );
};
