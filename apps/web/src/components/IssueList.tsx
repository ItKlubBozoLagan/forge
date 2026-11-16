import type { Issue } from "@forge/core";
import { CircleAlert, TriangleAlert } from "lucide-react";

import { cx } from "../ui/cx";

/** Errors first, then warnings; every item shows its code and message. */
export const IssueList = ({
    issues,
    testId = "issues",
    className,
}: {
    issues: Issue[];
    testId?: string;
    className?: string;
}) => {
    const sorted = [...issues].sort(
        (a, b) => (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1),
    );
    return (
        <ul
            data-testid={testId}
            className={cx(
                "divide-y divide-line rounded-lg border border-line bg-surface",
                className,
            )}
        >
            {sorted.map((issue, index) => (
                <li key={index} className="flex items-start gap-2 px-3 py-2 text-sm">
                    {issue.severity === "error" ? (
                        <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                    ) : (
                        <TriangleAlert
                            className="mt-0.5 size-4 shrink-0 text-warning"
                            aria-hidden
                        />
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span
                                className={cx(
                                    "text-xs font-semibold uppercase",
                                    issue.severity === "error" ? "text-danger" : "text-warning",
                                )}
                            >
                                {issue.severity}
                            </span>
                            <code className="font-mono text-xs text-muted">{issue.code}</code>
                            {issue.ref && (
                                <code className="font-mono text-xs text-subtle">{issue.ref}</code>
                            )}
                        </div>
                        <p className="break-words">{issue.message.split("\n")[0]}</p>
                        {issue.message.includes("\n") && (
                            <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-line bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap">
                                {issue.message.slice(issue.message.indexOf("\n") + 1)}
                            </pre>
                        )}
                    </div>
                </li>
            ))}
        </ul>
    );
};
