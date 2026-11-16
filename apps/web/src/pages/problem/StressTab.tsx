import { languageOf, MANIFEST_PATH, parseManifest } from "@forge/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FlaskConical } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { api, decodeText, q } from "../../lib/api";
import { formatDate, formatDuration, formatRelative } from "../../lib/format";
import { useTicker } from "../../lib/hooks";
import { can, isActive, keys, useBuild, useBuilds, useTree } from "../../lib/queries";
import type { StressOutput, StressParams } from "../../lib/types";
import { Badge, BuildBadge, Verdict } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import { Dialog } from "../../ui/Dialog";
import { Field, Input, Select } from "../../ui/Field";
import { Card, EmptyState, ErrorNotice, Loading, Notice, Progress } from "../../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../../ui/Table";
import { useToast } from "../../ui/Toast";
import { BlobPreview } from "./build/BlobPreview";
import { useProblemContext } from "./ProblemLayout";

/** Generators, groups and solutions from the working copy's problem.yaml, parsed in the browser. */
const useWorkingManifest = (problemId: string) => {
    const tree = useTree(problemId);
    const entry = tree.data?.files.find((file) => file.path === MANIFEST_PATH);
    const file = useQuery({
        queryKey: [...keys.file(problemId, MANIFEST_PATH), entry?.hash],
        queryFn: () => api.bytes(`/problems/${problemId}/file${q({ path: MANIFEST_PATH })}`),
        enabled: !!entry,
        staleTime: Infinity,
    });
    const parsed = useMemo(
        () => (file.data ? parseManifest(decodeText(file.data.bytes)) : undefined),
        [file.data],
    );
    return {
        pending: tree.isPending || (!!entry && file.isPending),
        error: tree.error ?? file.error,
        missing: tree.data && !entry,
        manifest: parsed?.manifest,
        issues: parsed?.issues ?? [],
    };
};

