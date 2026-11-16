import { Language, LANGUAGES, languageOf } from "@forge/core";
import { useQueryClient } from "@tanstack/react-query";
import { Play, Upload } from "lucide-react";
import { FormEvent, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { CodeEditor } from "../../components/CodeEditor";
import { IssueList } from "../../components/IssueList";
import { api } from "../../lib/api";
import { formatDate, formatDuration, formatMs, formatRelative } from "../../lib/format";
import { useTicker } from "../../lib/hooks";
import { can, isActive, keys, useBuild, useBuilds } from "../../lib/queries";
import type { BuildOutput, RedactedOutput } from "../../lib/types";
import { Badge, BuildBadge, VerdictSummary } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import { Field, Input, Select } from "../../ui/Field";
import { Card, ErrorNotice, Loading, Notice, Progress } from "../../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../../ui/Table";
import { useToast } from "../../ui/Toast";
import { Matrix } from "./build/Matrix";
import { TestDialog } from "./build/TestDialog";
import { useProblemContext } from "./ProblemLayout";

const LANGUAGE_LABELS: Record<Language, string> = {
    c: "C",
    cpp: "C++",
    python: "Python 3",
    java: "Java",
    go: "Go",
    rust: "Rust",
    ocaml: "OCaml",
};

const InvocationForm = ({ onStarted }: { onStarted: (id: string) => void }) => {
    const { problem } = useProblemContext();
    const [name, setName] = useState("");
    const [language, setLanguage] = useState<Language>("cpp");
    const [source, setSource] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    const fileInput = useRef<HTMLInputElement>(null);
    const queryClient = useQueryClient();
    const toast = useToast();

    const pick = async (file: File | undefined) => {
        if (!file) return;
        if (file.size > 256 * 1024) {
            setError(new Error("The source file is larger than 256 KB"));
            return;
        }
        setSource(await file.text());
        const detected = languageOf(file.name);
        if (detected) setLanguage(detected);
        if (!name) setName(file.name.replace(/\.[^.]+$/, ""));
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        setError(undefined);
        try {
            const result = await api.post<{ id: string }>(`/problems/${problem.id}/invocations`, {
                name: name.trim(),
                language,
                source,
            });
            await queryClient.invalidateQueries({
                queryKey: keys.builds(problem.id, "invocation"),
            });
            onStarted(result.id);
        } catch (caught) {
            setError(caught);
            toast.error(caught);
        } finally {
            setPending(false);
        }
    };

    return (
        <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_200px_auto] sm:items-end">
                <Field label="Name">
                    {(id) => (
                        <Input
                            id={id}
                            value={name}
                            required
                            maxLength={80}
                            placeholder="greedy-attempt"
                            onChange={(event) => setName(event.target.value)}
                        />
                    )}
                </Field>
                <Field label="Language">
                    {(id) => (
                        <Select
                            id={id}
                            value={language}
                            onChange={(event) => setLanguage(event.target.value as Language)}
                        >
                            {LANGUAGES.map((item) => (
                                <option key={item} value={item}>
                                    {LANGUAGE_LABELS[item]}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
                <div>
                    <input
                        ref={fileInput}
                        type="file"
                        aria-label="Source file"
                        className="sr-only"
                        tabIndex={-1}
                        onChange={(event) => {
                            void pick(event.target.files?.[0]);
                            event.target.value = "";
                        }}
                    />
                    <Button
                        icon={<Upload className="size-4" />}
                        onClick={() => fileInput.current?.click()}
                    >
                        Load from file
                    </Button>
                </div>
            </div>
            <div>
                <span className="mb-1 block text-[13px] font-medium">Source</span>
                <CodeEditor
                    label="Source code"
                    language={language}
                    value={source}
                    onChange={setSource}
                    className="h-72 rounded-lg border border-line"
                />
            </div>
            {error !== undefined && <ErrorNotice error={error} />}
            <div className="flex flex-wrap items-center gap-3">
                <Button
                    type="submit"
                    variant="primary"
                    icon={<Play className="size-4" />}
                    pending={pending}
                    disabled={!name.trim() || !source.trim()}
                >
                    Run
                </Button>
                <span className="text-xs text-muted">
                    {can(problem.role, "read")
                        ? "Runs against the working copy as it is now, including uncommitted changes."
                        : "Runs against the latest revision. You see the outcome per group, not the tests."}
                </span>
            </div>
        </form>
    );
};

const isFull = (output: BuildOutput | RedactedOutput): output is BuildOutput => "matrix" in output;

const InvocationResult = ({ runId }: { runId: string }) => {
    const { problem } = useProblemContext();
    const run = useBuild<BuildOutput | RedactedOutput>(runId);
    const [showTests, setShowTests] = useState(false);
    const [openTest, setOpenTest] = useState<string>();
    useTicker(isActive(run.data?.status));

    if (run.isPending) return <Loading />;
    if (run.error) return <ErrorNotice error={run.error} />;
    const data = run.data;
    const output = data.output;
    const solution = output?.report.solutions[0];
    const points = new Map(output?.groups.map((group) => [group.name, group]) ?? []);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">
                    {data.name ?? "Invocation"}{" "}
                    <span className="font-mono text-sm text-muted">#{data.id}</span>
                </h2>
                <BuildBadge status={data.status} result={data.result} testId="invocation-status" />
                <span className="text-xs text-muted">
                    {formatDate(data.createdAt)} · {formatDuration(data.startedAt, data.finishedAt)}
                </span>
            </div>
            {isActive(data.status) && (
                <div className="rounded-lg border border-line bg-surface p-3">
                    <div className="mb-2 flex justify-between text-sm">
                        <span>
                            {data.status === "queued"
                                ? "Waiting for a runner"
                                : (data.progress?.phase ?? "Starting")}
                        </span>
                        {data.progress && data.progress.total > 0 && (
                            <span className="font-mono text-xs text-muted">
                                {data.progress.done}/{data.progress.total}
                            </span>
                        )}
                    </div>
                    <Progress
                        label="Invocation progress"
                        done={data.progress?.done ?? 0}
                        total={data.progress?.total ?? 0}
                    />
                </div>
            )}
            {data.status === "failed" && (
                <ErrorNotice error={new Error(data.error ?? "The run failed")} />
            )}
            {output && output.report.issues.length > 0 && (
                <IssueList issues={output.report.issues} />
            )}
            {output && !solution && (
                <Notice tone="warning">
                    {output.report.issues.length > 0
                        ? "The solution was not run; see the issues above."
                        : "The solution was not run because the problem itself does not build at this revision. The authors need to fix it first."}
                </Notice>
            )}
            {output && solution && (
                <>
                    <TableWrap>
                        <Table data-testid="invocation-results">
                            <thead>
                                <tr>
                                    <Th>Group</Th>
                                    <Th>Result</Th>
                                    <Th className="text-right">Score</Th>
                                    <Th className="text-right">Max time</Th>
                                </tr>
                            </thead>
                            <tbody>
                                {solution.groups.map((group) => (
                                    <Tr key={group.group}>
                                        <Td>
                                            <span className="font-mono text-[13px]">
                                                {group.group}
                                            </span>{" "}
                                            {points.get(group.group)?.sample && (
                                                <Badge tone="accent">sample</Badge>
                                            )}
                                        </Td>
                                        <Td>
                                            <VerdictSummary summary={group.summary} />
                                        </Td>
                                        <Td className="text-right font-mono text-[13px]">
                                            {group.score}/{group.maxScore}
                                        </Td>
                                        <Td className="text-right font-mono text-[13px]">
                                            {formatMs(group.maxTimeMs)}
                                        </Td>
                                    </Tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="bg-surface-2">
                                    <th
                                        scope="row"
                                        className="px-3 py-2 text-left text-[13px] font-semibold"
                                    >
                                        Total
                                    </th>
                                    <td />
                                    <td className="px-3 py-2 text-right font-mono text-[13px] font-semibold">
                                        {solution.score}/{solution.maxScore}
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono text-[13px]">
                                        {formatMs(solution.maxTimeMs)}
                                    </td>
                                </tr>
                            </tfoot>
                        </Table>
                    </TableWrap>
                    {output.limits && (
                        <p className="text-xs text-muted">
                            Limits: <span className="font-mono">{output.limits.time_ms} ms</span>,{" "}
                            <span className="font-mono">{output.limits.memory_mb} MB</span>
                        </p>
                    )}
                    {isFull(output) && (
                        <div>
                            <Button
                                size="sm"
                                aria-expanded={showTests}
                                onClick={() => setShowTests((value) => !value)}
                            >
                                {showTests ? "Hide per-test results" : "Show per-test results"}
                            </Button>
                            {showTests && (
                                <div className="mt-2">
                                    <Matrix output={output} onOpenTest={setOpenTest} />
                                    <TestDialog
                                        problemId={problem.id}
                                        output={output}
                                        testId={openTest}
                                        onClose={() => setOpenTest(undefined)}
                                    />
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export const InvocationsTab = () => {
    const { problem } = useProblemContext();
    const runs = useBuilds(problem.id, "invocation");
    const [params, setParams] = useSearchParams();
    const selected = params.get("run") ?? runs.data?.[0]?.id;

    return (
        <div className="grid gap-4 xl:grid-cols-[240px_minmax(0,1fr)]">
            <nav aria-label="Invocation history" className="order-2 min-w-0 xl:order-1">
                <h2 className="mb-1.5 text-xs font-medium text-muted">History</h2>
                {runs.isPending && <Loading />}
                {runs.error && <ErrorNotice error={runs.error} />}
                {runs.data?.length === 0 && (
                    <p className="text-[13px] text-muted">
                        No invocations yet. Run a solution to see how it scores.
                    </p>
                )}
                <ul className="flex gap-1.5 overflow-x-auto pb-1 xl:flex-col xl:overflow-visible">
                    {runs.data?.map((run) => (
                        <li key={run.id} className="shrink-0">
                            <button
                                type="button"
                                aria-current={run.id === selected ? "true" : undefined}
                                onClick={() => setParams({ run: run.id })}
                                className={cx(
                                    "flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-left text-[13px]",
                                    run.id === selected
                                        ? "border-accent bg-accent-soft"
                                        : "border-line bg-surface hover:border-line-strong",
                                )}
                            >
                                <span className="flex items-center justify-between gap-2">
                                    <span className="max-w-36 truncate font-medium">
                                        {run.name ?? `#${run.id}`}
                                    </span>
                                    <BuildBadge status={run.status} result={run.result} />
                                </span>
                                <span className="text-xs text-muted">
                                    <span className="font-mono">#{run.id}</span> ·{" "}
                                    {formatRelative(run.createdAt)}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            </nav>
            <div className="order-1 flex min-w-0 flex-col gap-4 xl:order-2">
                <Card title="Run a solution">
                    <InvocationForm onStarted={(id) => setParams({ run: id })} />
                </Card>
                {selected && <InvocationResult key={selected} runId={selected} />}
            </div>
        </div>
    );
};
