import { TEMPLATE_FORMATS, TemplateFormat } from "@forge/core";
import { useQueryClient } from "@tanstack/react-query";
import { FileCode2, Plus, Search } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { api } from "../lib/api";
import { formatDate, formatRelative, slugify } from "../lib/format";
import { keys, useMe, useProblems } from "../lib/queries";
import { useSyncWorkspace } from "../lib/workspace";
import { Badge, BuildBadge, RoleBadge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Field, Input, Select } from "../ui/Field";
import { EmptyState, ErrorNotice, Loading, PageTitle } from "../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../ui/Table";
import { PolygonImport } from "./PolygonImport";

const TEMPLATE_INFO: Record<TemplateFormat, { label: string; description: string }> = {
    ioi: {
        label: "IOI",
        description: "Scored subtasks (all-or-nothing per subtask) with dependencies.",
    },
    icpc: {
        label: "ICPC",
        description: "Binary scoring: accepted only when every test passes.",
    },
    honi: {
        label: "HONI",
        description: "Independent clusters, each awarding its points when all its tests pass.",
    },
    interactive: {
        label: "Interactive",
        description: "The solution talks to an interactor program instead of reading a file.",
    },
    "output-only": {
        label: "Output-only",
        description: "Contestants submit output files; solutions can be programs or outputs.",
    },
    empty: {
        label: "Empty",
        description: "Just problem.yaml and a statement; bring your own files.",
    },
};

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const NewProblemDialog = ({
    open,
    onClose,
    workspaceId,
}: {
    open: boolean;
    onClose: () => void;
    workspaceId: string;
}) => {
    const [title, setTitle] = useState("");
    const [name, setName] = useState("");
    const [nameEdited, setNameEdited] = useState(false);
    const [template, setTemplate] = useState<TemplateFormat>("ioi");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    const effectiveName = nameEdited ? name : slugify(title);
    const nameInvalid = effectiveName !== "" && !NAME_PATTERN.test(effectiveName);

    const reset = () => {
        setTitle("");
        setName("");
        setNameEdited(false);
        setTemplate("ioi");
        setError(undefined);
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        setError(undefined);
        try {
            const created = await api.post<{ id: string }>(`/workspaces/${workspaceId}/problems`, {
                title: title.trim(),
                name: effectiveName,
                template,
            });
            await queryClient.invalidateQueries({ queryKey: keys.problems(workspaceId) });
            reset();
            onClose();
            navigate(`/p/${created.id}/files`);
        } catch (caught) {
            setError(caught);
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title="New problem"
            description="Start from a complete, buildable example or from scratch."
        >
            <form id="new-problem" onSubmit={submit} className="flex flex-col gap-3">
                <Field label="Title">
                    {(id) => (
                        <Input
                            id={id}
                            value={title}
                            required
                            autoFocus
                            placeholder="Pair sums"
                            onChange={(event) => setTitle(event.target.value)}
                        />
                    )}
                </Field>
                <Field
                    label="Name"
                    hint={
                        nameInvalid
                            ? undefined
                            : "Short identifier: lowercase letters, digits and dashes."
                    }
                    error={
                        nameInvalid
                            ? "Use lowercase letters, digits and dashes, starting with a letter or digit."
                            : undefined
                    }
                >
                    {(id, describedBy) => (
                        <Input
                            id={id}
                            value={effectiveName}
                            required
                            aria-describedby={describedBy}
                            aria-invalid={nameInvalid || undefined}
                            className="font-mono"
                            placeholder="pair-sums"
                            onChange={(event) => {
                                setNameEdited(true);
                                setName(event.target.value);
                            }}
                        />
                    )}
                </Field>
                <Field label="Template" hint={TEMPLATE_INFO[template].description}>
                    {(id, describedBy) => (
                        <Select
                            id={id}
                            value={template}
                            aria-describedby={describedBy}
                            onChange={(event) => setTemplate(event.target.value as TemplateFormat)}
                        >
                            {TEMPLATE_FORMATS.map((format) => (
                                <option key={format} value={format}>
                                    {TEMPLATE_INFO[format].label}:{" "}
                                    {TEMPLATE_INFO[format].description}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
                {error !== undefined && <ErrorNotice error={error} />}
                <div className="flex justify-end gap-2 pt-1">
                    <Button onClick={onClose}>Cancel</Button>
                    <Button
                        type="submit"
                        variant="primary"
                        pending={pending}
                        disabled={!title.trim() || !effectiveName || nameInvalid}
                    >
                        Create problem
                    </Button>
                </div>
            </form>
        </Dialog>
    );
};

export const ProblemsPage = () => {
    const { workspaceId = "" } = useParams();
    useSyncWorkspace(workspaceId);
    const me = useMe();
    const problems = useProblems(workspaceId);
    const [creating, setCreating] = useState(false);
    const [filter, setFilter] = useState("");
    const workspace = me.data?.workspaces.find((item) => item.id === workspaceId);
    const needle = filter.trim().toLowerCase();
    const shown = (problems.data ?? []).filter(
        (problem) =>
            !needle ||
            problem.title.toLowerCase().includes(needle) ||
            problem.name.toLowerCase().includes(needle),
    );

    const newButton = (
        <div className="flex flex-wrap items-center gap-2">
            {workspaceId && <PolygonImport workspaceId={workspaceId} />}
            <Button
                variant="primary"
                icon={<Plus className="size-4" />}
                onClick={() => setCreating(true)}
            >
                New problem
            </Button>
        </div>
    );

    return (
        <div>
            <PageTitle subtitle={workspace?.name} actions={newButton}>
                Problems
            </PageTitle>
            {problems.isPending && <Loading />}
            {problems.error && <ErrorNotice error={problems.error} />}
            {problems.data && problems.data.length === 0 && (
                <EmptyState
                    icon={<FileCode2 className="size-6" />}
                    title="No problems yet"
                    action={newButton}
                >
                    Create a problem from a template: it comes with a statement, generator,
                    validator and solutions you can build right away.
                </EmptyState>
            )}
            {problems.data && problems.data.length > 0 && (
                <div className="relative mb-3 max-w-sm">
                    <Search
                        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle"
                        aria-hidden
                    />
                    <Input
                        type="search"
                        aria-label="Filter problems"
                        placeholder="Filter by title or name"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        className="pl-8"
                    />
                </div>
            )}
            {problems.data && problems.data.length > 0 && (
                <TableWrap>
                    <Table>
                        <thead>
                            <tr>
                                <Th>Title</Th>
                                <Th>Name</Th>
                                <Th>Role</Th>
                                <Th className="text-right">Revisions</Th>
                                <Th>Last build</Th>
                                <Th className="hidden md:table-cell">Created</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.length === 0 && (
                                <Tr>
                                    <Td colSpan={6} className="text-center text-muted">
                                        No problems match &quot;{filter.trim()}&quot;.
                                    </Td>
                                </Tr>
                            )}
                            {shown.map((problem) => (
                                <Tr key={problem.id}>
                                    <Td>
                                        <Link
                                            to={`/p/${problem.id}`}
                                            className="font-medium hover:text-accent hover:underline"
                                        >
                                            {problem.title}
                                        </Link>
                                    </Td>
                                    <Td className="font-mono text-[12.5px] text-muted">
                                        {problem.name}
                                    </Td>
                                    <Td>
                                        <RoleBadge role={problem.role} />
                                    </Td>
                                    <Td className="text-right font-mono text-[12.5px]">
                                        {problem.revisions}
                                    </Td>
                                    <Td>
                                        {problem.lastResult ? (
                                            <BuildBadge status="done" result={problem.lastResult} />
                                        ) : (
                                            <Badge>not built</Badge>
                                        )}
                                    </Td>
                                    <Td
                                        className="hidden text-muted md:table-cell"
                                        title={formatDate(problem.createdAt)}
                                    >
                                        {formatRelative(problem.createdAt)}
                                    </Td>
                                </Tr>
                            ))}
                        </tbody>
                    </Table>
                </TableWrap>
            )}
            <NewProblemDialog
                open={creating}
                onClose={() => setCreating(false)}
                workspaceId={workspaceId}
            />
        </div>
    );
};
