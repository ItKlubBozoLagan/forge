import {
    Issue,
    MANIFEST_PATH,
    parseManifest,
    planBuild,
    removeReferences,
    renameReferences,
} from "@forge/core";
import { useQueryClient } from "@tanstack/react-query";
import { FileDiff, FilePlus2, Save, Upload } from "lucide-react";
import {
    FormEvent,
    useCallback,
    useDeferredValue,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { BlockerFunction, Link, useBlocker, useSearchParams } from "react-router";

import { CodeEditor } from "../../components/CodeEditor";
import { IssueList } from "../../components/IssueList";
import { api, ApiError, decodeText, encodeText, isBinary, q } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { deleteFile, followManifest, renameFile } from "../../lib/manifest";
import { can, keys, useTree } from "../../lib/queries";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Field, Input } from "../../ui/Field";
import { EmptyState, ErrorNotice, Loading, Notice, Spinner } from "../../ui/misc";
import { useToast } from "../../ui/Toast";
import { FileTree } from "./FileTree";
import { DownloadPackageButton, useBulkFiles } from "./files/BulkFiles";
import { useLineComments } from "./files/LineComments";
import { useProblemContext } from "./ProblemLayout";

/** Files above this size are not loaded into the editor. */
const EDITOR_LIMIT = 2 * 1024 * 1024;

type Doc = {
    path: string;
    /** Hash of the content as loaded/saved; sent as If-Match. */
    base?: string;
    original: string;
    text: string;
    kind: "text" | "binary" | "large";
    size: number;
};

const isDirty = (doc: Doc | undefined) => !!doc && doc.kind === "text" && doc.text !== doc.original;

const validatePath = (path: string, existing: string[]): string | undefined => {
    if (!path) return "Enter a path";
    if (path.startsWith("/") || path.split("/").includes("..") || path.split("/").includes(""))
        return "Use a relative path like solutions/fast.cpp";
    if (existing.includes(path)) return "A file with this path already exists";
    return undefined;
};

