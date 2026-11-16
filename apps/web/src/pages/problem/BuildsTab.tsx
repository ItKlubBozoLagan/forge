import { Hammer } from "lucide-react";
import { Navigate, NavLink, useParams } from "react-router";

import { formatDate, formatRelative } from "../../lib/format";
import { can, useBuilds, useRevisions } from "../../lib/queries";
import { BuildBadge } from "../../ui/Badge";
import { cx } from "../../ui/cx";
import { EmptyState, ErrorNotice, Loading } from "../../ui/misc";
import { BuildDetail } from "./build/BuildDetail";
import { useProblemContext } from "./ProblemLayout";

export const BuildsTab = () => {
    const { problem } = useProblemContext();
    const { buildId } = useParams();
    const builds = useBuilds(problem.id, "build");
    const revisions = useRevisions(problem.id);

    if (builds.isPending) return <Loading />;
    if (builds.error) return <ErrorNotice error={builds.error} />;
    const list = builds.data;
    if (!buildId && list[0])
        return <Navigate to={`/p/${problem.id}/builds/${list[0].id}`} replace />;
    if (!buildId)
        return (
            <EmptyState icon={<Hammer className="size-6" />} title="No builds yet">
                {can(problem.role, "write")
                    ? "Press Build at the top to generate the tests, run every solution and check the package."
                    : "Nobody has built this problem yet."}
            </EmptyState>
        );

    const numberOf = (revisionId: string | null) =>
        revisionId
            ? revisions.data?.find((revision) => revision.id === revisionId)?.number
            : undefined;

    return (
        <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
            <nav aria-label="Builds" className="min-w-0">
                <h2 className="mb-1.5 text-xs font-medium text-muted">Builds</h2>
                <ul className="flex gap-1.5 overflow-x-auto pb-1 xl:flex-col xl:overflow-visible">
                    {list.map((build) => {
                        const number = numberOf(build.revisionId);
                        return (
                            <li key={build.id} className="shrink-0">
                                <NavLink
                                    to={`/p/${problem.id}/builds/${build.id}`}
                                    className={({ isActive }) =>
                                        cx(
                                            "flex flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-[13px]",
                                            isActive
                                                ? "border-accent bg-accent-soft"
                                                : "border-line bg-surface hover:border-line-strong",
                                        )
                                    }
                                >
                                    <span className="flex items-center justify-between gap-2">
                                        <span className="font-mono font-medium">#{build.id}</span>
                                        <BuildBadge status={build.status} result={build.result} />
                                    </span>
                                    <span
                                        className="text-xs text-muted"
                                        title={formatDate(build.createdAt)}
                                    >
                                        {number !== undefined
                                            ? `rev ${number}`
                                            : build.revisionId
                                              ? "revision"
                                              : "working copy"}{" "}
                                        · {formatRelative(build.createdAt)}
                                    </span>
                                </NavLink>
                            </li>
                        );
                    })}
                </ul>
            </nav>
            <BuildDetail
                key={buildId}
                problem={problem}
                buildId={buildId}
                revisions={revisions.data}
            />
        </div>
    );
};
