import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { FormEvent, useState } from "react";

import { api } from "../../lib/api";
import { formatDate, formatRelative, plural } from "../../lib/format";
import { can, keys, useTree } from "../../lib/queries";
import type { Thread } from "../../lib/types";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Field, Input, Textarea } from "../../ui/Field";
import { EmptyState, ErrorNotice, Loading } from "../../ui/misc";
import { useToast } from "../../ui/Toast";
import { useProblemContext } from "./ProblemLayout";

const ThreadAnchor = ({ thread }: { thread: Thread }) =>
    thread.path ? (
        <span className="font-mono text-[12.5px]">
            {thread.path}
            {thread.line ? `:${thread.line}` : ""}
        </span>
    ) : (
        <span className="text-[13px] text-muted">General</span>
    );

const ThreadView = ({ thread }: { thread: Thread }) => {
    const { problem } = useProblemContext();
    const [reply, setReply] = useState("");
    const [pending, setPending] = useState<"reply" | "resolve">();
    const queryClient = useQueryClient();
    const toast = useToast();
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.threads(problem.id) });

    const submitReply = async (event: FormEvent) => {
        event.preventDefault();
        setPending("reply");
        try {
            await api.post(`/threads/${thread.id}/comments`, { body: reply.trim() });
            setReply("");
            await refresh();
        } catch (error) {
            toast.error(error);
        } finally {
            setPending(undefined);
        }
    };

    const setResolved = async (resolved: boolean) => {
        setPending("resolve");
        try {
            await api.patch(`/threads/${thread.id}`, { resolved });
            await refresh();
        } catch (error) {
            toast.error(error);
        } finally {
            setPending(undefined);
        }
    };

    return (
        <article
            aria-label={`Thread ${thread.id}`}
            className="rounded-lg border border-line bg-surface"
        >
            <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                <ThreadAnchor thread={thread} />
                {thread.resolved && <Badge tone="success">resolved</Badge>}
                <span className="text-xs text-muted" title={formatDate(thread.createdAt)}>
                    {formatRelative(thread.createdAt)}
                </span>
                <Button
                    size="sm"
                    className="ml-auto"
                    pending={pending === "resolve"}
                    onClick={() => setResolved(!thread.resolved)}
                >
                    {thread.resolved ? "Reopen" : "Resolve"}
                </Button>
            </header>
            <ol className="divide-y divide-line">
                {thread.comments.map((comment) => (
                    <li key={comment.id} className="px-3 py-2">
                        <div className="mb-0.5 flex items-baseline gap-2 text-xs">
                            <span className="font-medium text-fg">{comment.author}</span>
                            <span className="text-muted" title={formatDate(comment.createdAt)}>
                                {formatRelative(comment.createdAt)}
                            </span>
                        </div>
                        <p className="text-sm break-words whitespace-pre-wrap">{comment.body}</p>
                    </li>
                ))}
            </ol>
            <form onSubmit={submitReply} className="flex flex-col gap-2 border-t border-line p-3">
                <label htmlFor={`reply-${thread.id}`} className="sr-only">
                    Reply
                </label>
                <Textarea
                    id={`reply-${thread.id}`}
                    value={reply}
                    placeholder="Reply..."
                    className="min-h-14"
                    onChange={(event) => setReply(event.target.value)}
                />
                <div>
                    <Button
                        type="submit"
                        size="sm"
                        pending={pending === "reply"}
                        disabled={!reply.trim()}
                    >
                        Reply
                    </Button>
                </div>
            </form>
        </article>
    );
};