export const FilesTab = () => {
    const { problem, editor } = useProblemContext();
    const writable = can(problem.role, "write");
    const tree = useTree(problem.id);
    const queryClient = useQueryClient();
    const toast = useToast();
    const [params, setParams] = useSearchParams();

    const files = useMemo(() => tree.data?.files ?? [], [tree.data]);
    const paths = useMemo(() => files.map((file) => file.path), [files]);
    const requested = params.get("path");
    const selected =
        requested ?? (paths.includes(MANIFEST_PATH) ? MANIFEST_PATH : paths[0]) ?? undefined;

    const [doc, setDoc] = useState<Doc>();
    const [loadError, setLoadError] = useState<unknown>();
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [conflict, setConflict] = useState(false);
    const [pendingSwitch, setPendingSwitch] = useState<string>();
    const [creating, setCreating] = useState(false);
    const [renaming, setRenaming] = useState<string>();
    const [deleting, setDeleting] = useState<string>();
    const docRef = useRef(doc);
    docRef.current = doc;
    const loadSeq = useRef(0);

    const refreshTree = useCallback(
        () =>
            Promise.all([
                queryClient.invalidateQueries({ queryKey: keys.tree(problem.id) }),
                queryClient.invalidateQueries({ queryKey: keys.problem(problem.id) }),
            ]),
        [queryClient, problem.id],
    );

    const load = useCallback(
        async (path: string) => {
            const seq = ++loadSeq.current;
            setLoading(true);
            setLoadError(undefined);
            try {
                const { bytes, etag } = await api.bytes(
                    `/problems/${problem.id}/file${q({ path })}`,
                );
                if (seq !== loadSeq.current) return;
                const base = etag?.replace(/^W\//, "").replace(/"/g, "");
                if (bytes.length > EDITOR_LIMIT)
                    setDoc({
                        path,
                        base,
                        original: "",
                        text: "",
                        kind: "large",
                        size: bytes.length,
                    });
                else if (isBinary(bytes))
                    setDoc({
                        path,
                        base,
                        original: "",
                        text: "",
                        kind: "binary",
                        size: bytes.length,
                    });
                else {
                    const text = decodeText(bytes);
                    setDoc({ path, base, original: text, text, kind: "text", size: bytes.length });
                }
            } catch (error) {
                if (seq !== loadSeq.current) return;
                setDoc(undefined);
                setLoadError(error);
            } finally {
                if (seq === loadSeq.current) setLoading(false);
            }
        },
        [problem.id],
    );

    useEffect(() => {
        if (selected) void load(selected);
        else setDoc(undefined);
    }, [selected, load]);

    const save = useCallback(
        async (force = false): Promise<boolean> => {
            const current = docRef.current;
            if (!current || current.kind !== "text" || !writable) return true;
            setSaving(true);
            const text = current.text;
            try {
                const result = await api.putBytes<{ hash: string; size: number }>(
                    `/problems/${problem.id}/file${q({ path: current.path })}`,
                    encodeText(text),
                    !force && current.base ? { "If-Match": current.base } : undefined,
                );
                setDoc((latest) =>
                    latest && latest.path === current.path
                        ? { ...latest, base: result.hash, original: text, size: result.size }
                        : latest,
                );
                setConflict(false);
                void refreshTree();
                return true;
            } catch (error) {
                if (error instanceof ApiError && error.status === 409) setConflict(true);
                else toast.error(error);
                return false;
            } finally {
                setSaving(false);
            }
        },
        [problem.id, writable, refreshTree, toast],
    );

    // let Build / Commit in the header save pending edits first
    useEffect(() => {
        editor.current = {
            get path() {
                return docRef.current?.path ?? "";
            },
            dirty: () => isDirty(docRef.current),
            save: () => save(),
        };
        return () => {
            editor.current = null;
        };
    }, [editor, save]);

    // Ctrl/Cmd+S
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (isDirty(docRef.current)) void save();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [save]);

    const dirty = isDirty(doc);
    useEffect(() => {
        if (!dirty) return;
        const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [dirty]);

    const blocker = useBlocker(
        useCallback<BlockerFunction>(
            ({ currentLocation, nextLocation }) =>
                isDirty(docRef.current) && currentLocation.pathname !== nextLocation.pathname,
            [],
        ),
    );

    const open = (path: string) => setParams({ path }, { replace: false });
    const requestOpen = (path: string) => {
        if (path === selected) return;
        if (dirty) setPendingSwitch(path);
        else open(path);
    };

    const text = doc?.kind === "text" ? doc.text : "";
    const deferredText = useDeferredValue(text);
    const manifestIssues = useMemo((): Issue[] | undefined => {
        if (doc?.path !== MANIFEST_PATH || doc.kind !== "text") return undefined;
        try {
            const parsed = parseManifest(deferredText);
            if (!parsed.manifest) return parsed.issues;
            return planBuild(parsed.manifest, paths).issues;
        } catch (error) {
            return [{ severity: "error", code: "manifest.check", message: String(error) }];
        }
    }, [doc?.path, doc?.kind, deferredText, paths]);

    const bulk = useBulkFiles({
        problemId: problem.id,
        files,
        writable,
        onReloadTree: refreshTree,
        onApplied: async (changed, deleted) => {
            await refreshTree();
            const current = docRef.current;
            if (!current || !changed.includes(current.path)) return;
            if (deleted) {
                setDoc(undefined);
                setParams({}, { replace: true });
            } else if (!isDirty(current)) void load(current.path);
        },
    });
    const comments = useLineComments({
        problemId: problem.id,
        path: doc?.kind === "text" ? doc.path : undefined,
        enabled: can(problem.role, "read"),
    });

    if (tree.isPending) return <Loading />;
    if (tree.error) return <ErrorNotice error={tree.error} />;

    const newFileButton = writable && (
        <Button
            size="sm"
            icon={<FilePlus2 className="size-3.5" />}
            onClick={() => setCreating(true)}
        >
            New file
        </Button>
    );

    return (
        <div className="grid gap-3 md:grid-cols-[240px_minmax(0,1fr)]">
            <aside
                {...bulk.dropProps}
                className={cx(
                    "min-w-0 rounded-lg border border-line bg-surface p-1.5 md:max-h-[calc(100dvh-220px)] md:overflow-auto",
                    bulk.dragging && "border-accent bg-accent-soft",
                )}
            >
                <div className="mb-1 flex items-center justify-between gap-1 px-1">
                    <span className="text-xs font-medium text-muted">Files</span>
                    <div className="flex gap-1">
                        {newFileButton}
                        {writable && (
                            <Button
                                size="sm"
                                aria-label="Upload files"
                                title="Upload files, a folder or a zip"
                                icon={<Upload className="size-3.5" />}
                                onClick={bulk.openUpload}
                            />
                        )}
                        <DownloadPackageButton
                            problemId={problem.id}
                            name={problem.name}
                            iconOnly
                        />
                    </div>
                </div>
                {bulk.dragging && (
                    <p className="px-1 pb-1 text-xs text-accent">
                        Drop to upload. Drop on a folder to upload into it.
                    </p>
                )}
                {problem.dirty && problem.head && (
                    <Link
                        to={`/p/${problem.id}/revisions/compare${q({ from: problem.head.id, to: "working" })}`}
                        className="mb-1 flex items-center gap-1 px-1 text-xs text-accent hover:underline"
                    >
                        <FileDiff className="size-3.5" aria-hidden />
                        Changes since revision {problem.head.number}
                    </Link>
                )}
                {files.length === 0 ? (
                    <p className="px-2 py-4 text-[13px] text-muted">
                        No files yet.
                        {writable ? " Create problem.yaml to describe the problem." : ""}
                    </p>
                ) : (
                    <FileTree
                        files={files}
                        selected={selected}
                        dirtyPath={dirty ? doc?.path : undefined}
                        writable={writable}
                        onSelect={requestOpen}
                        onRename={setRenaming}
                        onDelete={setDeleting}
                        onDeleteFolder={bulk.deleteFolder}
                    />
                )}
            </aside>

            <section className="flex min-w-0 flex-col gap-2">
                {!selected ? (
                    <EmptyState title="No file open" action={newFileButton}>
                        {files.length === 0
                            ? "This problem has no files. Create one to get started."
                            : "Pick a file on the left to view or edit it."}
                    </EmptyState>
                ) : (
                    <>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="min-w-0 truncate font-mono text-[13px] font-medium">
                                {selected}
                            </span>
                            {doc && (
                                <span className="text-xs text-muted">{formatBytes(doc.size)}</span>
                            )}
                            {dirty && <Badge tone="warning">unsaved</Badge>}
                            {!writable && <Badge>read-only</Badge>}
                            {loading && <Spinner label="Loading file" />}
                            <div className="ml-auto flex gap-2">
                                {doc?.kind === "text" && doc.path === selected && comments.action}
                                {writable && doc?.kind === "text" && (
                                    <Button
                                        variant={dirty ? "primary" : "secondary"}
                                        icon={<Save className="size-4" />}
                                        pending={saving}
                                        disabled={!dirty}
                                        title="Save (Ctrl+S)"
                                        onClick={() => void save()}
                                    >
                                        Save
                                    </Button>
                                )}
                            </div>
                        </div>
                        {loadError !== undefined && <ErrorNotice error={loadError} />}
                        {doc && doc.path === selected && doc.kind !== "text" && (
                            <Notice>
                                {doc.kind === "binary"
                                    ? "This is a binary file and cannot be edited here."
                                    : `This file is too large to edit in the browser (${formatBytes(doc.size)}).`}{" "}
                                <a
                                    className="text-accent underline"
                                    href={`/api/problems/${problem.id}/file${q({ path: doc.path })}`}
                                    download={doc.path.split("/").pop()}
                                >
                                    Download it
                                </a>
                                .
                            </Notice>
                        )}
                        {doc && doc.path === selected && doc.kind === "text" && (
                            <CodeEditor
                                key={doc.path}
                                label={`Contents of ${doc.path}`}
                                language={doc.path}
                                value={doc.text}
                                readOnly={!writable}
                                {...comments.editorProps}
                                onChange={(value) =>
                                    setDoc((current) =>
                                        current ? { ...current, text: value } : current,
                                    )
                                }
                                className="h-[calc(100dvh-300px)] min-h-[360px] rounded-lg border border-line"
                            />
                        )}
                        {doc && doc.path === selected && doc.kind === "text" && comments.panel}
                        {manifestIssues && (
                            <div>
                                <h3 className="mb-1 text-xs font-medium text-muted">
                                    problem.yaml check (in the browser, before building)
                                </h3>
                                {manifestIssues.length === 0 ? (
                                    <Notice tone="success">
                                        No problems found in problem.yaml.
                                    </Notice>
                                ) : (
                                    <IssueList issues={manifestIssues} testId="manifest-issues" />
                                )}
                            </div>
                        )}
                    </>
                )}
            </section>

            <Dialog
                open={conflict}
                onClose={() => setConflict(false)}
                title="The file changed on the server"
                description={`Someone saved ${doc?.path ?? "this file"} after you opened it.`}
                footer={
                    <>
                        <Button onClick={() => setConflict(false)}>Cancel</Button>
                        <Button
                            onClick={() => {
                                setConflict(false);
                                if (doc) void load(doc.path);
                            }}
                        >
                            Reload
                        </Button>
                        <Button variant="danger" pending={saving} onClick={() => void save(true)}>
                            Overwrite
                        </Button>
                    </>
                }
            >
                <p className="text-sm">
                    <strong>Reload</strong> discards your edits and loads the server version.{" "}
                    <strong>Overwrite</strong> replaces the server version with yours.
                </p>
            </Dialog>

            <Dialog
                open={!!pendingSwitch}
                onClose={() => setPendingSwitch(undefined)}
                title="Unsaved changes"
                description={`${doc?.path ?? "The open file"} has changes that are not saved.`}
                footer={
                    <>
                        <Button onClick={() => setPendingSwitch(undefined)}>Cancel</Button>
                        <Button
                            variant="danger"
                            onClick={() => {
                                const target = pendingSwitch!;
                                setPendingSwitch(undefined);
                                setDoc(undefined);
                                open(target);
                            }}
                        >
                            Discard changes
                        </Button>
                        {writable && (
                            <Button
                                variant="primary"
                                pending={saving}
                                onClick={async () => {
                                    const target = pendingSwitch!;
                                    if (await save()) {
                                        setPendingSwitch(undefined);
                                        open(target);
                                    }
                                }}
                            >
                                Save and open
                            </Button>
                        )}
                    </>
                }
            >
                <p className="text-sm">
                    Open <span className="font-mono">{pendingSwitch}</span> without saving?
                </p>
            </Dialog>

            <Dialog
                open={blocker.state === "blocked"}
                onClose={() => blocker.reset?.()}
                title="Leave with unsaved changes?"
                description={`${doc?.path ?? "The open file"} has changes that are not saved.`}
                footer={
                    <>
                        <Button onClick={() => blocker.reset?.()}>Stay</Button>
                        <Button variant="danger" onClick={() => blocker.proceed?.()}>
                            Discard and leave
                        </Button>
                    </>
                }
            />

            {bulk.dialogs}
            {comments.dialog}

            <NewFileDialog
                open={creating}
                onClose={() => setCreating(false)}
                paths={paths}
                onCreate={async (path, bytes) => {
                    await api.putBytes(`/problems/${problem.id}/file${q({ path })}`, bytes);
                    await refreshTree();
                    setCreating(false);
                    if (!dirty) open(path);
                    toast.success(`Created ${path}`);
                }}
            />

            <RenameDialog
                path={renaming}
                paths={paths}
                onClose={() => setRenaming(undefined)}
                onRename={async (from, to) => {
                    // problem.yaml follows the rename in the same atomic change
                    const manifest = await renameFile(problem.id, files, from, to).finally(
                        refreshTree,
                    );
                    setDoc((current) =>
                        followManifest(current, manifest, (text) =>
                            renameReferences(text, from, to),
                        ),
                    );
                    setRenaming(undefined);
                    if (from === selected) {
                        setDoc((current) => (current ? { ...current, path: to } : current));
                        setParams({ path: to }, { replace: true });
                    }
                    toast.success(`Renamed to ${to}${manifest ? "; problem.yaml updated" : ""}`);
                }}
            />

            <ConfirmDialog
                open={!!deleting}
                onClose={() => setDeleting(undefined)}
                title="Delete file"
                message={
                    <>
                        Delete <span className="font-mono">{deleting}</span> from the working copy?
                        Committed revisions keep their copy. References to it in problem.yaml are
                        removed.
                    </>
                }
                confirmLabel="Delete"
                danger
                onConfirm={async () => {
                    const path = deleting!;
                    const manifest = await deleteFile(problem.id, files, path).finally(
                        refreshTree,
                    );
                    setDoc((current) =>
                        followManifest(current, manifest, (text) => removeReferences(text, path)),
                    );
                    if (path === selected) {
                        setDoc(undefined);
                        setParams({}, { replace: true });
                    }
                    toast.success(`Deleted ${path}${manifest ? "; problem.yaml updated" : ""}`);
                }}
            />
        </div>
    );
};

const NewFileDialog = ({
    open,
    onClose,
    paths,
    onCreate,
}: {
    open: boolean;
    onClose: () => void;
    paths: string[];
    onCreate: (path: string, bytes: Uint8Array) => Promise<void>;
}) => {
    const [path, setPath] = useState("");
    const [upload, setUpload] = useState<File>();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    const invalid = path ? validatePath(path.trim(), paths) : undefined;

    useEffect(() => {
        if (open) {
            setPath("");
            setUpload(undefined);
            setError(undefined);
        }
    }, [open]);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const target = path.trim();
        if (validatePath(target, paths)) return;
        setPending(true);
        setError(undefined);
        try {
            const bytes = upload ? new Uint8Array(await upload.arrayBuffer()) : new Uint8Array();
            await onCreate(target, bytes);
        } catch (caught) {
            setError(caught);
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} title="New file">
            <form onSubmit={submit} className="flex flex-col gap-3">
                <Field
                    label="Path"
                    hint="Folders are created from the path, e.g. solutions/fast.cpp or tests/02.in."
                    error={invalid}
                >
                    {(id, describedBy) => (
                        <Input
                            id={id}
                            value={path}
                            autoFocus
                            required
                            className="font-mono"
                            aria-describedby={describedBy}
                            aria-invalid={!!invalid || undefined}
                            onChange={(event) => setPath(event.target.value)}
                        />
                    )}
                </Field>
                <Field label="Upload from computer (optional)">
                    {(id) => (
                        <input
                            id={id}
                            type="file"
                            className="text-sm file:mr-2 file:rounded-md file:border file:border-line file:bg-surface-2 file:px-2 file:py-1 file:text-sm"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                setUpload(file);
                                if (file && !path) setPath(file.name);
                            }}
                        />
                    )}
                </Field>
                {error !== undefined && <ErrorNotice error={error} />}
                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>Cancel</Button>
                    <Button
                        type="submit"
                        variant="primary"
                        pending={pending}
                        disabled={!path.trim() || !!invalid}
                    >
                        Create file
                    </Button>
                </div>
            </form>
        </Dialog>
    );
};

