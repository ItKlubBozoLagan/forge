import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState } from "react";

import { api } from "../../lib/api";
import { can, keys, useMe, useMembers } from "../../lib/queries";
import type { Member, ProblemRole } from "../../lib/types";
import { RoleBadge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/Dialog";
import { Field, Select } from "../../ui/Field";
import { Card, EmptyState, ErrorNotice, Loading, Notice } from "../../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../../ui/Table";
import { useToast } from "../../ui/Toast";
import { useProblemContext } from "./ProblemLayout";
import { ProblemSettings } from "./ProblemSettings";

const ROLES: Array<{ role: ProblemRole; description: string }> = [
    {
        role: "owner",
        description: "Everything an author can do, plus managing access and deleting the problem.",
    },
    {
        role: "author",
        description: "Edits files, builds, commits revisions and runs stress tests.",
    },
    {
        role: "viewer",
        description:
            "Reads files, builds and revisions, and takes part in review; cannot change anything.",
    },
    {
        role: "tester",
        description:
            "Blind: sees only the statement, runs their own solutions against the latest revision (results per group only) and joins review. Never sees files, tests or builds.",
    },
];

export const AccessTab = () => {
    const { problem } = useProblemContext();
    const manage = can(problem.role, "manage");
    const me = useMe();
    const access = useQuery({
        queryKey: keys.access(problem.id),
        queryFn: () => api.get<Member[]>(`/problems/${problem.id}/access`),
    });
    const members = useMembers(manage ? problem.workspace.id : undefined);
    const queryClient = useQueryClient();
    const toast = useToast();
    const [adding, setAdding] = useState("");
    const [addRole, setAddRole] = useState<ProblemRole>("author");
    const [pending, setPending] = useState<string>();
    const [removing, setRemoving] = useState<Member>();

    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.access(problem.id) });

    const setRole = async (userId: string, role: string) => {
        setPending(userId);
        try {
            await api.put(`/problems/${problem.id}/access/${userId}`, { role });
            await refresh();
            toast.success("Role updated");
        } catch (error) {
            toast.error(error);
        } finally {
            setPending(undefined);
        }
    };

    const add = async (event: FormEvent) => {
        event.preventDefault();
        if (!adding) return;
        await setRole(adding, addRole);
        setAdding("");
    };

    const listed = new Set(access.data?.map((member) => member.id));
    const candidates = members.data?.filter((member) => !listed.has(member.id)) ?? [];

    return (
        <div className="flex flex-col gap-4 lg:flex-row-reverse lg:items-start">
            <Card title="Roles" className="lg:w-96 lg:shrink-0">
                <dl className="flex flex-col gap-2 text-[13px]">
                    {ROLES.map((item) => (
                        <div key={item.role}>
                            <dt>
                                <RoleBadge role={item.role} />
                            </dt>
                            <dd className="mt-0.5 text-muted">{item.description}</dd>
                        </div>
                    ))}
                </dl>
                <p className="mt-3 text-xs text-muted">
                    Workspace owners are owners of every problem.
                </p>
            </Card>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
                {!manage && <Notice>Only owners of this problem can change access.</Notice>}
                {access.isPending && <Loading />}
                {access.error && <ErrorNotice error={access.error} />}
                {access.data && access.data.length === 0 && (
                    <EmptyState title="Nobody has explicit access">
                        Workspace owners can always open the problem. Add workspace members below to
                        give them a role.
                    </EmptyState>
                )}
                {access.data && access.data.length > 0 && (
                    <TableWrap>
                        <Table>
                            <thead>
                                <tr>
                                    <Th>Name</Th>
                                    <Th>Email</Th>
                                    <Th>Role</Th>
                                    {manage && <Th className="w-0" />}
                                </tr>
                            </thead>
                            <tbody>
                                {access.data.map((member) => (
                                    <Tr key={member.id}>
                                        <Td className="font-medium">
                                            {member.name}
                                            {member.id === me.data?.user.id && (
                                                <span className="text-muted"> (you)</span>
                                            )}
                                        </Td>
                                        <Td className="text-muted">{member.email ?? "-"}</Td>
                                        <Td>
                                            {manage ? (
                                                <Select
                                                    aria-label={`Role of ${member.name}`}
                                                    value={member.role}
                                                    disabled={pending === member.id}
                                                    className="w-32"
                                                    onChange={(event) =>
                                                        void setRole(member.id, event.target.value)
                                                    }
                                                >
                                                    {ROLES.map((item) => (
                                                        <option key={item.role} value={item.role}>
                                                            {item.role}
                                                        </option>
                                                    ))}
                                                </Select>
                                            ) : (
                                                <RoleBadge role={member.role} />
                                            )}
                                        </Td>
                                        {manage && (
                                            <Td>
                                                <Button
                                                    size="sm"
                                                    variant="danger"
                                                    onClick={() => setRemoving(member)}
                                                >
                                                    Remove
                                                </Button>
                                            </Td>
                                        )}
                                    </Tr>
                                ))}
                            </tbody>
                        </Table>
                    </TableWrap>
                )}
                {manage && (
                    <form
                        onSubmit={add}
                        className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-3"
                    >
                        <Field label="Workspace member" className="min-w-48 flex-1">
                            {(id) => (
                                <Select
                                    id={id}
                                    value={adding}
                                    onChange={(event) => setAdding(event.target.value)}
                                >
                                    <option value="">
                                        {members.isPending
                                            ? "Loading members..."
                                            : candidates.length === 0
                                              ? "Everyone already has access"
                                              : "Choose a member"}
                                    </option>
                                    {candidates.map((member) => (
                                        <option key={member.id} value={member.id}>
                                            {member.name}
                                            {member.email ? ` (${member.email})` : ""}
                                        </option>
                                    ))}
                                </Select>
                            )}
                        </Field>
                        <Field label="Role" className="w-36">
                            {(id) => (
                                <Select
                                    id={id}
                                    value={addRole}
                                    onChange={(event) =>
                                        setAddRole(event.target.value as ProblemRole)
                                    }
                                >
                                    {ROLES.map((item) => (
                                        <option key={item.role} value={item.role}>
                                            {item.role}
                                        </option>
                                    ))}
                                </Select>
                            )}
                        </Field>
                        <Button
                            type="submit"
                            variant="primary"
                            disabled={!adding}
                            pending={!!adding && pending === adding}
                        >
                            Add
                        </Button>
                        {members.error && <ErrorNotice error={members.error} className="w-full" />}
                        <p className="w-full text-xs text-muted">
                            Only workspace members can be added. Add people to the workspace in
                            Settings.
                        </p>
                    </form>
                )}
                <ProblemSettings problem={problem} />
            </div>
            <ConfirmDialog
                open={!!removing}
                onClose={() => setRemoving(undefined)}
                title="Remove access"
                message={<>Remove {removing?.name}'s access to this problem?</>}
                confirmLabel="Remove"
                danger
                onConfirm={async () => {
                    await api.del(`/problems/${problem.id}/access/${removing!.id}`);
                    await refresh();
                }}
            />
        </div>
    );
};
