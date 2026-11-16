import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, Gauge, RotateCcw, XCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { IssueList } from "../../../components/IssueList";
import { api } from "../../../lib/api";
import { downloadFrom } from "../../../lib/files";
import { formatDate, formatDuration, plural } from "../../../lib/format";
import { useTicker } from "../../../lib/hooks";
import { can, isActive, keys, useBuild } from "../../../lib/queries";
import type { BuildOutput, Health, Problem, Revision } from "../../../lib/types";
import { BuildBadge } from "../../../ui/Badge";
import { Button } from "../../../ui/Button";
import { cx } from "../../../ui/cx";
import { Card, ErrorNotice, Loading, Notice, Progress } from "../../../ui/misc";
import { useToast } from "../../../ui/Toast";
import { CalibrationCard } from "./Calibration";
import { CancelButton, CancelledNotice, isCancelled } from "./Cancel";
import { KillCard } from "./Kills";
import { Matrix } from "./Matrix";
import { TestDialog } from "./TestDialog";
import { TestsCard } from "./Tests";
import { TimingPanel } from "./Timing";

const PHASES: Record<string, string> = {
    generate: "Generating tests",
    validate: "Validating groups",
    answers: "Producing answers with the main solution",
    solutions: "Running solutions",
};

/** What judges this package: task type, checker or interactor, validator and limits. */
const BuildTools = ({ output }: { output: BuildOutput }) => {
    const type = output.type ?? "batch";
    const interactive = type === "interactive";
    const item = (label: string, value: string, mono = true) => (
        <span className="min-w-0">
            <span className="text-muted">{label} </span>
            <span className={cx("break-all", mono && "font-mono text-[12.5px]")}>{value}</span>
        </span>
    );
    return (
        <div
            data-testid="build-tools"
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm"
        >
            {item("type", type)}
            {output.checker
                ? item(interactive ? "interactor" : "checker", output.checker)
                : item(
                      interactive ? "interactor" : "checker",
                      interactive ? "none" : "compares output with the judge's default comparison",
                      false,
                  )}
            {item("validator", output.validator ?? "none")}
            {output.limits &&
                item("limits", `${output.limits.time_ms} ms, ${output.limits.memory_mb} MB`, false)}
        </div>
    );
};

