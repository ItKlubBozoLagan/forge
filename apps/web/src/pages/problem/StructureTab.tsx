import {
    Issue,
    languageOf,
    MANIFEST_PATH,
    parseManifest,
    Plan,
    planBuild,
    readManifestDraft,
} from "@forge/core";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Save, Undo2 } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { BlockerFunction, useBlocker } from "react-router";

import { IssueList } from "../../components/IssueList";
import { ApiError } from "../../lib/api";
import { loadTextFile, saveTextFile } from "../../lib/manifest";
import { can, keys, useTree } from "../../lib/queries";
import { Badge } from "../../ui/Badge";
import { Button, ButtonLink } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { EmptyState, ErrorNotice, Loading, Notice } from "../../ui/misc";
import { useToast } from "../../ui/Toast";
import { useProblemContext } from "./ProblemLayout";
import { Op } from "./structure/controls";
import {
    ConstraintsSection,
    GeneralSection,
    GeneratorsSection,
    SectionProps,
} from "./structure/GeneralSections";
import { GroupsSection } from "./structure/GroupsSection";
import { SolutionsSection } from "./structure/SolutionsSection";

/**
 * The working copy's problem.yaml being edited. `ops` are the edits made since it was loaded or
 * saved, kept so they can be replayed on a newer server version after a conflict.
 */
type Draft = {
    base?: string;
    original: string;
    text: string;
    ops: Op[];
    /** When `base` was last known to match the server. */
    syncedAt: number;
};

const isDirty = (draft: Draft | undefined) => !!draft && draft.text !== draft.original;

/** Replays edits on another text; edits that no longer apply are dropped and counted. */
const replay = (text: string, ops: Op[]) => {
    let result = text;
    const kept: Op[] = [];
    let failed = 0;
    for (const op of ops) {
        try {
            result = op(result);
            kept.push(op);
        } catch {
            failed++;
        }
    }
    return { text: result, ops: kept, failed };
};

