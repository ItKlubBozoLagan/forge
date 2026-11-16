import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { keys, useMe, useMembers } from "../lib/queries";
import type { AuditEntry, Member } from "../lib/types";
import { useSyncWorkspace } from "../lib/workspace";
import { RoleBadge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/Dialog";
import { Field, Input, Select } from "../ui/Field";
import { Card, EmptyState, ErrorNotice, Loading, Notice, PageTitle } from "../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../ui/Table";
import { useToast } from "../ui/Toast";

const GeneralForm = ({
    workspaceId,
    name: initialName,
    referenceClass: initialClass,
    owner,
}: {
    workspaceId: string;
    name: string;
    referenceClass: string | null;
    owner: boolean;
}) => {
    const [name, setName] = useState(initialName);
    const [referenceClass, setReferenceClass] = useState(initialClass ?? "");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    const queryClient = useQueryClient();
    const toast = useToast();
    const health = useQuery({
        queryKey: ["health"],
        queryFn: () => api.get<{ runner: { pool: string; hardwareClass: string } }>("/health"),
    });
    useEffect(() => {
        setName(initialName);
        setReferenceClass(initialClass ?? "");
    }, [initialName, initialClass]);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        setError(undefined);
        try {
            await api.patch(`/workspaces/${workspaceId}`, {
                name: name.trim(),
                referenceClass: referenceClass.trim() || null,
            });
            await queryClient.invalidateQueries({ queryKey: keys.me });
            await queryClient.invalidateQueries({ queryKey: ["problem"] });
            toast.success("Workspace settings saved");
        } catch (caught) {
            setError(caught);
        } finally {
            setPending(false);
        }
    };

    const changed = name.trim() !== initialName || (referenceClass.trim() || null) !== initialClass;
    return (
        <Card title="General">
            <form onSubmit={submit} className="flex flex-col gap-3">
                <Field label="Workspace name">
                    {(id) => (
                        <Input
                            id={id}
                            value={name}
                            required
                            disabled={!owner}
                            onChange={(event) => setName(event.target.value)}
                        />
                    )}
                </Field>
                <Field
                    label="Reference hardware class"
                    hint={
                        <>
                            The hardware the contest will be judged on. Time limit calibration warns
                            when measurements come from a different class.
                            {health.data && (
                                <>
                                    {" "}
                                    This server's runner reports{" "}
                                    <button
                                        type="button"
                                        disabled={!owner}
                                        className="font-mono text-accent hover:underline disabled:text-muted disabled:no-underline"
                                        onClick={() =>
                                            setReferenceClass(health.data.runner.hardwareClass)
                                        }
                                        title={owner ? "Use this class" : undefined}
                                    >
                                        {health.data.runner.hardwareClass}
                                    </button>
                                    .
                                </>
                            )}
                        </>
                    }
                >
                    {(id, describedBy) => (
                        <Input
                            id={id}
                            value={referenceClass}
                            disabled={!owner}
                            className="font-mono"
                            placeholder="e.g. contest-xeon-2024"
                            aria-describedby={describedBy}
                            onChange={(event) => setReferenceClass(event.target.value)}
                        />
                    )}
                </Field>
                {error !== undefined && <ErrorNotice error={error} />}
                {owner ? (
                    <div>
                        <Button
                            type="submit"
                            variant="primary"
                            pending={pending}
                            disabled={!changed || !name.trim()}
                        >
                            Save
                        </Button>
                    </div>
                ) : (
                    <p className="text-xs text-muted">
                        Only workspace owners can change these settings.
                    </p>
                )}
            </form>
        </Card>
    );
};

