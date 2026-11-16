import { useQueryClient } from "@tanstack/react-query";
import { GitCommitHorizontal, Hammer } from "lucide-react";
import { createContext, FormEvent, MutableRefObject, useContext, useRef, useState } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from "react-router";

import { api, ApiError } from "../../lib/api";
import { can, keys, useProblem } from "../../lib/queries";
import type { Problem } from "../../lib/types";
import { useSyncWorkspace } from "../../lib/workspace";
import { Badge, RoleBadge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Field, Input } from "../../ui/Field";
import { EmptyState, ErrorNotice, Loading, Notice } from "../../ui/misc";
import { NavTabs } from "../../ui/Tabs";
import { useToast } from "../../ui/Toast";

/** The file editor registers itself here so Build/Commit can save pending edits first. */
export type EditorHandle = { path: string; dirty: () => boolean; save: () => Promise<boolean> };

type ProblemContextValue = { problem: Problem; editor: MutableRefObject<EditorHandle | null> };
const ProblemContext = createContext<ProblemContextValue | null>(null);

export const useProblemContext = () => {
    const context = useContext(ProblemContext);
    if (!context) throw new Error("useProblemContext outside ProblemLayout");
    return context;
};

const TESTER_TABS = ["statement", "invocations", "review"];

const tabsFor = (problem: Problem) => {
    const base = `/p/${problem.id}`;
    const all = [
        { to: `${base}/files`, label: "Files", key: "files" },
        { to: `${base}/statement`, label: "Statement", key: "statement" },
        { to: `${base}/builds`, label: "Builds", key: "builds" },
        { to: `${base}/revisions`, label: "Revisions", key: "revisions" },
        { to: `${base}/stress`, label: "Stress", key: "stress" },
        { to: `${base}/invocations`, label: "Invocations", key: "invocations" },
        { to: `${base}/review`, label: "Review", key: "review" },
        { to: `${base}/access`, label: "Access", key: "access" },
    ];
    return problem.role === "tester" ? all.filter((tab) => TESTER_TABS.includes(tab.key)) : all;
};

/** Saves the editor's pending changes, if any. Returns false when saving failed. */
const flushEditor = async (editor: MutableRefObject<EditorHandle | null>) => {
    const handle = editor.current;
    if (!handle || !handle.dirty()) return true;
    return handle.save();
};

const CommitDialog = ({
    open,
    onClose,
    problem,
    editor,
}: {
    open: boolean;
    onClose: () => void;
    problem: Problem;
    editor: MutableRefObject<EditorHandle | null>;
}) => {
    const [message, setMessage] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    const queryClient = useQueryClient();
    const toast = useToast();
    const navigate = useNavigate();
    const unsaved = editor.current?.dirty() ? editor.current.path : undefined;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        setError(undefined);
        try {
            if (!(await flushEditor(editor))) return;
            const result = await api.post<{ id: string; number: number; buildId: string }>(
                `/problems/${problem.id}/revisions`,
                { message: message.trim() },
            );
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: keys.problem(problem.id) }),
                queryClient.invalidateQueries({ queryKey: keys.revisions(problem.id) }),
                queryClient.invalidateQueries({ queryKey: ["builds", problem.id] }),
            ]);
            setMessage("");
            onClose();
            toast.success(`Committed revision ${result.number}; its build is queued.`, {
                label: "View build",
                onClick: () => navigate(`/p/${problem.id}/builds/${result.buildId}`),
            });
        } catch (caught) {
            setError(
                caught instanceof ApiError && caught.status === 409
                    ? new Error(`${caught.message}. Edit and save a file before committing.`)
                    : caught,
            );
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title="Commit working copy"
            description="Freezes the current files as a new revision and builds it."
        >
            <form onSubmit={submit} className="flex flex-col gap-3">
                <Field label="Message">
                    {(id) => (
                        <Input
                            id={id}
                            value={message}
                            required
                            autoFocus
                            placeholder="What changed?"
                            onChange={(event) => setMessage(event.target.value)}
                        />
                    )}
                </Field>
                {unsaved && (
                    <Notice tone="warning">
                        Unsaved changes in <span className="font-mono">{unsaved}</span> will be
                        saved first.
                    </Notice>
                )}
                {error !== undefined && <ErrorNotice error={error} />}
                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>Cancel</Button>
                    <Button
                        type="submit"
                        variant="primary"
                        pending={pending}
                        disabled={!message.trim()}
                    >
                        Commit
                    </Button>
                </div>
            </form>
        </Dialog>
    );
};