const NewThread = () => {
    const { problem } = useProblemContext();
    const readable = can(problem.role, "read");
    const tree = useTree(problem.id, readable);
    const [body, setBody] = useState("");
    const [path, setPath] = useState("");
    const [line, setLine] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    const queryClient = useQueryClient();

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        setError(undefined);
        try {
            const lineNumber = Number(line);
            await api.post(`/problems/${problem.id}/threads`, {
                body: body.trim(),
                ...(path.trim() ? { path: path.trim() } : {}),
                ...(path.trim() && line && Number.isInteger(lineNumber) && lineNumber > 0
                    ? { line: lineNumber }
                    : {}),
            });
            setBody("");
            setPath("");
            setLine("");
            await queryClient.invalidateQueries({ queryKey: keys.threads(problem.id) });
        } catch (caught) {
            setError(caught);
        } finally {
            setPending(false);
        }
    };

    return (
        <form
            onSubmit={submit}
            className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3"
        >
            <h2 className="text-[13px] font-semibold">Start a thread</h2>
            <Field label="Comment">
                {(id) => (
                    <Textarea
                        id={id}
                        value={body}
                        required
                        placeholder="A question, a bug in the statement, a test idea..."
                        onChange={(event) => setBody(event.target.value)}
                    />
                )}
            </Field>
            {readable && (
                <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                    <Field label="File (optional)">
                        {(id) => (
                            <>
                                <Input
                                    id={id}
                                    value={path}
                                    list="review-files"
                                    className="font-mono"
                                    placeholder="solutions/main.cpp"
                                    onChange={(event) => setPath(event.target.value)}
                                />
                                <datalist id="review-files">
                                    {tree.data?.files.map((file) => (
                                        <option key={file.path} value={file.path} />
                                    ))}
                                </datalist>
                            </>
                        )}
                    </Field>
                    <Field label="Line (optional)">
                        {(id) => (
                            <Input
                                id={id}
                                type="number"
                                min={1}
                                value={line}
                                disabled={!path.trim()}
                                onChange={(event) => setLine(event.target.value)}
                            />
                        )}
                    </Field>
                </div>
            )}
            {error !== undefined && <ErrorNotice error={error} />}
            <div>
                <Button type="submit" variant="primary" pending={pending} disabled={!body.trim()}>
                    Start thread
                </Button>
            </div>
        </form>
    );
};

export const ReviewTab = () => {
    const { problem } = useProblemContext();
    const threads = useQuery({
        queryKey: keys.threads(problem.id),
        queryFn: () => api.get<Thread[]>(`/problems/${problem.id}/threads`),
    });
    const open = threads.data?.filter((thread) => !thread.resolved) ?? [];
    const resolved = threads.data?.filter((thread) => thread.resolved) ?? [];

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <NewThread />
            {threads.isPending && <Loading />}
            {threads.error && <ErrorNotice error={threads.error} />}
            {threads.data && threads.data.length === 0 && (
                <EmptyState icon={<MessagesSquare className="size-6" />} title="No review threads">
                    Start a thread above to discuss the statement, a solution or the tests with the
                    other people working on this problem.
                </EmptyState>
            )}
            {open.length > 0 && (
                <section className="flex flex-col gap-3">
                    <h2 className="text-xs font-medium text-muted">Open ({open.length})</h2>
                    {open.map((thread) => (
                        <ThreadView key={thread.id} thread={thread} />
                    ))}
                </section>
            )}
            {resolved.length > 0 && (
                <section className="flex flex-col gap-2">
                    <h2 className="text-xs font-medium text-muted">Resolved ({resolved.length})</h2>
                    {resolved.map((thread) => (
                        <details
                            key={thread.id}
                            className="group rounded-lg border border-line bg-surface"
                        >
                            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
                                <ChevronRight
                                    className="size-4 text-muted transition-transform group-open:rotate-90"
                                    aria-hidden
                                />
                                <ThreadAnchor thread={thread} />
                                <span className="min-w-0 flex-1 truncate text-muted">
                                    {thread.comments[0]?.body}
                                </span>
                                <span className="shrink-0 text-xs text-subtle">
                                    {plural(thread.comments.length, "comment")}
                                </span>
                            </summary>
                            <div className="border-t border-line p-2">
                                <ThreadView thread={thread} />
                            </div>
                        </details>
                    ))}
                </section>
            )}
        </div>
    );
};
