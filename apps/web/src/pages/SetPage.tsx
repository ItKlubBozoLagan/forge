import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { api, ApiError, send } from "../lib/api";
import { keys, useMe, useProblems, useRevisions } from "../lib/queries";
import type { ExportBlocker, ProblemSet, ProblemSummary } from "../lib/types";
import { useSyncWorkspace } from "../lib/workspace";
import { Badge, BuildBadge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/Dialog";
import { Input, Select } from "../ui/Field";
import { EmptyState, ErrorNotice, Loading, PageTitle } from "../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../ui/Table";
import { useToast } from "../ui/Toast";

type Draft = { key: number; label: string; problemId: string; revisionId: string };
let nextKey = 1;

const RevisionSelect = ({
    problemId,
    value,
    onChange,
    label,
}: {
    problemId: string;
    value: string;
    onChange: (value: string) => void;
    label: string;
}) => {
    const revisions = useRevisions(problemId, !!problemId);
    const selected = revisions.data?.find((revision) => revision.id === value);
    // default to the newest revision once a problem is picked
    useEffect(() => {
        if (problemId && !value && revisions.data?.[0]) onChange(revisions.data[0].id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [problemId, revisions.data]);
    if (!problemId) return <span className="text-xs text-subtle">pick a problem first</span>;
    if (revisions.error)
        return <span className="text-xs text-danger">{revisions.error.message}</span>;
    return (
        <div className="flex items-center gap-2">
            <Select
                aria-label={label}
                value={value}
                disabled={revisions.isPending}
                className="min-w-48"
                onChange={(event) => onChange(event.target.value)}
            >
                <option value="">
                    {revisions.isPending
                        ? "Loading..."
                        : revisions.data?.length === 0
                          ? "No revisions: commit first"
                          : "Choose a revision"}
                </option>
                {revisions.data?.map((revision) => (
                    <option key={revision.id} value={revision.id}>
                        #{revision.number} {revision.message.slice(0, 50)} ·{" "}
                        {revision.build?.result ?? revision.build?.status ?? "not built"}
                    </option>
                ))}
            </Select>
            {selected && (
                <BuildBadge
                    status={selected.build?.status ?? null}
                    result={selected.build?.result ?? null}
                />
            )}
        </div>
    );
};

const filenameFrom = (header: string | null, fallback: string) => {
    const match = header ? /filename="?([^";]+)"?/i.exec(header) : null;
    return match?.[1] ?? fallback;
};

export const SetPage = () => {
    const { setId = "" } = useParams();
    const set = useQuery({
        queryKey: keys.set(setId),
        queryFn: () => api.get<ProblemSet>(`/sets/${setId}`),
    });
    const workspaceId = set.data?.workspaceId;
    useSyncWorkspace(workspaceId);
    const problems = useProblems(workspaceId ?? "");
    const me = useMe();
    const owner =
        me.data?.workspaces.find((workspace) => workspace.id === workspaceId)?.role === "owner";
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const toast = useToast();

    const [drafts, setDrafts] = useState<Draft[]>([]);
    const [saving, setSaving] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [exportError, setExportError] = useState<{
        message: string;
        blockers?: ExportBlocker[];
    }>();
    const [deleting, setDeleting] = useState(false);

    const fromServer = (data: ProblemSet) =>
        data.entries.map((entry) => ({
            key: nextKey++,
            label: entry.label,
            problemId: entry.problemId,
            revisionId: entry.revisionId,
        }));

    useEffect(() => {
        if (set.data) setDrafts(fromServer(set.data));
    }, [set.data]);

    const dirty = useMemo(() => {
        if (!set.data) return false;
        const server = set.data.entries.map((entry) =>
            [entry.label, entry.problemId, entry.revisionId].join("|"),
        );
        const local = drafts.map((entry) =>
            [entry.label, entry.problemId, entry.revisionId].join("|"),
        );
        return server.join("\n") !== local.join("\n");
    }, [set.data, drafts]);

    if (set.isPending) return <Loading />;
    if (set.error)
        return set.error instanceof ApiError && set.error.status === 404 ? (
            <EmptyState title="Problem set not found" />
        ) : (
            <ErrorNotice error={set.error} />
        );

    const data = set.data;
    const problemById = new Map<string, ProblemSummary>(
        problems.data?.map((problem) => [problem.id, problem]),
    );
    const labels = drafts.map((draft) => draft.label.trim());
    const duplicate = labels.find((label, index) => label && labels.indexOf(label) !== index);
    const incomplete = drafts.some(
        (draft) => !draft.label.trim() || !draft.problemId || !draft.revisionId,
    );

    const update = (key: number, patch: Partial<Draft>) =>
        setDrafts((current) =>
            current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
        );
    const move = (index: number, delta: number) =>
        setDrafts((current) => {
            const next = [...current];
            const [item] = next.splice(index, 1);
            next.splice(index + delta, 0, item!);
            return next;
        });

    const save = async () => {
        setSaving(true);
        try {
            await api.put(`/sets/${data.id}/entries`, {
                entries: drafts.map(({ label, problemId, revisionId }) => ({
                    label: label.trim(),
                    problemId,
                    revisionId,
                })),
            });
            await queryClient.invalidateQueries({ queryKey: keys.set(data.id) });
            setExportError(undefined);
            toast.success("Problem set saved");
        } catch (error) {
            toast.error(error);
        } finally {
            setSaving(false);
        }
    };

    const exportBundle = async () => {
        setExporting(true);
        setExportError(undefined);
        try {
            const response = await send("GET", `/sets/${data.id}/export`);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filenameFrom(
                response.headers.get("Content-Disposition"),
                `${data.name}.zip`,
            );
            document.body.append(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
            toast.success("Judge bundle downloaded");
        } catch (error) {
            if (error instanceof ApiError && error.status === 409)
                setExportError({
                    message: error.message,
                    blockers: Array.isArray(error.detail)
                        ? (error.detail as ExportBlocker[])
                        : undefined,
                });
            else toast.error(error);
        } finally {
            setExporting(false);
        }
    };

    const nextLabel = () => {
        for (let code = 65; code < 91; code++) {
            const label = String.fromCharCode(code);
            if (!labels.includes(label)) return label;
        }
        return "";
    };

    return (
        <div className="mx-auto max-w-5xl">
            <div className="mb-1 text-xs text-muted">
                <Link to={`/w/${data.workspaceId}/sets`} className="hover:text-fg hover:underline">
                    Problem sets
                </Link>
            </div>
            <PageTitle
                actions={
                    <>
                        <Button
                            icon={<Download className="size-4" />}
                            pending={exporting}
                            disabled={!owner || dirty}
                            title={
                                !owner
                                    ? "Only workspace owners can export"
                                    : dirty
                                      ? "Save your changes first"
                                      : "Download the judge bundle (zip)"
                            }
                            onClick={exportBundle}
                        >
                            Export judge bundle
                        </Button>
                        <Button
                            variant="danger"
                            icon={<Trash2 className="size-4" />}
                            onClick={() => setDeleting(true)}
                        >
                            Delete set
                        </Button>
                    </>
                }
            >
                {data.name}
            </PageTitle>

            {exportError && (
                <div
                    role="alert"
                    className="mb-4 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm"
                >
                    <p className="font-medium text-danger">{exportError.message}</p>
                    {exportError.blockers && exportError.blockers.length > 0 && (
                        <ul className="mt-2 flex flex-col gap-1">
                            {exportError.blockers.map((blocker) => (
                                <li
                                    key={blocker.label}
                                    className="flex flex-wrap items-center gap-2"
                                >
                                    <Badge>{blocker.label}</Badge>
                                    <span className="font-mono text-xs">{blocker.problem}</span>
                                    <span className="text-xs text-muted">
                                        revision {blocker.revision}
                                    </span>
                                    <BuildBadge
                                        status="done"
                                        result={blocker.result ?? "not built"}
                                    />
                                </li>
                            ))}
                        </ul>
                    )}
                    <p className="mt-2 text-xs text-muted">
                        Fix these problems, commit, and pin a revision whose build is green.
                    </p>
                </div>
            )}

            {drafts.length === 0 ? (
                <EmptyState
                    title="This set is empty"
                    action={
                        <Button
                            icon={<Plus className="size-4" />}
                            onClick={() =>
                                setDrafts([
                                    { key: nextKey++, label: "A", problemId: "", revisionId: "" },
                                ])
                            }
                        >
                            Add problem
                        </Button>
                    }
                >
                    Add the problems of the contest and pin the revision of each one that will be
                    used.
                </EmptyState>
            ) : (
                <TableWrap>
                    <Table>
                        <thead>
                            <tr>
                                <Th className="w-24">Label</Th>
                                <Th>Problem</Th>
                                <Th>Revision</Th>
                                <Th className="w-0" />
                            </tr>
                        </thead>
                        <tbody>
                            {drafts.map((draft, index) => (
                                <Tr key={draft.key}>
                                    <Td>
                                        <Input
                                            aria-label={`Label of row ${index + 1}`}
                                            value={draft.label}
                                            maxLength={20}
                                            className="w-20 font-mono"
                                            onChange={(event) =>
                                                update(draft.key, { label: event.target.value })
                                            }
                                        />
                                    </Td>
                                    <Td>
                                        <Select
                                            aria-label={`Problem of row ${index + 1}`}
                                            value={draft.problemId}
                                            className="min-w-48"
                                            onChange={(event) =>
                                                update(draft.key, {
                                                    problemId: event.target.value,
                                                    revisionId: "",
                                                })
                                            }
                                        >
                                            <option value="">Choose a problem</option>
                                            {problems.data?.map((problem) => (
                                                <option key={problem.id} value={problem.id}>
                                                    {problem.title} ({problem.name})
                                                </option>
                                            ))}
                                            {draft.problemId &&
                                                !problemById.has(draft.problemId) && (
                                                    <option value={draft.problemId}>
                                                        {data.entries.find(
                                                            (entry) =>
                                                                entry.problemId === draft.problemId,
                                                        )?.title ?? `Problem ${draft.problemId}`}
                                                    </option>
                                                )}
                                        </Select>
                                    </Td>
                                    <Td>
                                        <RevisionSelect
                                            label={`Revision of row ${index + 1}`}
                                            problemId={draft.problemId}
                                            value={draft.revisionId}
                                            onChange={(revisionId) =>
                                                update(draft.key, { revisionId })
                                            }
                                        />
                                    </Td>
                                    <Td>
                                        <div className="flex gap-0.5">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                aria-label="Move up"
                                                disabled={index === 0}
                                                onClick={() => move(index, -1)}
                                                icon={<ArrowUp className="size-3.5" />}
                                            />
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                aria-label="Move down"
                                                disabled={index === drafts.length - 1}
                                                onClick={() => move(index, 1)}
                                                icon={<ArrowDown className="size-3.5" />}
                                            />
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                aria-label={`Remove row ${index + 1}`}
                                                onClick={() =>
                                                    setDrafts((current) =>
                                                        current.filter(
                                                            (item) => item.key !== draft.key,
                                                        ),
                                                    )
                                                }
                                                icon={<Trash2 className="size-3.5" />}
                                            />
                                        </div>
                                    </Td>
                                </Tr>
                            ))}
                        </tbody>
                    </Table>
                </TableWrap>
            )}

            {drafts.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                        icon={<Plus className="size-4" />}
                        onClick={() =>
                            setDrafts((current) => [
                                ...current,
                                {
                                    key: nextKey++,
                                    label: nextLabel(),
                                    problemId: "",
                                    revisionId: "",
                                },
                            ])
                        }
                    >
                        Add problem
                    </Button>
                    <Button
                        variant="primary"
                        pending={saving}
                        disabled={!dirty || incomplete || !!duplicate}
                        onClick={save}
                    >
                        Save
                    </Button>
                    {dirty && (
                        <Button variant="ghost" onClick={() => setDrafts(fromServer(data))}>
                            Discard changes
                        </Button>
                    )}
                    <span className="text-xs text-muted">
                        {duplicate
                            ? `Label "${duplicate}" is used twice.`
                            : incomplete
                              ? "Every row needs a label, a problem and a revision."
                              : dirty
                                ? "Unsaved changes."
                                : ""}
                    </span>
                </div>
            )}
            {drafts.length === 0 && dirty && (
                <div className="mt-3">
                    <Button variant="primary" pending={saving} onClick={save}>
                        Save
                    </Button>
                </div>
            )}

            <ConfirmDialog
                open={deleting}
                onClose={() => setDeleting(false)}
                title="Delete problem set"
                message={
                    <>Delete "{data.name}"? The problems and their revisions are not affected.</>
                }
                confirmLabel="Delete"
                danger
                onConfirm={async () => {
                    await api.del(`/sets/${data.id}`);
                    await queryClient.invalidateQueries({ queryKey: keys.sets(data.workspaceId) });
                    navigate(`/w/${data.workspaceId}/sets`);
                }}
            />
        </div>
    );
};
