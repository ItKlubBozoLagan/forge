import type { KillRow } from "@forge/core";

import { basename } from "../../../lib/format";
import { Badge } from "../../../ui/Badge";
import { cx } from "../../../ui/cx";
import { Card } from "../../../ui/misc";

export const KillCard = ({
    kills,
    decisive,
    onOpenTest,
}: {
    kills: KillRow[];
    decisive: string[];
    onOpenTest: (testId: string) => void;
}) => {
    const decisiveSet = new Set(decisive);
    return (
        <Card title="Kill matrix">
            {kills.length === 0 ? (
                <p className="text-sm text-muted">
                    No solution is expected to fail, so there is nothing to kill. Add a wrong or
                    slow solution with an <code className="font-mono">expect</code> in problem.yaml
                    to measure how strong the tests are.
                </p>
            ) : (
                <ul className="flex flex-col gap-3">
                    {kills.map((row) => (
                        <li key={row.solution}>
                            <div className="mb-1 flex flex-wrap items-center gap-2 text-[13px]">
                                <span className="font-mono font-medium" title={row.solution}>
                                    {basename(row.solution)}
                                </span>
                                {row.killedBy.length === 0 ? (
                                    <Badge tone="danger">not killed by any test</Badge>
                                ) : (
                                    <span className="text-muted">
                                        killed by {row.killedBy.length}{" "}
                                        {row.killedBy.length === 1 ? "test" : "tests"}
                                    </span>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-1">
                                {row.killedBy.map((testId) => {
                                    const isDecisive = decisiveSet.has(testId);
                                    return (
                                        <button
                                            key={testId}
                                            type="button"
                                            onClick={() => onOpenTest(testId)}
                                            title={
                                                isDecisive
                                                    ? "Decisive: the only test killing a solution"
                                                    : undefined
                                            }
                                            className={cx(
                                                "rounded border px-1.5 py-0.5 font-mono text-[11.5px] hover:border-accent",
                                                isDecisive
                                                    ? "border-warning bg-warning-soft font-semibold text-warning"
                                                    : "border-line bg-surface-2",
                                            )}
                                        >
                                            {testId}
                                            {isDecisive && (
                                                <span className="sr-only"> (decisive)</span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            {decisive.length > 0 && (
                <p className="mt-3 text-xs text-muted">
                    Highlighted tests are decisive: they are the only test catching some solution.
                </p>
            )}
        </Card>
    );
};
