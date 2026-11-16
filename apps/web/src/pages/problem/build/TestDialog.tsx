import { useState } from "react";

import type { BuildOutput } from "../../../lib/types";
import { Badge, Verdict } from "../../../ui/Badge";
import { Dialog } from "../../../ui/Dialog";
import { ErrorNotice } from "../../../ui/misc";
import { Table, Td, Th, Tr } from "../../../ui/Table";
import { formatKb, formatMs } from "../../../lib/format";
import { BlobPreview } from "./BlobPreview";

/** Compiler output and long checker messages are shown under the table, not squeezed into a cell. */
const firstLine = (message: string | undefined) => {
    const line = (message ?? "").split("\n")[0] ?? "";
    return line.length > 120 ? `${line.slice(0, 120)}...` : line;
};

export const TestDialog = ({
    problemId,
    output,
    testId,
    onClose,
}: {
    problemId: string;
    output: BuildOutput;
    testId: string | undefined;
    onClose: () => void;
}) => {
    const test = output.tests.find((item) => item.id === testId);
    const safeName = (testId ?? "test").replace(/\//g, "-");
    const [chosen, setChosen] = useState<string>();
    const solutions = Object.keys(output.matrix);
    // start on the first solution that fails this test: that is the output worth reading
    const selected =
        chosen && solutions.includes(chosen)
            ? chosen
            : (solutions.find((path) => {
                  const verdict = output.matrix[path]?.[testId ?? ""]?.verdict;
                  return verdict !== undefined && verdict !== "AC";
              }) ?? solutions[0]);
    const selectedResult = selected ? output.matrix[selected]?.[testId ?? ""] : undefined;
    return (
        <Dialog
            open={!!testId}
            onClose={onClose}
            variant="drawer"
            title={<span className="font-mono">Test {testId}</span>}
            description={test ? `Group ${test.group}, test ${test.index}` : undefined}
        >
            {test && (
                <div className="flex flex-col gap-4">
                    <section>
                        <h3 className="mb-1 text-[13px] font-semibold">Source</h3>
                        <code className="block rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-xs break-all">
                            {test.source}
                        </code>
                        {test.desc && <p className="mt-1.5 text-sm text-muted">{test.desc}</p>}
                        {test.answerFile && (
                            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm">
                                <Badge tone="accent">hand-written answer</Badge>
                                <span className="text-muted">
                                    The answer is the file{" "}
                                    <span className="font-mono">{test.answerFile}</span>, not the
                                    main solution's output.
                                </span>
                            </p>
                        )}
                    </section>
                    {test.error && <ErrorNotice error={new Error(test.error)} />}
                    <section>
                        <h3 className="mb-1 text-[13px] font-semibold">Validation</h3>
                        {Object.keys(test.validation).length === 0 ? (
                            <p className="text-sm text-muted">Not validated (no validator).</p>
                        ) : (
                            <ul className="flex flex-col gap-1 text-sm">
                                {output.groups
                                    .filter((group) => group.name in test.validation)
                                    .map((group) => [group.name, test.validation[group.name]] as const)
                                    .map(([group, message]) => (
                                    <li key={group} className="flex flex-wrap items-start gap-2">
                                        <span className="font-mono text-xs">{group}</span>
                                        {message === null ? (
                                            <Badge tone="success">valid</Badge>
                                        ) : (
                                            <>
                                                <Badge tone="danger">invalid</Badge>
                                                <span className="text-danger">{message}</span>
                                            </>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                    <section>
                        <h3 className="mb-1 text-[13px] font-semibold">Results</h3>
                        <div className="relative overflow-x-auto rounded-md border border-line">
                            <Table>
                                <thead>
                                    <tr>
                                        <Th>Solution</Th>
                                        <Th>Verdict</Th>
                                        <Th className="text-right">Time</Th>
                                        <Th className="text-right">Memory</Th>
                                        <Th>Message</Th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {Object.entries(output.matrix).map(([solution, row]) => {
                                        const result = row[test.id];
                                        return (
                                            <Tr
                                                key={solution}
                                                className={solution === selected ? "bg-accent-soft/40" : undefined}
                                            >
                                                <Td className="font-mono text-xs">
                                                    <button
                                                        type="button"
                                                        className="text-left text-accent hover:underline"
                                                        aria-pressed={solution === selected}
                                                        onClick={() => setChosen(solution)}
                                                    >
                                                        {solution}
                                                    </button>
                                                </Td>
                                                <Td>
                                                    {result ? (
                                                        <Verdict verdict={result.verdict} />
                                                    ) : (
                                                        "-"
                                                    )}
                                                </Td>
                                                <Td className="text-right font-mono text-xs">
                                                    {formatMs(result?.timeMs)}
                                                </Td>
                                                <Td className="text-right font-mono text-xs">
                                                    {formatKb(result?.memoryKb)}
                                                </Td>
                                                <Td className="text-xs text-muted">
                                                    {firstLine(result?.message)}
                                                </Td>
                                            </Tr>
                                        );
                                    })}
                                </tbody>
                            </Table>
                        </div>
                    </section>
                    {selected && (
                        <section data-testid="solution-output">
                            <h3 className="mb-1 text-[13px] font-semibold">
                                Output of <span className="font-mono">{selected}</span>
                            </h3>
                            {selectedResult?.message && selectedResult.message.includes("\n") && (
                                <pre className="mb-2 max-h-64 overflow-auto rounded-md border border-line bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap">
                                    {selectedResult.message}
                                </pre>
                            )}
                            {selectedResult?.outputHash ? (
                                <BlobPreview
                                    problemId={problemId}
                                    hash={selectedResult.outputHash}
                                    label="Output"
                                    fileName={`${safeName}.${selected.replace(/[^A-Za-z0-9]+/g, "-")}.out`}
                                />
                            ) : (
                                <p className="text-sm text-muted">
                                    {selectedResult
                                        ? "No output was kept for this run (the program was killed, crashed or did not compile)."
                                        : "This solution did not run on this test."}
                                </p>
                            )}
                            <p className="mt-1 text-xs text-muted">
                                Select a solution in the table to see what it printed.
                            </p>
                        </section>
                    )}
                    <BlobPreview
                        problemId={problemId}
                        hash={test.inputHash}
                        size={test.inputSize}
                        label="Input"
                        fileName={`${safeName}.in`}
                    />
                    <BlobPreview
                        problemId={problemId}
                        hash={test.answerHash}
                        label="Answer"
                        fileName={`${safeName}.out`}
                    />
                </div>
            )}
        </Dialog>
    );
};
