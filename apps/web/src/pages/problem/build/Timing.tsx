import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { api } from "../../../lib/api";
import { keys } from "../../../lib/queries";
import type { Timing } from "../../../lib/types";
import { Badge } from "../../../ui/Badge";
import { ErrorNotice, Spinner } from "../../../ui/misc";
import { Table, Td, Th, Tr } from "../../../ui/Table";

const TimingTables = ({ buildId }: { buildId: string }) => {
    const timing = useQuery({
        queryKey: keys.timing(buildId),
        queryFn: () => api.get<Timing>(`/builds/${buildId}/timing`),
    });
    if (timing.isPending) return <Spinner label="Loading timing samples" />;
    if (timing.error) return <ErrorNotice error={timing.error} />;
    const { referenceClass, samples } = timing.data;
    const solutions = Object.entries(samples);
    if (solutions.length === 0) return <p className="text-sm text-muted">No timing samples.</p>;
    return (
        <div className="flex flex-col gap-3">
            <p className="text-xs text-muted">
                Every run of a solution on a test is a sample. Re-measure adds samples.{" "}
                {referenceClass ? (
                    <>
                        The workspace reference class is{" "}
                        <span className="font-mono">{referenceClass}</span>.
                    </>
                ) : (
                    "The workspace has no reference hardware class (set it in Settings)."
                )}
            </p>
            {solutions.map(([solution, tests]) => (
                <div key={solution} className="relative overflow-x-auto rounded-md border border-line">
                    <Table>
                        <caption className="bg-surface-2 px-3 py-1.5 text-left font-mono text-xs font-medium">
                            {solution}
                        </caption>
                        <thead>
                            <tr>
                                <Th>Test</Th>
                                <Th>Hardware class</Th>
                                <Th className="text-right">Samples</Th>
                                <Th className="text-right">Min</Th>
                                <Th className="text-right">Median</Th>
                                <Th className="text-right">Max</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {Object.entries(tests).flatMap(([testId, stats]) =>
                                stats.length === 0
                                    ? [
                                          <Tr key={testId}>
                                              <Td className="font-mono text-xs">{testId}</Td>
                                              <Td colSpan={5} className="text-xs text-subtle">
                                                  no samples
                                              </Td>
                                          </Tr>,
                                      ]
                                    : stats.map((stat, index) => (
                                          <Tr key={`${testId}-${stat.hardwareClass}`}>
                                              <Td className="font-mono text-xs">
                                                  {index === 0 ? testId : ""}
                                              </Td>
                                              <Td className="font-mono text-xs">
                                                  {stat.hardwareClass}{" "}
                                                  {stat.hardwareClass === referenceClass && (
                                                      <Badge tone="accent">reference</Badge>
                                                  )}
                                              </Td>
                                              <Td className="text-right font-mono text-xs">
                                                  {stat.count}
                                              </Td>
                                              <Td className="text-right font-mono text-xs">
                                                  {stat.min}
                                              </Td>
                                              <Td className="text-right font-mono text-xs">
                                                  {stat.median}
                                              </Td>
                                              <Td className="text-right font-mono text-xs">
                                                  {stat.max}
                                              </Td>
                                          </Tr>
                                      )),
                            )}
                        </tbody>
                    </Table>
                </div>
            ))}
        </div>
    );
};

export const TimingPanel = ({ buildId }: { buildId: string }) => {
    const [open, setOpen] = useState(false);
    return (
        <section className="rounded-lg border border-line bg-surface">
            <h3>
                <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpen((value) => !value)}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] font-semibold"
                >
                    {open ? (
                        <ChevronDown className="size-4" aria-hidden />
                    ) : (
                        <ChevronRight className="size-4" aria-hidden />
                    )}
                    Timing samples
                    <span className="font-normal text-muted">
                        (times in ms, per hardware class)
                    </span>
                </button>
            </h3>
            {open && (
                <div className="border-t border-line p-3">
                    <TimingTables buildId={buildId} />
                </div>
            )}
        </section>
    );
};
