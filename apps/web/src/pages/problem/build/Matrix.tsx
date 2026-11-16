import type { GroupOutcome, SolutionReport } from "@forge/core";
import { Check, Star, X } from "lucide-react";

import { basename, formatKb, formatMs } from "../../../lib/format";
import type { BuildGroup, BuildOutput } from "../../../lib/types";
import { Badge, Verdict, VerdictSummary } from "../../../ui/Badge";
import { cx } from "../../../ui/cx";

const constraintText = (constraints: BuildGroup["constraints"]) =>
    Object.entries(constraints)
        .map(([name, bound]) => {
            if (bound.min !== undefined && bound.max !== undefined)
                return `${bound.min} ≤ ${name} ≤ ${bound.max}`;
            if (bound.max !== undefined) return `${name} ≤ ${bound.max}`;
            if (bound.min !== undefined) return `${name} ≥ ${bound.min}`;
            return name;
        })
        .join(", ");

const outcomeFor = (solution: SolutionReport, group: string): GroupOutcome | undefined =>
    solution.groups.find((outcome) => outcome.group === group);

const Expectation = ({ outcome }: { outcome: GroupOutcome | undefined }) => {
    if (!outcome || outcome.meets === undefined) return null;
    const label = `expected ${outcome.expected}, got ${outcome.summary}`;
    return outcome.meets ? (
        <span className="inline-flex items-center gap-0.5 text-success" title={label}>
            <Check className="size-3.5" aria-hidden />
            <span className="sr-only">meets expectation: </span>
            <span className="text-[11px]">ok</span>
        </span>
    ) : (
        <span className="inline-flex items-center gap-0.5 text-danger" title={label}>
            <X className="size-3.5" aria-hidden />
            <span className="text-[11px]">
                expected {outcome.expected}, got {outcome.summary}
            </span>
        </span>
    );
};

/**
 * The invocation matrix: tests (grouped) by solutions. Every cell shows the verdict and time;
 * each group ends with the per-solution outcome against the solution's expectation.
 */