const StressForm = ({ onStarted }: { onStarted: (id: string) => void }) => {
    const { problem } = useProblemContext();
    const working = useWorkingManifest(problem.id);
    const toast = useToast();
    const queryClient = useQueryClient();
    const manifest = working.manifest;
    const generators = Object.keys(manifest?.generators ?? {});
    const groups = (manifest?.groups ?? []).map((group) => group.name);
    // a directory of outputs (output-only tasks) cannot answer freshly generated tests
    const solutions = (manifest?.solutions ?? []).filter(
        (solution) => solution.role !== "main" && languageOf(solution.path),
    );

    const [generator, setGenerator] = useState("");
    const [group, setGroup] = useState("");
    const [solution, setSolution] = useState("");
    const [args, setArgs] = useState("n=8 maxv=5 seed={seed}");
    const [count, setCount] = useState("50");
    const [seedStart, setSeedStart] = useState("1");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();

    // default selections once the manifest is known
    useEffect(() => {
        if (!manifest) return;
        if (!generators.includes(generator)) setGenerator(generators[0] ?? "");
        if (!groups.includes(group))
            setGroup(manifest.groups.find((item) => !item.sample)?.name ?? groups[0] ?? "");
        if (!solutions.some((item) => item.path === solution))
            setSolution(solutions[0]?.path ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [manifest]);

    if (working.pending) return <Loading label="Reading problem.yaml" />;
    if (working.error) return <ErrorNotice error={working.error} />;
    if (working.missing || !manifest)
        return (
            <Notice tone="warning">
                {working.missing
                    ? "The working copy has no problem.yaml."
                    : `problem.yaml has errors: ${working.issues.map((issue) => issue.message).join("; ")}`}{" "}
                Fix it in the Files tab to run stress tests.
            </Notice>
        );
    if (generators.length === 0 || solutions.length === 0)
        return (
            <Notice>
                Stress testing needs at least one generator and one solution besides the main one in
                problem.yaml. The main solution produces the answers; the other solution is checked
                against them on many small random tests.
            </Notice>
        );

    const argsInvalid = !args.includes("{seed}");
    const countNumber = Number(count);
    const seedNumber = Number(seedStart);
    const countInvalid = !Number.isInteger(countNumber) || countNumber < 1 || countNumber > 500;
    const seedInvalid = !Number.isInteger(seedNumber) || seedNumber < 0;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (argsInvalid || countInvalid || seedInvalid) return;
        setPending(true);
        setError(undefined);
        try {
            const result = await api.post<{ id: string }>(`/problems/${problem.id}/stress`, {
                generator,
                args,
                count: countNumber,
                seedStart: seedNumber,
                solution,
                group,
            });
            await queryClient.invalidateQueries({ queryKey: keys.builds(problem.id, "stress") });
            onStarted(result.id);
        } catch (caught) {
            setError(caught);
            toast.error(caught);
        } finally {
            setPending(false);
        }
    };

    return (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Generator">
                {(id) => (
                    <Select
                        id={id}
                        value={generator}
                        onChange={(event) => setGenerator(event.target.value)}
                    >
                        {generators.map((name) => (
                            <option key={name} value={name}>
                                {name} ({manifest.generators[name]})
                            </option>
                        ))}
                    </Select>
                )}
            </Field>
            <Field label="Group" hint="Tests are validated against this group's constraints.">
                {(id, describedBy) => (
                    <Select
                        id={id}
                        value={group}
                        aria-describedby={describedBy}
                        onChange={(event) => setGroup(event.target.value)}
                    >
                        {groups.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </Select>
                )}
            </Field>
            <Field label="Solution" hint="Compared against the main solution's answers.">
                {(id, describedBy) => (
                    <Select
                        id={id}
                        value={solution}
                        aria-describedby={describedBy}
                        onChange={(event) => setSolution(event.target.value)}
                    >
                        {solutions.map((item) => (
                            <option key={item.path} value={item.path}>
                                {item.path}
                            </option>
                        ))}
                    </Select>
                )}
            </Field>
            <Field
                label="Arguments"
                className="sm:col-span-2 lg:col-span-1"
                hint={argsInvalid ? undefined : "{seed} is replaced by the seed of each case."}
                error={argsInvalid ? "The arguments must contain {seed}." : undefined}
            >
                {(id, describedBy) => (
                    <Input
                        id={id}
                        value={args}
                        className="font-mono"
                        aria-describedby={describedBy}
                        aria-invalid={argsInvalid || undefined}
                        onChange={(event) => setArgs(event.target.value)}
                    />
                )}
            </Field>
            <Field label="Count" error={countInvalid ? "Between 1 and 500." : undefined}>
                {(id, describedBy) => (
                    <Input
                        id={id}
                        type="number"
                        min={1}
                        max={500}
                        value={count}
                        aria-describedby={describedBy}
                        onChange={(event) => setCount(event.target.value)}
                    />
                )}
            </Field>
            <Field label="First seed" error={seedInvalid ? "A non-negative integer." : undefined}>
                {(id, describedBy) => (
                    <Input
                        id={id}
                        type="number"
                        min={0}
                        value={seedStart}
                        aria-describedby={describedBy}
                        onChange={(event) => setSeedStart(event.target.value)}
                    />
                )}
            </Field>
            {error !== undefined && (
                <ErrorNotice error={error} className="sm:col-span-2 lg:col-span-3" />
            )}
            <div className="sm:col-span-2 lg:col-span-3">
                <Button
                    type="submit"
                    variant="primary"
                    icon={<FlaskConical className="size-4" />}
                    pending={pending}
                    disabled={
                        argsInvalid ||
                        countInvalid ||
                        seedInvalid ||
                        !generator ||
                        !solution ||
                        !group
                    }
                >
                    Run stress test
                </Button>
            </div>
        </form>
    );
};

const StressResult = ({ runId }: { runId: string }) => {
    const { problem } = useProblemContext();
    const run = useBuild<StressOutput>(runId);
    const [viewing, setViewing] = useState<StressOutput["failures"][number]>();
    const [promoting, setPromoting] = useState<string>();
    const [promoted, setPromoted] = useState<Set<string>>(new Set());
    const toast = useToast();
    const queryClient = useQueryClient();
    const writable = can(problem.role, "write");
    useTicker(isActive(run.data?.status));

    if (run.isPending) return <Loading />;
    if (run.error) return <ErrorNotice error={run.error} />;
    const data = run.data;
    const params = data.params as Partial<StressParams> | undefined;
    const output = data.output;

    const promote = async (args: string) => {
        setPromoting(args);
        try {
            await api.post(`/builds/${data.id}/promote`, { args });
            setPromoted((current) => new Set(current).add(args));
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: keys.tree(problem.id) }),
                queryClient.invalidateQueries({ queryKey: keys.problem(problem.id) }),
            ]);
            toast.success(`Added "${args}" to group ${params?.group ?? ""} in problem.yaml`);
        } catch (error) {
            toast.error(error);
        } finally {
            setPromoting(undefined);
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">Stress run #{data.id}</h2>
                <BuildBadge status={data.status} result={data.result} testId="stress-status" />
                <span className="text-xs text-muted">
                    {formatDate(data.createdAt)} · {formatDuration(data.startedAt, data.finishedAt)}
                </span>
            </div>
            {params && (
                <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
                    {(
                        [
                            ["Generator", params.generator],
                            ["Arguments", params.args],
                            ["Solution", params.solution],
                            ["Group", params.group],
                            [
                                "Seeds",
                                params.seedStart !== undefined && params.count !== undefined
                                    ? `${params.seedStart}..${params.seedStart + params.count - 1}`
                                    : undefined,
                            ],
                        ] as const
                    ).map(([label, value]) => (
                        <div key={label} className="flex gap-1.5">
                            <dt className="text-muted">{label}</dt>
                            <dd className="font-mono">{value ?? "-"}</dd>
                        </div>
                    ))}
                </dl>
            )}
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
                        label="Stress progress"
                        done={data.progress?.done ?? 0}
                        total={data.progress?.total ?? 0}
                    />
                </div>
            )}
            {data.status === "failed" && (
                <ErrorNotice error={new Error(data.error ?? "The stress run failed")} />
            )}
            {output && (
                <>
                    <div
                        className={cx(
                            "rounded-lg border px-3 py-2.5 text-sm",
                            output.failures.length === 0 && output.errors.length === 0
                                ? "border-success/40 bg-success-soft text-success"
                                : "border-danger/40 bg-danger-soft text-danger",
                        )}
                    >
                        <span className="font-semibold">
                            {output.passed}/{output.total} passed
                        </span>
                        {output.failures.length > 0 && ` · ${output.failures.length} failing`}
                        {output.invalid.length > 0 && ` · ${output.invalid.length} invalid`}
                    </div>
                    {output.errors.length > 0 && (
                        <Card title="Errors">
                            <ul className="list-disc pl-5 text-sm text-danger">
                                {output.errors.map((message, index) => (
                                    <li key={index}>{message}</li>
                                ))}
                            </ul>
                        </Card>
                    )}
                    {output.failures.length > 0 && (
                        <section>
                            <h3 className="mb-1.5 text-[13px] font-semibold">Failures</h3>
                            <TableWrap>
                                <Table>
                                    <thead>
                                        <tr>
                                            <Th>Arguments</Th>
                                            <Th>Verdict</Th>
                                            <Th className="text-right">Time</Th>
                                            <Th>Message</Th>
                                            <Th className="w-0" />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {output.failures.map((failure) => (
                                            <Tr key={failure.args}>
                                                <Td className="font-mono text-xs">
                                                    {failure.args}
                                                </Td>
                                                <Td>
                                                    <Verdict verdict={failure.verdict} />
                                                </Td>
                                                <Td className="text-right font-mono text-xs">
                                                    {failure.timeMs} ms
                                                </Td>
                                                <Td
                                                    className="max-w-72 truncate text-xs text-muted"
                                                    title={failure.message}
                                                >
                                                    {failure.message ?? ""}
                                                </Td>
                                                <Td>
                                                    <div className="flex gap-1.5">
                                                        <Button
                                                            size="sm"
                                                            onClick={() => setViewing(failure)}
                                                        >
                                                            View input
                                                        </Button>
                                                        {writable &&
                                                            (promoted.has(failure.args) ? (
                                                                <Badge tone="success">
                                                                    <Check
                                                                        className="size-3"
                                                                        aria-hidden
                                                                    />
                                                                    added
                                                                </Badge>
                                                            ) : (
                                                                <Button
                                                                    size="sm"
                                                                    variant="primary"
                                                                    pending={
                                                                        promoting === failure.args
                                                                    }
                                                                    onClick={() =>
                                                                        promote(failure.args)
                                                                    }
                                                                >
                                                                    Add to tests
                                                                </Button>
                                                            ))}
                                                    </div>
                                                </Td>
                                            </Tr>
                                        ))}
                                    </tbody>
                                </Table>
                            </TableWrap>
                        </section>
                    )}
                    {output.invalid.length > 0 && (
                        <section>
                            <h3 className="mb-1.5 text-[13px] font-semibold">
                                Invalid cases{" "}
                                <span className="font-normal text-muted">
                                    (the validator rejected these generated tests: a generator bug,
                                    not a solution bug)
                                </span>
                            </h3>
                            <TableWrap>
                                <Table>
                                    <thead>
                                        <tr>
                                            <Th>Arguments</Th>
                                            <Th>Validator message</Th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {output.invalid.map((item) => (
                                            <Tr key={item.args}>
                                                <Td className="font-mono text-xs">{item.args}</Td>
                                                <Td className="text-xs text-danger">
                                                    {item.message}
                                                </Td>
                                            </Tr>
                                        ))}
                                    </tbody>
                                </Table>
                            </TableWrap>
                        </section>
                    )}
                </>
            )}
            <Dialog
                open={!!viewing}
                onClose={() => setViewing(undefined)}
                variant="drawer"
                title={<span className="font-mono">{viewing?.args}</span>}
                description={
                    viewing
                        ? `${viewing.verdict} in ${viewing.timeMs} ms${viewing.message ? `: ${viewing.message}` : ""}`
                        : undefined
                }
            >
                {viewing && (
                    <BlobPreview
                        problemId={problem.id}
                        hash={viewing.inputHash}
                        size={viewing.inputSize}
                        label="Input"
                        fileName="stress.in"
                    />
                )}
            </Dialog>
        </div>
    );
};

