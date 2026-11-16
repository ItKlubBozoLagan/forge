import { ArrowLeft, ArrowLeftRight } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";

import { diffTrees, FileChange } from "../../../lib/diff";
import { useRevisionTree } from "../../../lib/files";
import { plural } from "../../../lib/format";
import { useRevisions, useTree } from "../../../lib/queries";
import type { Revision } from "../../../lib/types";
import { Badge, Tone } from "../../../ui/Badge";
import { Button } from "../../../ui/Button";
import { cx } from "../../../ui/cx";
import { Field, Select } from "../../../ui/Field";
import { EmptyState, ErrorNotice, Loading, Notice } from "../../../ui/misc";
import { useProblemContext } from "../ProblemLayout";
import { DiffView } from "./DiffView";

/** The working copy in the `from`/`to` query parameters. */
const WORKING = "working";

const STATUS: Record<FileChange["status"], { tone: Tone; sign: string }> = {
    added: { tone: "success", sign: "+" },
    removed: { tone: "danger", sign: "-" },
    changed: { tone: "warning", sign: "~" },
};

const sideLabel = (side: string, revisions: Revision[]) =>
    side === WORKING
        ? "working copy"
        : `revision ${revisions.find((revision) => revision.id === side)?.number ?? "?"}`;

/**
 * Compares two trees by content hash: two revisions, or a revision and the working copy.
 * `?from=<revisionId|working>&to=<revisionId|working>&path=<selected file>`.
 */
export const CompareView = () => {
    const { problem } = useProblemContext();
    const revisions = useRevisions(problem.id);
    const [params, setParams] = useSearchParams();
    const list = revisions.data ?? [];
    const from = params.get("from") ?? problem.head?.id ?? WORKING;
    const to = params.get("to") ?? WORKING;
    const working = useTree(problem.id);
    const fromRevision = useRevisionTree(problem.id, from === WORKING ? undefined : from);
    const toRevision = useRevisionTree(problem.id, to === WORKING ? undefined : to);
    const fromTree = from === WORKING ? working : fromRevision;
    const toTree = to === WORKING ? working : toRevision;

    const changes = useMemo(
        () =>
            fromTree.data && toTree.data ? diffTrees(fromTree.data.files, toTree.data.files) : [],
        [fromTree.data, toTree.data],
    );
    const path = params.get("path") ?? changes[0]?.path;
    const selected = changes.find((change) => change.path === path);

    const update = (next: { from?: string; to?: string; path?: string }) => {
        const merged: Record<string, string> = { from, to };
        if (next.from) merged.from = next.from;
        if (next.to) merged.to = next.to;
        if (next.path) merged.path = next.path;
        setParams(merged, { replace: true });
    };

    if (revisions.isPending) return <Loading />;
    if (revisions.error) return <ErrorNotice error={revisions.error} />;

    const options = (
        <>
            <option value={WORKING}>Working copy</option>
            {list.map((revision) => (
                <option key={revision.id} value={revision.id}>
                    Revision {revision.number}: {revision.message.slice(0, 60)}
                </option>
            ))}
        </>
    );
    const counts = {
        added: changes.filter((change) => change.status === "added").length,
        removed: changes.filter((change) => change.status === "removed").length,
        changed: changes.filter((change) => change.status === "changed").length,
    };

    return (
        <div className="flex flex-col gap-3">
            <div>
                <Link
                    to={`/p/${problem.id}/revisions`}
                    className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg hover:underline"
                >
                    <ArrowLeft className="size-3.5" aria-hidden />
                    All revisions
                </Link>
                <h2 className="text-base font-semibold">
                    Changes from {sideLabel(from, list)} to {sideLabel(to, list)}
                </h2>
            </div>
            <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                <Field label="From">
                    {(id) => (
                        <Select
                            id={id}
                            value={from}
                            onChange={(event) => update({ from: event.target.value })}
                        >
                            {options}
                        </Select>
                    )}
                </Field>
                <Button
                    aria-label="Swap the two sides"
                    title="Swap"
                    icon={<ArrowLeftRight className="size-4" />}
                    onClick={() => update({ from: to, to: from })}
                />
                <Field label="To">
                    {(id) => (
                        <Select
                            id={id}
                            value={to}
                            onChange={(event) => update({ to: event.target.value })}
                        >
                            {options}
                        </Select>
                    )}
                </Field>
            </div>

            {(fromTree.error || toTree.error) && (
                <ErrorNotice error={fromTree.error ?? toTree.error} />
            )}
            {fromTree.isPending || toTree.isPending ? (
                <Loading />
            ) : changes.length === 0 ? (
                <EmptyState title="No differences">
                    Both sides have the same files with the same contents.
                </EmptyState>
            ) : (
                <div className="grid gap-3 md:grid-cols-[280px_minmax(0,1fr)]">
                    <section
                        aria-label="Changed files"
                        className="min-w-0 rounded-lg border border-line bg-surface p-1.5 md:max-h-[calc(100dvh-300px)] md:overflow-auto"
                    >
                        <p className="mb-1 px-1 text-xs text-muted" data-testid="change-summary">
                            {[
                                counts.added && `${counts.added} added`,
                                counts.removed && `${counts.removed} removed`,
                                counts.changed && `${counts.changed} changed`,
                            ]
                                .filter(Boolean)
                                .join(", ")}
                        </p>
                        <ul>
                            {changes.map((change) => {
                                const active = change.path === selected?.path;
                                return (
                                    <li key={change.path}>
                                        <button
                                            type="button"
                                            data-testid={`change-${change.path}`}
                                            aria-current={active ? "true" : undefined}
                                            onClick={() => update({ path: change.path })}
                                            className={cx(
                                                "flex w-full items-center gap-2 rounded px-1 py-1 text-left",
                                                active ? "bg-accent-soft" : "hover:bg-surface-2",
                                            )}
                                        >
                                            <Badge
                                                tone={STATUS[change.status].tone}
                                                className="w-[74px] shrink-0 justify-center"
                                            >
                                                <span aria-hidden>
                                                    {STATUS[change.status].sign}
                                                </span>
                                                {change.status}
                                            </Badge>
                                            <span
                                                className={cx(
                                                    "min-w-0 font-mono text-[12.5px] break-all",
                                                    active && "font-medium text-accent",
                                                )}
                                            >
                                                {change.path}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                    <section aria-label="Line diff" className="flex min-w-0 flex-col gap-2">
                        {selected ? (
                            <>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="min-w-0 font-mono text-[13px] font-medium break-all">
                                        {selected.path}
                                    </span>
                                    <Badge tone={STATUS[selected.status].tone}>
                                        {selected.status}
                                    </Badge>
                                </div>
                                <DiffView
                                    key={`${from}:${to}:${selected.path}`}
                                    problemId={problem.id}
                                    change={selected}
                                />
                            </>
                        ) : (
                            <Notice>
                                {path
                                    ? `${path} is the same on both sides.`
                                    : `Pick one of the ${plural(changes.length, "changed file")}.`}
                            </Notice>
                        )}
                    </section>
                </div>
            )}
        </div>
    );
};