const RenameDialog = ({
    path,
    paths,
    onClose,
    onRename,
}: {
    path?: string;
    paths: string[];
    onClose: () => void;
    onRename: (from: string, to: string) => Promise<void>;
}) => {
    const [target, setTarget] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    useEffect(() => {
        if (path) {
            setTarget(path);
            setError(undefined);
        }
    }, [path]);
    const invalid = target && target !== path ? validatePath(target.trim(), paths) : undefined;
    return (
        <Dialog open={!!path} onClose={onClose} title={`Rename ${path ?? ""}`}>
            <form
                className="flex flex-col gap-3"
                onSubmit={async (event) => {
                    event.preventDefault();
                    if (!path || invalid || target.trim() === path) return;
                    setPending(true);
                    setError(undefined);
                    try {
                        await onRename(path, target.trim());
                    } catch (caught) {
                        setError(caught);
                    } finally {
                        setPending(false);
                    }
                }}
            >
                <Field label="New path" error={invalid}>
                    {(id, describedBy) => (
                        <Input
                            id={id}
                            value={target}
                            autoFocus
                            className="font-mono"
                            aria-describedby={describedBy}
                            onChange={(event) => setTarget(event.target.value)}
                        />
                    )}
                </Field>
                <p className="text-xs text-muted">
                    References to it in problem.yaml are updated too.
                </p>
                {error !== undefined && <ErrorNotice error={error} />}
                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>Cancel</Button>
                    <Button
                        type="submit"
                        variant="primary"
                        pending={pending}
                        disabled={!target.trim() || target.trim() === path || !!invalid}
                    >
                        Rename
                    </Button>
                </div>
            </form>
        </Dialog>
    );
};