export const StressTab = () => {
    const { problem } = useProblemContext();
    const runs = useBuilds(problem.id, "stress");
    const [params, setParams] = useSearchParams();
    const selected = params.get("run") ?? runs.data?.[0]?.id;
    const writable = can(problem.role, "write");

    return (
        <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
            <nav aria-label="Stress runs" className="order-2 min-w-0 xl:order-1">
                <h2 className="mb-1.5 text-xs font-medium text-muted">Previous runs</h2>
                {runs.isPending && <Loading />}
                {runs.error && <ErrorNotice error={runs.error} />}
                {runs.data?.length === 0 && (
                    <p className="text-[13px] text-muted">No stress runs yet.</p>
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
                                    <span className="font-mono font-medium">#{run.id}</span>
                                    <BuildBadge status={run.status} result={run.result} />
                                </span>
                                <span className="text-xs text-muted">
                                    {formatRelative(run.createdAt)}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            </nav>
            <div className="order-1 flex min-w-0 flex-col gap-4 xl:order-2">
                <Card title="New stress test">
                    {writable ? (
                        <StressForm onStarted={(id) => setParams({ run: id })} />
                    ) : (
                        <p className="text-sm text-muted">
                            Only authors and owners can run stress tests.
                        </p>
                    )}
                </Card>
                {selected ? (
                    <StressResult key={selected} runId={selected} />
                ) : (
                    runs.data && (
                        <EmptyState
                            icon={<FlaskConical className="size-6" />}
                            title="No stress runs yet"
                        >
                            A stress test generates many small tests, answers them with the main
                            solution and checks another solution against those answers. Failing
                            cases can be added to the test set with one click.
                        </EmptyState>
                    )
                )}
            </div>
        </div>
    );
};