export const BuildDetail = ({
    problem,
    buildId,
    revisions,
}: {
    problem: Problem;
    buildId: string;
    revisions?: Revision[];
}) => {
    const build = useBuild<BuildOutput>(buildId);
    const [openTest, setOpenTest] = useState<string>();
    const [starting, setStarting] = useState<"remeasure" | "clean">();
    const [downloading, setDownloading] = useState(false);
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const toast = useToast();
    const active = isActive(build.data?.status);
    useTicker(active);
    // while the build waits, check that some runner is answering on its queue
    const health = useQuery({
        queryKey: ["health", "runner"],
        queryFn: () => api.get<Health>("/health?runner=1"),
        enabled: active,
        refetchInterval: active ? 15_000 : false,
    });

    if (build.isPending) return <Loading label="Loading build" />;
    if (build.error) return <ErrorNotice error={build.error} />;
    const data = build.data;
    const output = data.output;
    const report = output?.report;
    const revision = revisions?.find((item) => item.id === data.revisionId);
    const errors = report?.issues.filter((issue) => issue.severity === "error").length ?? 0;
    const warnings = report?.issues.filter((issue) => issue.severity === "warning").length ?? 0;
    const writable = can(problem.role, "write");

    const start = async (mode: "remeasure" | "clean") => {
        setStarting(mode);
        try {
            const result = await api.post<{ id: string }>(`/problems/${problem.id}/builds`, {
                [mode]: true,
                ...(data.revisionId ? { revision: data.revisionId } : {}),
            });
            await queryClient.invalidateQueries({ queryKey: keys.builds(problem.id, "build") });
            navigate(`/p/${problem.id}/builds/${result.id}`);
        } catch (error) {
            toast.error(error);
        } finally {
            setStarting(undefined);
        }
    };

    const downloadTests = async () => {
        setDownloading(true);
        try {
            await downloadFrom(`/builds/${data.id}/tests.zip`, `${problem.name}-tests.zip`);
        } catch (error) {
            toast.error(error);
        } finally {
            setDownloading(false);
        }
    };

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">Build #{data.id}</h2>
                <BuildBadge status={data.status} result={data.result} testId="build-status" />
                <span className="text-xs text-muted">
                    {revision
                        ? `revision ${revision.number}`
                        : data.revisionId
                        ? "revision"
                        : "working copy"}
                    {data.params?.remeasure ? " · re-measure" : ""} · started{" "}
                    {formatDate(data.startedAt ?? data.createdAt)} ·{" "}
                    {formatDuration(data.startedAt, data.finishedAt)}
                </span>
                <div className="ml-auto flex flex-wrap gap-2">
                    {output && output.tests.length > 0 && (
                        <Button
                            size="sm"
                            icon={<Download className="size-3.5" />}
                            pending={downloading}
                            onClick={downloadTests}
                            title="Download every input and answer of this build as a zip"
                        >
                            Download tests
                        </Button>
                    )}
                    {writable && !active && (
                        <>
                            <Button
                                size="sm"
                                icon={<Gauge className="size-3.5" />}
                                pending={starting === "remeasure"}
                                disabled={!!starting}
                                onClick={() => start("remeasure")}
                                title="Run every solution again to collect more timing samples"
                            >
                                Re-measure
                            </Button>
                            <Button
                                size="sm"
                                icon={<RotateCcw className="size-3.5" />}
                                pending={starting === "clean"}
                                disabled={!!starting}
                                onClick={() => start("clean")}
                                title="Ignore every cached step: generate the tests, answers and runs again"
                            >
                                Rebuild from scratch
                            </Button>
                        </>
                    )}
                    <CancelButton problem={problem} run={data} />
                </div>
            </div>

            {active && health.data?.runner.alive === false && (
                <Notice tone="warning">
                    No evaluator is answering on queue{" "}
                    <span className="font-mono">{health.data.runner.pool}</span>, so the build will
                    wait until one starts.
                </Notice>
            )}

            {isActive(data.status) && (
                <div className="rounded-lg border border-line bg-surface p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span>
                            {data.status === "queued"
                                ? "Waiting for a runner"
                                : PHASES[data.progress?.phase ?? ""] ??
                                  data.progress?.phase ??
                                  "Starting"}
                        </span>
                        {data.progress && data.progress.total > 0 && (
                            <span className="font-mono text-xs text-muted">
                                {data.progress.done}/{data.progress.total}
                            </span>
                        )}
                    </div>
                    <Progress
                        label="Build progress"
                        done={data.progress?.done ?? 0}
                        total={data.status === "queued" ? 0 : data.progress?.total ?? 0}
                    />
                </div>
            )}

            {isCancelled(data) ? (
                <CancelledNotice run={data} next="Start a new build when you are ready." />
            ) : (
                data.status === "failed" && (
                    <ErrorNotice error={new Error(data.error ?? "The build failed unexpectedly")} />
                )
            )}

            {report && output && (
                <>
                    <div
                        className={cx(
                            "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2.5",
                            report.status === "green"
                                ? "border-success/40 bg-success-soft"
                                : "border-danger/40 bg-danger-soft",
                        )}
                    >
                        <span
                            className={cx(
                                "inline-flex items-center gap-1.5 font-semibold",
                                report.status === "green" ? "text-success" : "text-danger",
                            )}
                        >
                            {report.status === "green" ? (
                                <CheckCircle2 className="size-4" aria-hidden />
                            ) : (
                                <XCircle className="size-4" aria-hidden />
                            )}
                            {report.status === "green"
                                ? "Green: the package is consistent"
                                : "Red: the package has errors"}
                        </span>
                        <span className="text-sm">
                            {plural(errors, "error")}, {plural(warnings, "warning")}
                        </span>
                        <span className="text-xs text-muted sm:ml-auto">
                            runner <span className="font-mono">{output.runner.pool}</span> ·
                            hardware{" "}
                            <span className="font-mono">{output.runner.hardwareClass}</span>
                        </span>
                    </div>

                    <BuildTools output={output} />

                    {report.issues.length > 0 && <IssueList issues={report.issues} />}

                    <Matrix output={output} onOpenTest={setOpenTest} />

                    <TestsCard output={output} onOpenTest={setOpenTest} />

                    {report.solutions.length > 0 && (
                        <div className="grid gap-3 lg:grid-cols-2">
                            {output.type === "output-only" ? (
                                <Card title="Time limit">
                                    <p className="text-sm text-muted">
                                        Output-only task: contestants submit files, so there is no
                                        time limit to calibrate. The limits in problem.yaml only
                                        bound the programs listed as solutions.
                                    </p>
                                </Card>
                            ) : (
                                <CalibrationCard
                                    calibration={report.calibration}
                                    hardwareClass={output.runner.hardwareClass}
                                    referenceClass={problem.workspace.referenceClass}
                                />
                            )}
                            <KillCard
                                kills={report.kills}
                                decisive={report.decisiveTests}
                                onOpenTest={setOpenTest}
                            />
                        </div>
                    )}

                    {report.solutions.length > 0 && output.type !== "output-only" && (
                        <TimingPanel buildId={data.id} />
                    )}
                    <TestDialog
                        problemId={problem.id}
                        output={output}
                        testId={openTest}
                        onClose={() => setOpenTest(undefined)}
                    />
                </>
            )}
        </div>
    );
};
