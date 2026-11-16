import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound } from "lucide-react";
import { FormEvent, useState } from "react";

import { api } from "../lib/api";
import { formatDate, formatRelative } from "../lib/format";
import { keys } from "../lib/queries";
import type { Token } from "../lib/types";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/Dialog";
import { Field, Input } from "../ui/Field";
import { EmptyState, ErrorNotice, Loading, Notice, PageTitle } from "../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../ui/Table";
import { useToast } from "../ui/Toast";

export const CopyButton = ({ text, label = "Copy" }: { text: string; label?: string }) => {
    const [copied, setCopied] = useState(false);
    const toast = useToast();
    return (
        <Button
            size="sm"
            icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            onClick={async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                } catch {
                    toast.error("Could not copy; select the text and copy it manually");
                }
            }}
        >
            {copied ? "Copied" : label}
        </Button>
    );
};

export const TokensPage = () => {
    const queryClient = useQueryClient();
    const toast = useToast();
    const tokens = useQuery({ queryKey: keys.tokens, queryFn: () => api.get<Token[]>("/tokens") });
    const [name, setName] = useState("");
    const [created, setCreated] = useState<{ name: string; token: string }>();
    const [revoking, setRevoking] = useState<Token>();

    const create = useMutation({
        mutationFn: (tokenName: string) =>
            api.post<{ id: string; name: string; token: string }>("/tokens", { name: tokenName }),
        onSuccess: (result) => {
            setCreated(result);
            setName("");
            void queryClient.invalidateQueries({ queryKey: keys.tokens });
        },
        onError: (error) => toast.error(error),
    });

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (name.trim()) create.mutate(name.trim());
    };

    return (
        <div className="mx-auto max-w-3xl">
            <PageTitle subtitle="Personal access tokens let the Forge CLI and scripts act as you.">
                Access tokens
            </PageTitle>
            <form onSubmit={submit} className="mb-4 flex flex-wrap items-end gap-2">
                <Field label="Token name" className="min-w-56 flex-1">
                    {(id) => (
                        <Input
                            id={id}
                            value={name}
                            placeholder="e.g. laptop CLI"
                            onChange={(event) => setName(event.target.value)}
                        />
                    )}
                </Field>
                <Button
                    type="submit"
                    variant="primary"
                    pending={create.isPending}
                    disabled={!name.trim()}
                >
                    Create token
                </Button>
            </form>
            {created && (
                <Notice tone="success" className="mb-4">
                    <p className="mb-2 font-medium">
                        Token "{created.name}" created. Copy it now: it will not be shown again.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                        <code
                            data-testid="new-token"
                            className="min-w-0 flex-1 break-all rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-fg"
                        >
                            {created.token}
                        </code>
                        <CopyButton text={created.token} />
                        <Button size="sm" variant="ghost" onClick={() => setCreated(undefined)}>
                            Done
                        </Button>
                    </div>
                </Notice>
            )}
            {tokens.isPending && <Loading />}
            {tokens.error && <ErrorNotice error={tokens.error} />}
            {tokens.data && tokens.data.length === 0 && (
                <EmptyState icon={<KeyRound className="size-6" />} title="No access tokens">
                    Create a token above, or run <code className="font-mono">forge login</code> to
                    authorize the CLI from your browser.
                </EmptyState>
            )}
            {tokens.data && tokens.data.length > 0 && (
                <TableWrap>
                    <Table>
                        <thead>
                            <tr>
                                <Th>Name</Th>
                                <Th>Created</Th>
                                <Th>Last used</Th>
                                <Th className="w-0" />
                            </tr>
                        </thead>
                        <tbody>
                            {tokens.data.map((token) => (
                                <Tr key={token.id}>
                                    <Td className="font-medium">{token.name}</Td>
                                    <Td title={formatDate(token.createdAt)}>
                                        {formatRelative(token.createdAt)}
                                    </Td>
                                    <Td title={formatDate(token.lastUsedAt)}>
                                        {token.lastUsedAt
                                            ? formatRelative(token.lastUsedAt)
                                            : "Never"}
                                    </Td>
                                    <Td>
                                        <Button
                                            size="sm"
                                            variant="danger"
                                            onClick={() => setRevoking(token)}
                                        >
                                            Revoke
                                        </Button>
                                    </Td>
                                </Tr>
                            ))}
                        </tbody>
                    </Table>
                </TableWrap>
            )}
            <ConfirmDialog
                open={!!revoking}
                onClose={() => setRevoking(undefined)}
                title="Revoke token"
                message={
                    <>
                        Revoke "{revoking?.name}"? Anything using it (for example the CLI) will stop
                        working immediately.
                    </>
                }
                confirmLabel="Revoke"
                danger
                onConfirm={async () => {
                    await api.del(`/tokens/${revoking!.id}`);
                    await queryClient.invalidateQueries({ queryKey: keys.tokens });
                    toast.success("Token revoked");
                }}
            />
        </div>
    );
};
