import { useQuery } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { api } from "../lib/api";
import { formatDate, formatRelative } from "../lib/format";
import { keys } from "../lib/queries";
import type { ProblemSetSummary } from "../lib/types";
import { useSyncWorkspace } from "../lib/workspace";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { EmptyState, ErrorNotice, Loading, PageTitle } from "../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../ui/Table";

export const SetsPage = () => {
    const { workspaceId = "" } = useParams();
    useSyncWorkspace(workspaceId);
    const sets = useQuery({
        queryKey: keys.sets(workspaceId),
        queryFn: () => api.get<ProblemSetSummary[]>(`/workspaces/${workspaceId}/sets`),
    });
    const [name, setName] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    const navigate = useNavigate();

    const create = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        setError(undefined);
        try {
            const created = await api.post<{ id: string }>(`/workspaces/${workspaceId}/sets`, {
                name: name.trim(),
            });
            navigate(`/sets/${created.id}`);
        } catch (caught) {
            setError(caught);
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="mx-auto max-w-4xl">
            <PageTitle subtitle="A problem set pins one revision of each problem; export it as a judge bundle for the contest.">
                Problem sets
            </PageTitle>
            <form onSubmit={create} className="mb-4 flex flex-wrap items-end gap-2">
                <Field label="New set name" className="min-w-56 flex-1">
                    {(id) => (
                        <Input
                            id={id}
                            value={name}
                            placeholder="e.g. Regional 2026, day 1"
                            onChange={(event) => setName(event.target.value)}
                        />
                    )}
                </Field>
                <Button type="submit" variant="primary" pending={pending} disabled={!name.trim()}>
                    Create set
                </Button>
            </form>
            {error !== undefined && <ErrorNotice error={error} className="mb-3" />}
            {sets.isPending && <Loading />}
            {sets.error && <ErrorNotice error={sets.error} />}
            {sets.data?.length === 0 && (
                <EmptyState icon={<Layers className="size-6" />} title="No problem sets yet">
                    Create a set above, then add problems and pin the revisions that go into the
                    contest.
                </EmptyState>
            )}
            {sets.data && sets.data.length > 0 && (
                <TableWrap>
                    <Table>
                        <thead>
                            <tr>
                                <Th>Name</Th>
                                <Th className="text-right">Problems</Th>
                                <Th>Created</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {sets.data.map((set) => (
                                <Tr key={set.id}>
                                    <Td>
                                        <Link
                                            to={`/sets/${set.id}`}
                                            className="font-medium hover:text-accent hover:underline"
                                        >
                                            {set.name}
                                        </Link>
                                    </Td>
                                    <Td className="text-right font-mono text-[12.5px]">
                                        {set.problems}
                                    </Td>
                                    <Td className="text-muted" title={formatDate(set.createdAt)}>
                                        {formatRelative(set.createdAt)}
                                    </Td>
                                </Tr>
                            ))}
                        </tbody>
                    </Table>
                </TableWrap>
            )}
        </div>
    );
};