export const Matrix = ({
    output,
    onOpenTest,
}: {
    output: BuildOutput;
    onOpenTest: (testId: string) => void;
}) => {
    const solutions = output.report.solutions;
    const tests = new Map(output.tests.map((test) => [test.id, test]));
    const decisive = new Set(output.report.decisiveTests);
    const columns = 2 + solutions.length;

    if (solutions.length === 0 && output.tests.length === 0)
        return (
            <p className="rounded-lg border border-dashed border-line-strong p-4 text-sm text-muted">
                Nothing was run: the build stopped before tests and solutions were executed. See the
                issues above.
            </p>
        );

    return (
        <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
            <table data-testid="matrix" className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10">
                    <tr className="bg-surface-2">
                        <th
                            scope="col"
                            className="border-b border-line px-3 py-1.5 text-left text-xs font-medium text-muted"
                        >
                            Test
                        </th>
                        <th
                            scope="col"
                            className="hidden border-b border-line px-3 py-1.5 text-left text-xs font-medium text-muted lg:table-cell"
                        >
                            Source
                        </th>
                        {solutions.map((solution) => (
                            <th
                                key={solution.path}
                                scope="col"
                                title={solution.path}
                                className="border-b border-l border-line px-2 py-1.5 text-left text-xs font-medium whitespace-nowrap"
                            >
                                <span className="inline-flex items-center gap-1">
                                    <span className="font-mono">{basename(solution.path)}</span>
                                    {solution.main && (
                                        <Badge
                                            tone="accent"
                                            title="Main solution: produces the answers"
                                        >
                                            <Star className="size-3" aria-hidden />
                                            main
                                        </Badge>
                                    )}
                                </span>
                            </th>
                        ))}
                    </tr>
                </thead>
                {output.groups.map((group) => (
                    <tbody key={group.name}>
                        <tr className="bg-surface-2/60">
                            <th
                                scope="rowgroup"
                                title={constraintText(group.constraints)}
                                className="border-y border-line px-3 py-1.5 text-left align-top"
                            >
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-mono text-[13px] font-semibold">
                                        {group.name}
                                    </span>
                                    <Badge>{group.points} pts</Badge>
                                    {group.sample && <Badge tone="accent">sample</Badge>}
                                    {group.depends.length > 0 && (
                                        <span className="text-xs font-normal text-muted">
                                            needs {group.depends.join(", ")}
                                        </span>
                                    )}
                                </div>
                                {Object.keys(group.constraints).length > 0 && (
                                    <div className="mt-0.5 hidden font-mono text-[11px] font-normal text-muted sm:block lg:hidden">
                                        {constraintText(group.constraints)}
                                    </div>
                                )}
                            </th>
                            <td className="hidden border-y border-line px-3 py-1.5 font-mono text-[11px] text-muted lg:table-cell">
                                {constraintText(group.constraints)}
                            </td>
                            {solutions.map((solution) => {
                                const outcome = outcomeFor(solution, group.name);
                                return (
                                    <td
                                        key={solution.path}
                                        className="border-y border-l border-line px-2 py-1.5 text-xs text-muted whitespace-nowrap"
                                    >
                                        {outcome?.expected ? (
                                            <>
                                                expect{" "}
                                                <span className="font-mono text-fg">
                                                    {outcome.expected}
                                                </span>
                                            </>
                                        ) : (
                                            <span className="text-subtle">no expectation</span>
                                        )}
                                    </td>
                                );
                            })}
                        </tr>
                        {group.tests.length === 0 && (
                            <tr>
                                <td colSpan={columns} className="px-3 py-1.5 text-xs text-muted">
                                    No own tests
                                    {group.depends.length > 0
                                        ? `; scored on the tests of ${group.depends.join(", ")}`
                                        : ""}
                                    .
                                </td>
                            </tr>
                        )}
                        {group.tests.map((testId) => {
                            const test = tests.get(testId);
                            return (
                                <tr key={testId} className="hover:bg-surface-2/50">
                                    <td className="border-b border-line px-3 py-1 whitespace-nowrap">
                                        <button
                                            type="button"
                                            onClick={() => onOpenTest(testId)}
                                            title={test?.source}
                                            className="font-mono text-[12.5px] text-accent hover:underline"
                                        >
                                            {testId}
                                        </button>
                                        {decisive.has(testId) && (
                                            <Badge
                                                tone="warning"
                                                className="ml-1.5"
                                                title="The only test killing some wrong solution"
                                            >
                                                decisive
                                            </Badge>
                                        )}
                                    </td>
                                    <td
                                        className="hidden max-w-64 truncate border-b border-line px-3 py-1 font-mono text-[11px] text-muted lg:table-cell"
                                        title={test?.source}
                                    >
                                        {test?.source}
                                    </td>
                                    {test?.error ? (
                                        <td
                                            colSpan={solutions.length}
                                            className="border-b border-l border-line px-2 py-1 text-xs text-danger"
                                        >
                                            {test.error}
                                        </td>
                                    ) : (
                                        solutions.map((solution) => {
                                            const result = output.matrix[solution.path]?.[testId];
                                            const expected = outcomeFor(
                                                solution,
                                                group.name,
                                            )?.expected;
                                            const unexpected =
                                                !!result &&
                                                expected === "AC" &&
                                                result.verdict !== "AC";
                                            return (
                                                <td
                                                    key={solution.path}
                                                    data-testid={`cell-${solution.path}-${testId}`}
                                                    title={
                                                        result
                                                            ? [
                                                                  `${result.verdict} in ${formatMs(result.timeMs)}`,
                                                                  `memory ${formatKb(result.memoryKb)}`,
                                                                  `score ${result.score}`,
                                                                  result.message,
                                                              ]
                                                                  .filter(Boolean)
                                                                  .join("\n")
                                                            : "Not run"
                                                    }
                                                    className={cx(
                                                        "border-b border-l border-line px-2 py-1 whitespace-nowrap",
                                                        unexpected && "bg-danger-soft",
                                                    )}
                                                >
                                                    {result ? (
                                                        <span className="inline-flex items-center gap-1.5">
                                                            <Verdict verdict={result.verdict} />
                                                            <span className="font-mono text-[11.5px] text-muted">
                                                                {result.timeMs}
                                                                <span className="text-subtle">
                                                                    {" "}
                                                                    ms
                                                                </span>
                                                            </span>
                                                        </span>
                                                    ) : (
                                                        <span className="text-subtle">-</span>
                                                    )}
                                                </td>
                                            );
                                        })
                                    )}
                                </tr>
                            );
                        })}
                        <tr className="bg-surface-2/40">
                            <td
                                colSpan={1}
                                className="border-b border-line px-3 py-1.5 text-xs text-muted"
                            >
                                Group result
                                {group.depends.length > 0 && (
                                    <span className="text-subtle">
                                        {" "}
                                        (incl. {group.depends.join(", ")})
                                    </span>
                                )}
                            </td>
                            <td className="hidden border-b border-line lg:table-cell" />
                            {solutions.map((solution) => {
                                const outcome = outcomeFor(solution, group.name);
                                return (
                                    <td
                                        key={solution.path}
                                        className="border-b border-l border-line px-2 py-1.5 align-top"
                                    >
                                        {outcome ? (
                                            <div className="flex flex-col gap-0.5">
                                                <div className="flex items-center gap-1.5">
                                                    <VerdictSummary summary={outcome.summary} />
                                                    <span className="font-mono text-[11.5px]">
                                                        {outcome.score}/{outcome.maxScore}
                                                    </span>
                                                </div>
                                                <Expectation outcome={outcome} />
                                            </div>
                                        ) : (
                                            <span className="text-subtle">-</span>
                                        )}
                                    </td>
                                );
                            })}
                        </tr>
                    </tbody>
                ))}
                <tfoot>
                    <tr className="bg-surface-2">
                        <th scope="row" className="px-3 py-2 text-left text-[13px] font-semibold">
                            Total
                        </th>
                        <td className="hidden lg:table-cell" />
                        {solutions.map((solution) => (
                            <td
                                key={solution.path}
                                className="border-l border-line px-2 py-2 whitespace-nowrap"
                            >
                                <span className="font-mono text-[13px] font-semibold">
                                    {solution.score}/{solution.maxScore}
                                </span>{" "}
                                <span className="font-mono text-[11px] text-muted">
                                    max {formatMs(solution.maxTimeMs)}
                                </span>{" "}
                                {solution.ok ? (
                                    <Badge tone="success">as expected</Badge>
                                ) : (
                                    <Badge tone="danger">unexpected</Badge>
                                )}
                            </td>
                        ))}
                    </tr>
                </tfoot>
            </table>
        </div>
    );
};
