import { formatBytes, plural } from "../../../lib/format";
import type { BuildOutput } from "../../../lib/types";
import { Badge } from "../../../ui/Badge";
import { Card } from "../../../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../../../ui/Table";

/**
 * Every test of the build with where it came from and what the validator said about it.
 * A test is validated once per group whose constraints it has to satisfy: its own group and
 * every group that depends on it.
 */
export const TestsCard = ({
    output,
    onOpenTest,
}: {
    output: BuildOutput;
    onOpenTest: (testId: string) => void;
}) => {
    const tests = output.tests;
    const checks = tests.flatMap((test) => Object.values(test.validation));
    const rejected = checks.filter((message) => message !== null).length;
    const broken = tests.filter((test) => test.error).length;
    const validated = checks.length > 0;
    const order = new Map(output.groups.map((group, index) => [group.name, index]));

    return (
        <Card title="Tests and validation">
            <div
                className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                data-testid="validation-summary"
            >
                {!output.validator ? (
                    <>
                        <Badge tone="warning">no validator</Badge>
                        <span className="text-muted">
                            Nothing checks that the tests satisfy the constraints. Set{" "}
                            <code className="font-mono">validator</code> in problem.yaml.
                        </span>
                    </>
                ) : !validated ? (
                    <>
                        <Badge tone="neutral">not run</Badge>
                        <span className="text-muted">
                            The validator <span className="font-mono">{output.validator}</span> did
                            not run in this build.
                        </span>
                    </>
                ) : (
                    <>
                        <Badge tone={rejected === 0 ? "success" : "danger"}>
                            {rejected === 0 ? "all valid" : `${rejected} rejected`}
                        </Badge>
                        <span>
                            Validator <span className="font-mono">{output.validator}</span> ran{" "}
                            {plural(checks.length, "check")} on {plural(tests.length, "test")}
                            {rejected === 0 ? ", all passed." : `, ${rejected} failed.`}
                        </span>
                    </>
                )}
                {broken > 0 && (
                    <Badge tone="danger">{plural(broken, "test")} could not be produced</Badge>
                )}
            </div>
            {tests.length === 0 ? (
                <p className="text-sm text-muted">This build has no tests.</p>
            ) : (
                <TableWrap className="max-h-96 overflow-y-auto">
                    <Table data-testid="tests-table">
                        <thead>
                            <tr>
                                <Th>Test</Th>
                                <Th>Source</Th>
                                <Th className="text-right">Input</Th>
                                <Th>Validator</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {tests.map((test) => {
                                // groups in the order problem.yaml lists them
                                const results = Object.entries(test.validation).sort(
                                    ([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
                                );
                                const failures = results.filter(([, message]) => message !== null);
                                return (
                                    <Tr key={test.id} data-testid={`test-row-${test.id}`}>
                                        <Td>
                                            <button
                                                type="button"
                                                onClick={() => onOpenTest(test.id)}
                                                className="font-mono text-xs text-accent hover:underline"
                                            >
                                                {test.id}
                                            </button>
                                        </Td>
                                        <Td className="max-w-64 text-xs">
                                            <div className="flex min-w-0 items-center gap-1.5">
                                                <span
                                                    className="truncate font-mono"
                                                    title={test.source}
                                                >
                                                    {test.source}
                                                </span>
                                                {test.answerFile && (
                                                    <Badge
                                                        tone="accent"
                                                        title={test.answerFile}
                                                        data-testid={`answer-file-${test.id}`}
                                                    >
                                                        hand-written answer
                                                    </Badge>
                                                )}
                                            </div>
                                            {test.desc && (
                                                <div
                                                    className="mt-0.5 truncate text-muted"
                                                    title={test.desc}
                                                >
                                                    {test.desc}
                                                </div>
                                            )}
                                        </Td>
                                        <Td className="text-right font-mono text-xs whitespace-nowrap">
                                            {test.inputSize === undefined
                                                ? "-"
                                                : formatBytes(test.inputSize)}
                                        </Td>
                                        <Td>
                                            {test.error ? (
                                                <span className="text-xs text-danger">
                                                    {test.error.split("\n")[0]}
                                                </span>
                                            ) : results.length === 0 ? (
                                                <span className="text-xs text-subtle">
                                                    not validated
                                                </span>
                                            ) : failures.length === 0 ? (
                                                <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
                                                    <Badge tone="success">valid</Badge>
                                                    <span className="text-muted">
                                                        for{" "}
                                                        {results.map(([group]) => group).join(", ")}
                                                    </span>
                                                </span>
                                            ) : (
                                                <ul className="flex flex-col gap-1 text-xs">
                                                    {failures.map(([group, message]) => (
                                                        <li
                                                            key={group}
                                                            className="flex flex-wrap items-start gap-1.5"
                                                        >
                                                            <Badge tone="danger">
                                                                invalid for {group}
                                                            </Badge>
                                                            <span className="text-danger">
                                                                {message?.split("\n")[0]}
                                                            </span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                        </Td>
                                    </Tr>
                                );
                            })}
                        </tbody>
                    </Table>
                </TableWrap>
            )}
        </Card>
    );
};
