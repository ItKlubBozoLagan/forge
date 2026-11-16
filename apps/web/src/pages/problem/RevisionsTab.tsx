import { useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { api } from "../../lib/api";
import { formatDate, formatRelative } from "../../lib/format";
import { can, keys, useRevisions } from "../../lib/queries";
import type { Revision } from "../../lib/types";
import { BuildBadge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/Dialog";
import { EmptyState, ErrorNotice, Loading } from "../../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../../ui/Table";
import { useToast } from "../../ui/Toast";
import { useProblemContext } from "./ProblemLayout";

export const RevisionsTab = () => {
    const { problem } = useProblemContext();
    const revisions = useRevisions(problem.id);
    const [restoring, setRestoring] = useState<Revision>();
    const queryClient = useQueryClient();
    const toast = useToast();
    const writable = can(problem.role, "write");

    if (revisions.isPending) return <Loading />;
    if (revisions.error) return <ErrorNotice error={revisions.error} />;
    if (revisions.data.length === 0)
        return (
            <EmptyState icon={<History className="size-6" />} title="No revisions yet">
                {writable
                    ? "Press Commit at the top to freeze the working copy as revision 1. Each revision is built and can be pinned in a problem set."
                    : "Nobody has committed this problem yet."}
            </EmptyState>
        );

    return (
        <>
            <TableWrap>
                <Table>
                    <thead>
                        <tr>
                            <Th className="w-0">#</Th>
                            <Th>Message</Th>
                            <Th>Author</Th>
                            <Th>Date</Th>
                            <Th>Build</Th>
                            {writable && <Th className="w-0" />}
                        </tr>
                    </thead>
                    <tbody>
                        {revisions.data.map((revision) => (
                            <Tr key={revision.id}>
                                <Td className="font-mono font-medium">{revision.number}</Td>
                                <Td className="max-w-96 break-words">{revision.message}</Td>
                                <Td>{revision.author}</Td>
                                <Td
                                    className="whitespace-nowrap"
                                    title={formatDate(revision.createdAt)}
                                >
                                    {formatRelative(revision.createdAt)}
                                </Td>
                                <Td>
                                    {revision.build ? (
                                        <Link
                                            to={`/p/${problem.id}/builds/${revision.build.id}`}
                                            className="inline-flex items-center gap-1 hover:underline"
                                            aria-label={`Build of revision ${revision.number}: ${revision.build.result ?? revision.build.status}`}
                                        >
                                            <BuildBadge
                                                status={revision.build.status}
                                                result={revision.build.result}
                                            />
                                        </Link>
                                    ) : (
                                        <span className="text-xs text-subtle">not built</span>
                                    )}
                                </Td>
                                {writable && (
                                    <Td>
                                        <Button size="sm" onClick={() => setRestoring(revision)}>
                                            Restore to working copy
                                        </Button>
                                    </Td>
                                )}
                            </Tr>
                        ))}
                    </tbody>
                </Table>
            </TableWrap>
            <ConfirmDialog
                open={!!restoring}
                onClose={() => setRestoring(undefined)}
                title={`Restore revision ${restoring?.number ?? ""}`}
                message={
                    <>
                        Replace the working copy with the files of revision {restoring?.number} ("
                        {restoring?.message}")? Uncommitted changes in the working copy are lost.
                    </>
                }
                confirmLabel="Restore"
                danger
                onConfirm={async () => {
                    await api.post(`/problems/${problem.id}/revisions/${restoring!.id}/restore`);
                    await Promise.all([
                        queryClient.invalidateQueries({ queryKey: keys.tree(problem.id) }),
                        queryClient.invalidateQueries({ queryKey: keys.problem(problem.id) }),
                        queryClient.invalidateQueries({ queryKey: ["file", problem.id] }),
                    ]);
                    toast.success(`Working copy restored to revision ${restoring!.number}`);
                }}
            />
        </>
    );
};
