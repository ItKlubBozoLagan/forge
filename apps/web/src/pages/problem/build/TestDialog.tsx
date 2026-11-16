import type { BuildOutput } from "../../../lib/types";
import { Badge, Verdict } from "../../../ui/Badge";
import { Dialog } from "../../../ui/Dialog";
import { ErrorNotice } from "../../../ui/misc";
import { Table, Td, Th, Tr } from "../../../ui/Table";
import { formatKb, formatMs } from "../../../lib/format";
import { BlobPreview } from "./BlobPreview";

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
                    </section>
                    {test.error && <ErrorNotice error={new Error(test.error)} />}
                    <section>
                        <h3 className="mb-1 text-[13px] font-semibold">Validation</h3>
                        {Object.keys(test.validation).length === 0 ? (
                            <p className="text-sm text-muted">Not validated (no validator).</p>
                        ) : (
                            <ul className="flex flex-col gap-1 text-sm">
                                {Object.entries(test.validation).map(([group, message]) => (
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
                                            <Tr key={solution}>
                                                <Td className="font-mono text-xs">{solution}</Td>
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
                                                    {result?.message ?? ""}
                                                </Td>
                                            </Tr>
                                        );
                                    })}
                                </tbody>
                            </Table>
                        </div>
                    </section>
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
