import { useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import type { LineMarker } from "../../../components/CodeEditor";
import { api } from "../../../lib/api";
import { useThreads } from "../../../lib/files";
import { plural } from "../../../lib/format";
import { keys } from "../../../lib/queries";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { Field, Textarea } from "../../../ui/Field";
import { ErrorNotice } from "../../../ui/misc";
import { ThreadView } from "../ReviewTab";

/**
 * Review threads anchored to lines of one file: gutter markers for open threads, "Comment on
 * line N" from the cursor or a gutter click, and an inline panel with the threads of a line.
 * In the Files tab threads belong to the working copy; in the revision viewer to that revision.
 * `?line=N` in the URL scrolls to and highlights that line.
 */
export const useLineComments = ({
    problemId,
    path,
    revisionId,
    revisionNumber,
    enabled,
}: {
    problemId: string;
    path: string | undefined;
    revisionId?: string;
    revisionNumber?: number;
    enabled: boolean;
}) => {
    const threads = useThreads(problemId, enabled);
    const [params] = useSearchParams();
    const requestedLine =
        params.get("path") === path ? Number(params.get("line")) || undefined : undefined;
    const [cursorLine, setCursorLine] = useState<number>();
    const [focusLine, setFocusLine] = useState(requestedLine);
    const [openLine, setOpenLine] = useState(requestedLine);
    const [composing, setComposing] = useState<number>();

    useEffect(() => {
        setCursorLine(undefined);
        setFocusLine(requestedLine);
        setOpenLine(requestedLine);
    }, [path, requestedLine]);

    const fileThreads = useMemo(
        () =>
            (threads.data ?? []).filter(
                (thread) =>
                    thread.path === path &&
                    thread.line !== null &&
                    (thread.revisionId ?? undefined) === revisionId,
            ),
        [threads.data, path, revisionId],
    );
    const markers = useMemo((): LineMarker[] => {
        const byLine = new Map<number, number>();
        for (const thread of fileThreads)
            if (!thread.resolved) byLine.set(thread.line!, (byLine.get(thread.line!) ?? 0) + 1);
        return [...byLine].map(([line, count]) => ({
            line,
            count,
            label: `${plural(count, "open thread")} on line ${line}`,
        }));
    }, [fileThreads]);

    if (!enabled || !path) return { editorProps: {}, action: null, panel: null, dialog: null };

    const line = cursorLine ?? 1;
    const editorProps = {
        markers,
        onMarkerClick: (clicked: number) => setOpenLine(clicked),
        onGutterClick: (clicked: number) => setComposing(clicked),
        onCursorLine: setCursorLine,
        focusLine,
    };

    const action = (
        <Button
            size="sm"
            icon={<MessageSquarePlus className="size-3.5" />}
            onClick={() => setComposing(line)}
            title="Start a review thread on the line with the cursor"
        >
            Comment on line {line}
        </Button>
    );

    const lineThreads = openLine ? fileThreads.filter((thread) => thread.line === openLine) : [];
    const panel =
        lineThreads.length > 0 || markers.length > 0 ? (
            <section aria-label="Review threads in this file" className="flex flex-col gap-2">
                {markers.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <span>Open threads in this file:</span>
                        {markers.map((marker) => (
                            <button
                                key={marker.line}
                                type="button"
                                aria-pressed={marker.line === openLine}
                                onClick={() => {
                                    setOpenLine(marker.line);
                                    setFocusLine(marker.line);
                                }}
                                className="rounded border border-line px-1.5 py-0.5 font-mono hover:bg-surface-2 aria-pressed:border-accent aria-pressed:text-accent"
                            >
                                line {marker.line}
                            </button>
                        ))}
                    </div>
                )}
                {lineThreads.length > 0 && (
                    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-2">
                        <div className="flex items-center gap-2">
                            <h3 className="text-[13px] font-semibold">
                                Threads on line {openLine}
                            </h3>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="ml-auto"
                                aria-label="Close threads"
                                icon={<X className="size-3.5" />}
                                onClick={() => setOpenLine(undefined)}
                            />
                        </div>
                        {lineThreads.map((thread) => (
                            <ThreadView key={thread.id} thread={thread} />
                        ))}
                    </div>
                )}
            </section>
        ) : null;

    const dialog = (
        <NewLineThreadDialog
            problemId={problemId}
            path={path}
            line={composing}
            revisionId={revisionId}
            revisionNumber={revisionNumber}
            onClose={() => setComposing(undefined)}
            onCreated={(created) => {
                setComposing(undefined);
                setOpenLine(created);
            }}
        />
    );

    return { editorProps, action, panel, dialog };
};

const NewLineThreadDialog = ({
    problemId,
    path,
    line,
    revisionId,
    revisionNumber,
    onClose,
    onCreated,
}: {
    problemId: string;
    path: string;
    line: number | undefined;
    revisionId?: string;
    revisionNumber?: number;
    onClose: () => void;
    onCreated: (line: number) => void;
}) => {
    const [body, setBody] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    const queryClient = useQueryClient();

    useEffect(() => {
        if (line) {
            setBody("");
            setError(undefined);
        }
    }, [line]);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!line) return;
        setPending(true);
        setError(undefined);
        try {
            await api.post(`/problems/${problemId}/threads`, {
                body: body.trim(),
                path,
                line,
                ...(revisionId ? { revision: revisionId } : {}),
            });
            await queryClient.invalidateQueries({ queryKey: keys.threads(problemId) });
            onCreated(line);
        } catch (caught) {
            setError(caught);
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog
            open={!!line}
            onClose={onClose}
            title={`Comment on line ${line ?? ""}`}
            description={
                <>
                    <span className="font-mono">{path}</span>
                    {revisionNumber !== undefined
                        ? ` in revision ${revisionNumber}`
                        : " in the working copy"}
                </>
            }
        >
            <form onSubmit={submit} className="flex flex-col gap-3">
                <Field label="Comment">
                    {(id) => (
                        <Textarea
                            id={id}
                            value={body}
                            required
                            autoFocus
                            placeholder="A question or a problem with this line..."
                            onChange={(event) => setBody(event.target.value)}
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
                        disabled={!body.trim()}
                    >
                        Start thread
                    </Button>
                </div>
            </form>
        </Dialog>
    );
};
