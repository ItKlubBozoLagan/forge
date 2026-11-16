import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Gauge, XCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { IssueList } from "../../../components/IssueList";
import { api } from "../../../lib/api";
import { formatDate, formatDuration, plural } from "../../../lib/format";
import { useTicker } from "../../../lib/hooks";
import { can, isActive, keys, useBuild } from "../../../lib/queries";
import type { BuildOutput, Problem, Revision } from "../../../lib/types";
import { BuildBadge } from "../../../ui/Badge";
import { Button } from "../../../ui/Button";
import { cx } from "../../../ui/cx";
import { ErrorNotice, Loading, Progress } from "../../../ui/misc";
import { useToast } from "../../../ui/Toast";
import { CalibrationCard } from "./Calibration";
import { KillCard } from "./Kills";
import { Matrix } from "./Matrix";
import { TestDialog } from "./TestDialog";
import { TimingPanel } from "./Timing";

const PHASES: Record<string, string> = {
    generate: "Generating tests",
    validate: "Validating groups",
    answers: "Producing answers with the main solution",
    solutions: "Running solutions",
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
    const [remeasuring, setRemeasuring] = useState(false);
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const toast = useToast();
    useTicker(isActive(build.data?.status));

    if (build.isPending) return <Loading label="Loading build" />;
    if (build.error) return <ErrorNotice error={build.error} />;
    const data = build.data;
    const output = data.output;
    const report = output?.report;
    const revision = revisions?.find((item) => item.id === data.revisionId);
    const errors = report?.issues.filter((issue) => issue.severity === "error").length ?? 0;
    const warnings = report?.issues.filter((issue) => issue.severity === "warning").length ?? 0;

    const remeasure = async () => {
        setRemeasuring(true);
        try {
            const result = await api.post<{ id: string }>(`/problems/${problem.id}/builds`, {
                remeasure: true,
                ...(data.revisionId ? { revision: data.revisionId } : {}),
            });
            await queryClient.invalidateQueries({ queryKey: keys.builds(problem.id, "build") });
            navigate(`/p/${problem.id}/builds/${result.id}`);
        } catch (error) {
            toast.error(error);
        } finally {
            setRemeasuring(false);
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
                {can(problem.role, "write") && !isActive(data.status) && (
                    <Button
                        size="sm"
                        className="ml-auto"
                        icon={<Gauge className="size-3.5" />}
                        pending={remeasuring}
                        onClick={remeasure}
                        title="Run every solution again to collect more timing samples"
                    >
                        Re-measure
                    </Button>
                )}
            </div>

            {isActive(data.status) && (
                <div className="rounded-lg border border-line bg-surface p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span>
                            {data.status === "queued"
                                ? "Waiting for a runner"
                                : (PHASES[data.progress?.phase ?? ""] ??
                                  data.progress?.phase ??
                                  "Starting")}
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
                        total={data.status === "queued" ? 0 : (data.progress?.total ?? 0)}
                    />
                </div>
            )}

            {data.status === "failed" && (
                <ErrorNotice error={new Error(data.error ?? "The build failed unexpectedly")} />
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

                    {report.issues.length > 0 && <IssueList issues={report.issues} />}

                    <Matrix output={output} onOpenTest={setOpenTest} />

                    {report.solutions.length > 0 && (
                        <div className="grid gap-3 lg:grid-cols-2">
                            <CalibrationCard
                                calibration={report.calibration}
                                hardwareClass={output.runner.hardwareClass}
                                referenceClass={problem.workspace.referenceClass}
                            />
                            <KillCard
                                kills={report.kills}
                                decisive={report.decisiveTests}
                                onOpenTest={setOpenTest}
                            />
                        </div>
                    )}

                    {report.solutions.length > 0 && <TimingPanel buildId={data.id} />}
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
