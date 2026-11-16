import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Pencil, Printer } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { useSearchParams } from "react-router";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { CodeEditor } from "../../components/CodeEditor";
import { api, ApiError, decodeText, encodeText, q } from "../../lib/api";
import { can, keys } from "../../lib/queries";
import type { Statement, StatementPreview } from "../../lib/types";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import { EmptyState, ErrorNotice, Loading, Notice } from "../../ui/misc";
import { Tabs } from "../../ui/Tabs";
import { useToast } from "../../ui/Toast";
import { useProblemContext } from "./ProblemLayout";

const PLACEHOLDER_HINT = (
    <>
        <code className="font-mono">{"{{samples}}"}</code> places every sample and{" "}
        <code className="font-mono">{"{{sample.1}}"}</code> a single one.
    </>
);

/**
 * Resolves a relative URL in the statement to the package file it names: a path that already
 * starts with the statement's folder (`statement/figure.png`) is taken as a package path,
 * anything else as relative to the statement file. Absolute URLs are left alone.
 */
const statementUrl = (problemId: string, statementPath: string | undefined) => {
    const dir = statementPath?.includes("/")
        ? statementPath.slice(0, statementPath.lastIndexOf("/"))
        : "";
    return (url: string) => {
        if (!statementPath || /^([a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(url))
            return defaultUrlTransform(url);
        const [path = "", rest = ""] = url.split(/(?=[?#])/, 2);
        const base = dir && (path === dir || path.startsWith(`${dir}/`)) ? "" : dir;
        const parts: string[] = [];
        for (const part of (base ? `${base}/${path}` : path).split("/")) {
            if (part === "" || part === ".") continue;
            if (part === "..") parts.pop();
            else parts.push(part);
        }
        let resolved = parts.join("/");
        try {
            resolved = decodeURIComponent(resolved);
        } catch {
            // keep it as written
        }
        const hash = rest.startsWith("#") ? rest : "";
        return `/api/problems/${problemId}/file${q({ path: resolved })}${hash}`;
    };
};

type Draft = { path: string; base?: string; original: string; text: string };

export const StatementTab = () => {
    const { problem, editor } = useProblemContext();
    const writable = can(problem.role, "write");
    const [params, setParams] = useSearchParams();
    const lang = params.get("lang") ?? undefined;
    const queryClient = useQueryClient();
    const toast = useToast();
    const statement = useQuery({
        queryKey: keys.statement(problem.id, lang),
        queryFn: () => api.get<Statement>(`/problems/${problem.id}/statement${q({ lang })}`),
        placeholderData: (previous) => previous,
    });

    const [draft, setDraft] = useState<Draft>();
    const [opening, setOpening] = useState(false);
    const [saving, setSaving] = useState(false);
    const [conflict, setConflict] = useState(false);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const dirty = !!draft && draft.text !== draft.original;

    // re-render through the API about 400 ms after typing stops
    const [debounced, setDebounced] = useState<string>();
    const draftText = draft?.text;
    useEffect(() => {
        if (draftText === undefined) {
            setDebounced(undefined);
            return;
        }
        const id = window.setTimeout(() => setDebounced(draftText), 400);
        return () => window.clearTimeout(id);
    }, [draftText]);

    const preview = useQuery({
        queryKey: ["statement-preview", problem.id, debounced ?? ""],
        queryFn: () =>
            api.post<StatementPreview>(`/problems/${problem.id}/statement/preview`, {
                markdown: debounced,
            }),
        enabled: debounced !== undefined,
        placeholderData: (previous) => previous,
        staleTime: 30_000,
    });

    const openEditor = async (path: string) => {
        setOpening(true);
        try {
            const { bytes, etag } = await api.bytes(`/problems/${problem.id}/file${q({ path })}`);
            const text = decodeText(bytes);
            const base = etag?.replace(/^W\//, "").replace(/"/g, "");
            setDraft({ path, base, original: text, text });
            setConflict(false);
        } catch (error) {
            toast.error(error);
        } finally {
            setOpening(false);
        }
    };

    const save = useCallback(
        async (force = false): Promise<boolean> => {
            const current = draftRef.current;
            if (!current || current.text === current.original) return true;
            setSaving(true);
            const text = current.text;
            try {
                const result = await api.putBytes<{ hash: string }>(
                    `/problems/${problem.id}/file${q({ path: current.path })}`,
                    encodeText(text),
                    !force && current.base ? { "If-Match": current.base } : undefined,
                );
                setDraft((latest) =>
                    latest && latest.path === current.path
                        ? { ...latest, base: result.hash, original: text }
                        : latest,
                );
                setConflict(false);
                await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ["statement", problem.id] }),
                    queryClient.invalidateQueries({ queryKey: keys.tree(problem.id) }),
                    queryClient.invalidateQueries({ queryKey: keys.problem(problem.id) }),
                ]);
                return true;
            } catch (error) {
                if (error instanceof ApiError && error.status === 409) setConflict(true);
                else toast.error(error);
                return false;
            } finally {
                setSaving(false);
            }
        },
        [problem.id, queryClient, toast],
    );

    // Build / Commit in the header save the statement first, like the file editor
    const editing = draft !== undefined;
    useEffect(() => {
        if (!editing) return;
        editor.current = {
            get path() {
                return draftRef.current?.path ?? "";
            },
            dirty: () => !!draftRef.current && draftRef.current.text !== draftRef.current.original,
            save: () => save(),
        };
        return () => {
            editor.current = null;
        };
    }, [editing, editor, save]);

    // Ctrl/Cmd+S saves, and leaving the page with unsaved text asks first
    useEffect(() => {
        if (!editing) return;
        const onKey = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void save();
            }
        };
        const onUnload = (event: BeforeUnloadEvent) => {
            const current = draftRef.current;
            if (current && current.text !== current.original) event.preventDefault();
        };
        window.addEventListener("keydown", onKey);
        window.addEventListener("beforeunload", onUnload);
        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("beforeunload", onUnload);
        };
    }, [editing, save]);

    const data = statement.data;
    const urlTransform = useMemo(
        () => statementUrl(problem.id, draft?.path ?? data?.path),
        [problem.id, draft?.path, data?.path],
    );

    if (statement.isPending) return <Loading />;
    if (statement.error) return <ErrorNotice error={statement.error} />;
    if (!data || !data.language)
        return (
            <EmptyState icon={<FileText className="size-6" />} title="No statement">
                {problem.role === "tester" ? (
                    "The problem has no committed statement yet."
                ) : (
                    <>
                        Add a statement as statement/en.md (one Markdown file per language) in the
                        Files tab. {PLACEHOLDER_HINT}
                    </>
                )}
            </EmptyState>
        );

    const shown = editing && preview.data ? preview.data : data;
    /** Returns false when the user chose to keep editing. */
    const closeEditor = () => {
        if (dirty && !window.confirm("Close the editor and drop your unsaved changes?"))
            return false;
        setDraft(undefined);
        setConflict(false);
        return true;
    };

    const article = (
        <article
            data-testid="statement"
            className="markdown min-w-0 rounded-lg border border-line bg-surface px-6 py-5 print:border-0 print:p-0"
        >
            <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                urlTransform={urlTransform}
            >
                {shown.markdown}
            </ReactMarkdown>
        </article>
    );

    return (
        <div
            className={cx(
                "mx-auto flex min-w-0 flex-col gap-3",
                editing ? "max-w-[1400px]" : "max-w-4xl",
            )}
        >
            <div className="flex flex-wrap items-end gap-3 print:hidden">
                {data.languages.length > 1 ? (
                    <Tabs
                        label="Statement language"
                        value={data.language}
                        onChange={(value) => {
                            if (editing && !closeEditor()) return;
                            setParams({ lang: value }, { replace: true });
                        }}
                        tabs={data.languages.map((language) => ({
                            value: language,
                            label: language,
                        }))}
                    />
                ) : (
                    <Badge>language: {data.language}</Badge>
                )}
                {data.limits && (
                    <span className="text-xs text-muted">
                        time limit <span className="font-mono">{data.limits.time_ms} ms</span> ·
                        memory limit <span className="font-mono">{data.limits.memory_mb} MB</span>
                    </span>
                )}
                <div className="ml-auto flex flex-wrap items-center gap-2">
                    {editing ? (
                        <>
                            {dirty ? (
                                <Badge tone="warning" data-testid="statement-unsaved">
                                    unsaved changes
                                </Badge>
                            ) : (
                                <span className="text-xs text-muted">saved</span>
                            )}
                            <Button
                                size="sm"
                                variant="primary"
                                pending={saving}
                                disabled={!dirty}
                                onClick={() => void save()}
                            >
                                Save
                            </Button>
                            <Button
                                size="sm"
                                disabled={!dirty || saving}
                                onClick={() =>
                                    setDraft((current) =>
                                        current ? { ...current, text: current.original } : current,
                                    )
                                }
                            >
                                Discard
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => closeEditor()}>
                                Close editor
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button
                                size="sm"
                                icon={<Printer className="size-3.5" />}
                                onClick={() => window.print()}
                                title="Print the statement, or save it as a PDF from the print dialog"
                            >
                                Print / save as PDF
                            </Button>
                            {writable && data.path && (
                                <Button
                                    size="sm"
                                    icon={<Pencil className="size-3.5" />}
                                    pending={opening}
                                    onClick={() => void openEditor(data.path!)}
                                    title={`Edit ${data.path} with a live preview`}
                                >
                                    Edit
                                </Button>
                            )}
                        </>
                    )}
                </div>
            </div>
            {conflict && draft && (
                <Notice tone="warning" className="flex flex-wrap items-center gap-2 print:hidden">
                    <span className="flex-1">
                        <span className="font-mono">{draft.path}</span> was changed by someone else
                        since you opened it.
                    </span>
                    <Button size="sm" variant="danger" onClick={() => void save(true)}>
                        Overwrite with mine
                    </Button>
                    <Button
                        size="sm"
                        onClick={() => {
                            setDraft(undefined);
                            void openEditor(draft.path);
                        }}
                    >
                        Load theirs
                    </Button>
                </Notice>
            )}
            <div className="flex flex-col gap-3 print:hidden">
                {!shown.samplesBuilt && (
                    <Notice>Build the problem to fill in the sample outputs.</Notice>
                )}
                {shown.unresolved.length > 0 && (
                    <Notice tone="warning">
                        These placeholders could not be resolved:{" "}
                        {shown.unresolved.map((placeholder, index) => (
                            <span key={placeholder}>
                                {index > 0 && ", "}
                                <code className="font-mono">{`{{${placeholder}}}`}</code>
                            </span>
                        ))}
                        . Check the constraint names in problem.yaml.
                    </Notice>
                )}
                {data.groups && data.groups.some((group) => group.points > 0) && (
                    <div className="flex flex-wrap gap-1.5 text-xs text-muted">
                        Scoring:
                        {data.groups
                            .filter((group) => !group.sample)
                            .map((group) => (
                                <Badge key={group.name}>
                                    {group.name}: {group.points} pts
                                </Badge>
                            ))}
                    </div>
                )}
            </div>
            {editing ? (
                <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-1 print:hidden">
                        <CodeEditor
                            label={`Statement source ${draft.path}`}
                            language={draft.path}
                            value={draft.text}
                            onChange={(text) =>
                                setDraft((current) => (current ? { ...current, text } : current))
                            }
                            className="h-[50vh] rounded-lg border border-line lg:h-[70vh]"
                        />
                        <p className="text-xs text-muted">
                            <span className="font-mono">{draft.path}</span> in the working copy.{" "}
                            {PLACEHOLDER_HINT} The preview updates as you type.
                        </p>
                    </div>
                    <div className="print-statement flex min-w-0 flex-col gap-1">
                        <PrintHeader title={problem.title} limits={data.limits} />
                        {article}
                        {preview.isFetching && (
                            <span className="text-xs text-muted print:hidden">
                                Updating preview
                            </span>
                        )}
                        {preview.error && (
                            <ErrorNotice error={preview.error} className="print:hidden" />
                        )}
                    </div>
                </div>
            ) : (
                <div className="print-statement">
                    <PrintHeader title={problem.title} limits={data.limits} />
                    {article}
                </div>
            )}
        </div>
    );
};

/** Title and limits, shown only on paper (the app shows them in its own chrome). */
const PrintHeader = ({
    title,
    limits,
}: {
    title: string;
    limits?: { time_ms: number; memory_mb: number };
}) => (
    <div className="hidden print:mb-4 print:block">
        <h1 className="text-xl font-semibold">{title}</h1>
        {limits && (
            <p className="text-sm">
                Time limit: {limits.time_ms} ms · Memory limit: {limits.memory_mb} MB
            </p>
        )}
    </div>
);
