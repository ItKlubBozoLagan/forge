import { MANIFEST_PATH } from "@forge/core";
import { ArrowLeft, FileDiff } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router";

import { CodeEditor } from "../../../components/CodeEditor";
import { q } from "../../../lib/api";
import { useContent, useRevisionTree } from "../../../lib/files";
import { formatBytes, formatDate, formatRelative } from "../../../lib/format";
import { useRevisions } from "../../../lib/queries";
import { Badge } from "../../../ui/Badge";
import { ButtonLink } from "../../../ui/Button";
import { EmptyState, ErrorNotice, Loading, Notice, Spinner } from "../../../ui/misc";
import { DownloadPackageButton } from "../files/BulkFiles";
import { useLineComments } from "../files/LineComments";
import { FileTree } from "../FileTree";
import { useProblemContext } from "../ProblemLayout";

const noop = () => {};

/** A committed revision, read-only: its file tree, file contents and line comments. */
export const RevisionView = () => {
    const { problem } = useProblemContext();
    const { revisionId = "" } = useParams();
    const revisions = useRevisions(problem.id);
    const tree = useRevisionTree(problem.id, revisionId);
    const [params, setParams] = useSearchParams();

    const revision = revisions.data?.find((item) => item.id === revisionId);
    const parent = revision
        ? revisions.data?.find((item) => item.number === revision.number - 1)
        : undefined;
    const files = tree.data?.files ?? [];
    const selected =
        params.get("path") ??
        (files.some((file) => file.path === MANIFEST_PATH) ? MANIFEST_PATH : files[0]?.path);
    const file = files.find((item) => item.path === selected);
    const content = useContent(problem.id, file);
    const comments = useLineComments({
        problemId: problem.id,
        path: content.data?.kind === "text" ? selected : undefined,
        revisionId,
        revisionNumber: revision?.number,
        enabled: true,
    });

    if (tree.isPending || revisions.isPending) return <Loading />;
    if (tree.error) return <ErrorNotice error={tree.error} />;
    if (revisions.error) return <ErrorNotice error={revisions.error} />;
    if (!revision) return <EmptyState title="Revision not found" />;

    const label = `revision ${revision.number}`;
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                    <Link
                        to={`/p/${problem.id}/revisions`}
                        className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg hover:underline"
                    >
                        <ArrowLeft className="size-3.5" aria-hidden />
                        All revisions
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold">Revision {revision.number}</h2>
                        <Badge>read-only</Badge>
                    </div>
                    <p className="text-sm break-words">{revision.message}</p>
                    <p className="text-xs text-muted" title={formatDate(revision.createdAt)}>
                        {revision.author}, {formatRelative(revision.createdAt)}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {parent && (
                        <ButtonLink
                            size="sm"
                            icon={<FileDiff className="size-3.5" />}
                            to={`/p/${problem.id}/revisions/compare${q({ from: parent.id, to: revision.id })}`}
                        >
                            Changes from revision {parent.number}
                        </ButtonLink>
                    )}
                    <ButtonLink
                        size="sm"
                        icon={<FileDiff className="size-3.5" />}
                        to={`/p/${problem.id}/revisions/compare${q({ from: revision.id, to: "working" })}`}
                    >
                        Compare with working copy
                    </ButtonLink>
                    <DownloadPackageButton
                        problemId={problem.id}
                        revisionId={revision.id}
                        name={`${problem.name}-r${revision.number}`}
                    />
                </div>
            </div>

            <div className="grid gap-3 md:grid-cols-[240px_minmax(0,1fr)]">
                <aside className="min-w-0 rounded-lg border border-line bg-surface p-1.5 md:max-h-[calc(100dvh-280px)] md:overflow-auto">
                    <div className="mb-1 px-1 text-xs font-medium text-muted">Files in {label}</div>
                    {files.length === 0 ? (
                        <p className="px-2 py-4 text-[13px] text-muted">
                            This revision has no files.
                        </p>
                    ) : (
                        <FileTree
                            files={files}
                            selected={selected}
                            writable={false}
                            onSelect={(path) => setParams({ path })}
                            onRename={noop}
                            onDelete={noop}
                        />
                    )}
                </aside>

                <section className="flex min-w-0 flex-col gap-2" aria-label={`File in ${label}`}>
                    {!file ? (
                        <EmptyState title="No file open">
                            {selected
                                ? `${selected} is not part of ${label}.`
                                : "Pick a file on the left."}
                        </EmptyState>
                    ) : (
                        <>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="min-w-0 truncate font-mono text-[13px] font-medium">
                                    {file.path}
                                </span>
                                <span className="text-xs text-muted">{formatBytes(file.size)}</span>
                                <Badge tone="accent">{label}</Badge>
                                {content.isPending && <Spinner label="Loading file" />}
                                <div className="ml-auto flex gap-2">{comments.action}</div>
                            </div>
                            {content.error && <ErrorNotice error={content.error} />}
                            {content.data && content.data.kind !== "text" && (
                                <Notice>
                                    {content.data.kind === "binary"
                                        ? "This is a binary file."
                                        : `This file is too large to show in the browser (${formatBytes(content.data.size)}).`}{" "}
                                    <a
                                        className="text-accent underline"
                                        href={`/api/problems/${problem.id}/file${q({ path: file.path, revision: revision.id })}`}
                                        download={file.path.split("/").pop()}
                                    >
                                        Download it
                                    </a>
                                    .
                                </Notice>
                            )}
                            {content.data?.kind === "text" && (
                                <CodeEditor
                                    key={`${revision.id}:${file.path}`}
                                    label={`Contents of ${file.path} in ${label}`}
                                    language={file.path}
                                    value={content.data.text}
                                    readOnly
                                    {...comments.editorProps}
                                    className="h-[calc(100dvh-360px)] min-h-[360px] rounded-lg border border-line"
                                />
                            )}
                            {content.data?.kind === "text" && comments.panel}
                        </>
                    )}
                </section>
            </div>
            {comments.dialog}
        </div>
    );
};