export const StructureTab = () => {
    const { problem, editor } = useProblemContext();
    const writable = can(problem.role, "write");
    const tree = useTree(problem.id);
    const queryClient = useQueryClient();
    const toast = useToast();

    const [draft, setDraftState] = useState<Draft>();
    const [loadError, setLoadError] = useState<unknown>();
    const [saving, setSaving] = useState(false);
    const [conflict, setConflict] = useState(false);
    const [stale, setStale] = useState(false);
    // kept in a ref as well so a field committing on blur is saved by a click right after it
    const draftRef = useRef(draft);
    const setDraft = useCallback((next: Draft | undefined) => {
        draftRef.current = next;
        setDraftState(next);
    }, []);

    const files = useMemo(() => tree.data?.files ?? [], [tree.data]);
    const paths = useMemo(() => files.map((file) => file.path), [files]);
    const programs = useMemo(() => paths.filter((path) => languageOf(path)), [paths]);
    const manifestEntry = files.find((file) => file.path === MANIFEST_PATH);

    const refresh = useCallback(
        () =>
            Promise.all([
                queryClient.invalidateQueries({ queryKey: keys.tree(problem.id) }),
                queryClient.invalidateQueries({ queryKey: keys.problem(problem.id) }),
            ]),
        [queryClient, problem.id],
    );

    const fetchServer = useCallback(async () => {
        const loaded = await loadTextFile(problem.id, MANIFEST_PATH);
        return { ...loaded, syncedAt: Date.now() };
    }, [problem.id]);

    const load = useCallback(async () => {
        setLoadError(undefined);
        try {
            const server = await fetchServer();
            setDraft({ ...server, original: server.text, ops: [] });
            setStale(false);
            setConflict(false);
        } catch (error) {
            setLoadError(error);
        }
    }, [fetchServer, setDraft]);

    const hasManifest = !!manifestEntry;
    useEffect(() => {
        if (hasManifest && !draftRef.current) void load();
    }, [hasManifest, load]);

    // someone saved problem.yaml elsewhere: follow it, or warn when there are local edits
    useEffect(() => {
        const current = draftRef.current;
        if (!current || !manifestEntry || saving) return;
        if (tree.dataUpdatedAt <= current.syncedAt || manifestEntry.hash === current.base) return;
        if (isDirty(current)) setStale(true);
        else void load();
    }, [manifestEntry, tree.dataUpdatedAt, saving, load]);

    const apply = useCallback(
        (op: Op) => {
            const current = draftRef.current;
            if (!current || !writable) return;
            let text: string;
            try {
                text = op(current.text);
            } catch (error) {
                toast.error(error);
                return;
            }
            if (text === current.text) return;
            setDraft({ ...current, text, ops: [...current.ops, op] });
        },
        [writable, toast, setDraft],
    );

    const save = useCallback(
        async (force = false): Promise<boolean> => {
            const current = draftRef.current;
            if (!current || !writable || !isDirty(current)) return true;
            setSaving(true);
            try {
                const result = await saveTextFile(
                    problem.id,
                    MANIFEST_PATH,
                    current.text,
                    force ? undefined : current.base,
                );
                const latest = draftRef.current ?? current;
                setDraft({
                    ...latest,
                    base: result.hash,
                    original: current.text,
                    // edits made while saving stay unsaved
                    ops: latest.ops.slice(current.ops.length),
                    syncedAt: Date.now(),
                });
                setConflict(false);
                setStale(false);
                void refresh();
                return true;
            } catch (error) {
                if (error instanceof ApiError && error.status === 409) setConflict(true);
                else toast.error(error);
                return false;
            } finally {
                setSaving(false);
            }
        },
        [problem.id, writable, refresh, toast, setDraft],
    );

    const rebase = async () => {
        const current = draftRef.current;
        if (!current) return;
        try {
            const server = await fetchServer();
            const replayed = replay(server.text, current.ops);
            setDraft({ ...server, original: server.text, text: replayed.text, ops: replayed.ops });
            setConflict(false);
            setStale(false);
            if (replayed.failed > 0)
                toast.error(
                    `${replayed.failed} of your changes no longer apply to the new version and were dropped.`,
                );
            else toast.success("Your changes are applied to the new version. Save to keep them.");
        } catch (error) {
            toast.error(error);
        }
    };

    // Build and Commit in the header save pending edits first
    useEffect(() => {
        editor.current = {
            path: MANIFEST_PATH,
            dirty: () => isDirty(draftRef.current),
            save: () => save(),
        };
        return () => {
            editor.current = null;
        };
    }, [editor, save]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (isDirty(draftRef.current)) void save();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [save]);

    const dirty = isDirty(draft);
    useEffect(() => {
        if (!dirty) return;
        const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [dirty]);

    const blocker = useBlocker(
        useCallback<BlockerFunction>(
            ({ currentLocation, nextLocation }) =>
                isDirty(draftRef.current) && currentLocation.pathname !== nextLocation.pathname,
            [],
        ),
    );

    const text = draft?.text ?? "";
    const deferredText = useDeferredValue(text);
    const view = useMemo(() => readManifestDraft(text), [text]);
    const checked = useMemo((): { issues: Issue[]; plan?: Plan } => {
        try {
            const parsed = parseManifest(deferredText);
            if (!parsed.manifest) return { issues: parsed.issues };
            return planBuild(parsed.manifest, paths);
        } catch (error) {
            return { issues: [{ severity: "error", code: "manifest.check", message: String(error) }] };
        }
    }, [deferredText, paths]);

    if (tree.isPending) return <Loading />;
    if (tree.error) return <ErrorNotice error={tree.error} />;
    if (!manifestEntry)
        return (
            <EmptyState
                title="No problem.yaml"
                action={
                    <ButtonLink to={`/p/${problem.id}/files`}>Open the Files tab</ButtonLink>
                }
            >
                The structure is read from problem.yaml. Create it in the Files tab first.
            </EmptyState>
        );
    if (loadError !== undefined) return <ErrorNotice error={loadError} />;
    if (!draft) return <Loading label="Loading problem.yaml" />;

    const textLink = (
        <ButtonLink
            size="sm"
            variant="ghost"
            icon={<FileText className="size-3.5" />}
            to={`/p/${problem.id}/files?path=${MANIFEST_PATH}`}
        >
            Edit as text
        </ButtonLink>
    );
    const errors = checked.issues.filter((issue) => issue.severity === "error").length;
    const warnings = checked.issues.length - errors;
    const readOnly = !writable;
    const props: SectionProps | undefined = view.draft && {
        draft: view.draft,
        apply,
        readOnly,
        paths,
        programs,
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] font-medium">{MANIFEST_PATH}</span>
                {readOnly && <Badge>read-only</Badge>}
                {errors > 0 ? (
                    <Badge tone="danger">
                        {errors} error{errors === 1 ? "" : "s"}
                    </Badge>
                ) : (
                    <Badge tone="success">no errors</Badge>
                )}
                {warnings > 0 && (
                    <Badge tone="warning">
                        {warnings} warning{warnings === 1 ? "" : "s"}
                    </Badge>
                )}
                <div className="ml-auto">{textLink}</div>
            </div>

            {stale && (
                <Notice tone="warning">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="flex-1">
                            problem.yaml was changed by someone else since you opened it.
                        </span>
                        <Button size="sm" onClick={() => void rebase()}>
                            Apply my changes to the new version
                        </Button>
                    </div>
                </Notice>
            )}

            {!props ? (
                <div className="flex flex-col gap-2">
                    <Notice tone="warning">
                        problem.yaml cannot be shown as forms until it is fixed.
                    </Notice>
                    <IssueList
                        testId="structure-issues"
                        issues={view.problems.map((message) => ({
                            severity: "error",
                            code: "manifest.yaml",
                            message,
                            ref: MANIFEST_PATH,
                        }))}
                    />
                    <div>
                        <ButtonLink
                            variant="primary"
                            to={`/p/${problem.id}/files?path=${MANIFEST_PATH}`}
                        >
                            Edit problem.yaml as text
                        </ButtonLink>
                    </div>
                </div>
            ) : (
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
                    <div className="flex min-w-0 flex-col gap-3">
                        <GeneralSection {...props} />
                        <ConstraintsSection {...props} />
                        <GeneratorsSection {...props} />
                        <GroupsSection {...props} plan={checked.plan} />
                        <SolutionsSection {...props} />
                    </div>
                    <aside className="min-w-0 lg:sticky lg:top-14 lg:max-h-[calc(100dvh-72px)] lg:self-start lg:overflow-auto">
                        <h3 className="mb-1 text-xs font-medium text-muted">
                            Check (in the browser, before building)
                        </h3>
                        {checked.issues.length === 0 ? (
                            <Notice tone="success">No problems found in problem.yaml.</Notice>
                        ) : (
                            <IssueList issues={checked.issues} testId="structure-issues" />
                        )}
                    </aside>
                </div>
            )}

            {writable && (
                <div
                    data-testid="structure-savebar"
                    className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-t-lg border border-line bg-surface px-3 py-2 shadow-[var(--shadow)]"
                >
                    {dirty ? (
                        <Badge tone="warning">unsaved changes</Badge>
                    ) : (
                        <span className="text-sm text-muted">All changes saved</span>
                    )}
                    <div className="ml-auto flex gap-2">
                        <Button
                            icon={<Undo2 className="size-4" />}
                            disabled={!dirty || saving}
                            onClick={() => void load()}
                        >
                            Discard
                        </Button>
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
                    </div>
                </div>
            )}

            <Dialog
                open={conflict}
                onClose={() => setConflict(false)}
                title="problem.yaml changed on the server"
                description="Someone saved problem.yaml after you opened it."
                footer={
                    <>
                        <Button onClick={() => setConflict(false)}>Cancel</Button>
                        <Button variant="danger" onClick={() => void load()}>
                            Discard mine
                        </Button>
                        <Button variant="danger" pending={saving} onClick={() => void save(true)}>
                            Overwrite
                        </Button>
                        <Button variant="primary" onClick={() => void rebase()}>
                            Apply mine to theirs
                        </Button>
                    </>
                }
            >
                <p className="text-sm">
                    <strong>Apply mine to theirs</strong> loads the new version and repeats your{" "}
                    {draft.ops.length} change{draft.ops.length === 1 ? "" : "s"} on it, for you to
                    review and save. <strong>Overwrite</strong> replaces their version with yours.
                </p>
            </Dialog>

            <Dialog
                open={blocker.state === "blocked"}
                onClose={() => blocker.reset?.()}
                title="Leave with unsaved changes?"
                description="problem.yaml has changes that are not saved."
                footer={
                    <>
                        <Button onClick={() => blocker.reset?.()}>Stay</Button>
                        <Button variant="danger" onClick={() => blocker.proceed?.()}>
                            Discard and leave
                        </Button>
                        <Button
                            variant="primary"
                            pending={saving}
                            onClick={async () => {
                                if (await save()) blocker.proceed?.();
                            }}
                        >
                            Save and leave
                        </Button>
                    </>
                }
            />
        </div>
    );
};