export const ProblemLayout = () => {
    const { problemId = "" } = useParams();
    const problem = useProblem(problemId);
    const editor = useRef<EditorHandle | null>(null);
    const location = useLocation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const toast = useToast();
    const [building, setBuilding] = useState(false);
    const [committing, setCommitting] = useState(false);
    useSyncWorkspace(problem.data?.workspace.id);

    if (problem.isPending) return <Loading />;
    if (problem.error)
        return problem.error instanceof ApiError && problem.error.status === 404 ? (
            <EmptyState title="Problem not found">
                It does not exist or you do not have access to it.
            </EmptyState>
        ) : (
            <ErrorNotice error={problem.error} />
        );

    const data = problem.data;
    const writable = can(data.role, "write");
    const segment = location.pathname.split("/")[3];
    if (data.role === "tester" && segment && !TESTER_TABS.includes(segment))
        return <Navigate to={`/p/${data.id}/statement`} replace />;

    const build = async () => {
        setBuilding(true);
        try {
            if (!(await flushEditor(editor))) return;
            const result = await api.post<{ id: string }>(`/problems/${data.id}/builds`, {});
            await queryClient.invalidateQueries({ queryKey: keys.builds(data.id, "build") });
            navigate(`/p/${data.id}/builds/${result.id}`);
        } catch (error) {
            toast.error(error);
        } finally {
            setBuilding(false);
        }
    };

    return (
        <ProblemContext.Provider value={{ problem: data, editor }}>
            <div className="mb-3 flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                    <div className="text-xs text-muted">
                        <Link
                            to={`/w/${data.workspace.id}`}
                            className="hover:text-fg hover:underline"
                        >
                            {data.workspace.name}
                        </Link>
                        <span aria-hidden> / </span>
                        <span className="font-mono">{data.name}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                        <h1 className="truncate text-lg font-semibold">{data.title}</h1>
                        <RoleBadge role={data.role} />
                        <Badge title="Latest committed revision">
                            {data.head ? `revision ${data.head.number}` : "no revisions"}
                        </Badge>
                        {data.dirty && (
                            <Badge
                                tone="warning"
                                title="The working copy differs from the latest revision"
                            >
                                uncommitted changes
                            </Badge>
                        )}
                    </div>
                </div>
                {writable && (
                    <div className="flex gap-2">
                        <Button
                            icon={<Hammer className="size-4" />}
                            pending={building}
                            onClick={build}
                            title="Build the working copy"
                        >
                            Build
                        </Button>
                        <Button
                            variant="primary"
                            icon={<GitCommitHorizontal className="size-4" />}
                            onClick={() => setCommitting(true)}
                        >
                            Commit
                        </Button>
                    </div>
                )}
            </div>
            <NavTabs label="Problem sections" links={tabsFor(data)} />
            <div className="pt-4">
                <Outlet />
            </div>
            <CommitDialog
                open={committing}
                onClose={() => setCommitting(false)}
                problem={data}
                editor={editor}
            />
        </ProblemContext.Provider>
    );
};

export const ProblemIndex = () => {
    const { problem } = useProblemContext();
    return (
        <Navigate
            to={`/p/${problem.id}/${problem.role === "tester" ? "statement" : "files"}`}
            replace
        />
    );
};