const MembersCard = ({
    workspaceId,
    owner,
    kontestis,
}: {
    workspaceId: string;
    owner: boolean;
    kontestis: boolean;
}) => {
    const members = useMembers(workspaceId);
    const me = useMe();
    const queryClient = useQueryClient();
    const [email, setEmail] = useState("");
    const [role, setRole] = useState("member");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    const [removing, setRemoving] = useState<Member>();
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.members(workspaceId) });

    const add = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        setError(undefined);
        try {
            await api.post(`/workspaces/${workspaceId}/members`, { email: email.trim(), role });
            setEmail("");
            await refresh();
        } catch (caught) {
            setError(caught);
        } finally {
            setPending(false);
        }
    };

    return (
        <Card title="Members">
            {kontestis && (
                <Notice className="mb-3">
                    Membership of this workspace follows its Kontestis organisation.
                </Notice>
            )}
            {members.isPending && <Loading />}
            {members.error && <ErrorNotice error={members.error} />}
            {members.data && (
                <TableWrap>
                    <Table>
                        <thead>
                            <tr>
                                <Th>Name</Th>
                                <Th>Email</Th>
                                <Th>Role</Th>
                                {owner && <Th className="w-0" />}
                            </tr>
                        </thead>
                        <tbody>
                            {members.data.map((member) => (
                                <Tr key={member.id}>
                                    <Td className="font-medium">
                                        {member.name}
                                        {member.id === me.data?.user.id && (
                                            <span className="text-muted"> (you)</span>
                                        )}
                                    </Td>
                                    <Td className="text-muted">{member.email ?? "-"}</Td>
                                    <Td>
                                        <RoleBadge role={member.role} />
                                    </Td>
                                    {owner && (
                                        <Td>
                                            {member.id !== me.data?.user.id && (
                                                <Button
                                                    size="sm"
                                                    variant="danger"
                                                    onClick={() => setRemoving(member)}
                                                >
                                                    Remove
                                                </Button>
                                            )}
                                        </Td>
                                    )}
                                </Tr>
                            ))}
                        </tbody>
                    </Table>
                </TableWrap>
            )}
            {owner && !kontestis && (
                <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2">
                    <Field label="Email" className="min-w-56 flex-1">
                        {(id) => (
                            <Input
                                id={id}
                                type="email"
                                value={email}
                                required
                                onChange={(event) => setEmail(event.target.value)}
                            />
                        )}
                    </Field>
                    <Field label="Role" className="w-32">
                        {(id) => (
                            <Select
                                id={id}
                                value={role}
                                onChange={(event) => setRole(event.target.value)}
                            >
                                <option value="member">member</option>
                                <option value="owner">owner</option>
                            </Select>
                        )}
                    </Field>
                    <Button
                        type="submit"
                        variant="primary"
                        pending={pending}
                        disabled={!email.trim()}
                    >
                        Add member
                    </Button>
                    <p className="w-full text-xs text-muted">
                        The person must have signed in to Forge once.
                    </p>
                    {error !== undefined && <ErrorNotice error={error} className="w-full" />}
                </form>
            )}
            <ConfirmDialog
                open={!!removing}
                onClose={() => setRemoving(undefined)}
                title="Remove member"
                message={
                    <>
                        Remove {removing?.name} from the workspace? They lose access to all its
                        problems.
                    </>
                }
                confirmLabel="Remove"
                danger
                onConfirm={async () => {
                    await api.del(`/workspaces/${workspaceId}/members/${removing!.id}`);
                    await refresh();
                }}
            />
        </Card>
    );
};

const describe = (detail: AuditEntry["detail"]) => {
    if (!detail || Object.keys(detail).length === 0) return "";
    return Object.entries(detail)
        .map(
            ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
        )
        .join(" ");
};

const AuditCard = ({ workspaceId }: { workspaceId: string }) => {
    const audit = useQuery({
        queryKey: keys.audit(workspaceId),
        queryFn: () => api.get<AuditEntry[]>(`/workspaces/${workspaceId}/audit`),
    });
    return (
        <Card title="Audit log">
            {audit.isPending && <Loading />}
            {audit.error && <ErrorNotice error={audit.error} />}
            {audit.data?.length === 0 && <EmptyState title="Nothing recorded yet" />}
            {audit.data && audit.data.length > 0 && (
                <TableWrap className="max-h-[480px] overflow-y-auto">
                    <Table>
                        <thead>
                            <tr>
                                <Th>When</Th>
                                <Th>Who</Th>
                                <Th>Action</Th>
                                <Th>Problem</Th>
                                <Th>Detail</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {audit.data.map((entry) => (
                                <Tr key={entry.id}>
                                    <Td className="whitespace-nowrap text-xs text-muted">
                                        {formatDate(entry.at)}
                                    </Td>
                                    <Td className="whitespace-nowrap">{entry.userName ?? "-"}</Td>
                                    <Td className="font-mono text-xs">{entry.action}</Td>
                                    <Td className="whitespace-nowrap font-mono text-xs">
                                        {entry.problemId ? (
                                            <Link
                                                to={`/p/${entry.problemId}`}
                                                className="text-accent hover:underline"
                                            >
                                                {entry.problemName ?? entry.problemId}
                                            </Link>
                                        ) : (
                                            "-"
                                        )}
                                    </Td>
                                    <Td
                                        className="max-w-96 truncate font-mono text-xs text-muted"
                                        title={describe(entry.detail)}
                                    >
                                        {describe(entry.detail)}
                                    </Td>
                                </Tr>
                            ))}
                        </tbody>
                    </Table>
                </TableWrap>
            )}
        </Card>
    );
};

export const SettingsPage = () => {
    const { workspaceId = "" } = useParams();
    useSyncWorkspace(workspaceId);
    const me = useMe();
    const workspace = me.data?.workspaces.find((item) => item.id === workspaceId);
    if (!workspace)
        return (
            <EmptyState title="Workspace not found">
                You are not a member of this workspace.
            </EmptyState>
        );
    const owner = workspace.role === "owner";
    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
            <PageTitle subtitle={workspace.name}>Settings</PageTitle>
            <GeneralForm
                workspaceId={workspace.id}
                name={workspace.name}
                referenceClass={workspace.referenceClass}
                owner={owner}
            />
            <MembersCard
                workspaceId={workspace.id}
                owner={owner}
                kontestis={workspace.kontestisOrgId !== null}
            />
            {owner && <AuditCard workspaceId={workspace.id} />}
        </div>
    );
};
