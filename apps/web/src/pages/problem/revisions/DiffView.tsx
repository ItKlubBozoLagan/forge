import { Fragment, useMemo } from "react";

import { diffLines, FileChange, toHunks } from "../../../lib/diff";
import { useContent } from "../../../lib/files";
import { cx } from "../../../ui/cx";
import { ErrorNotice, Notice, Spinner } from "../../../ui/misc";

/** A unified line diff of one changed file; removed lines are red with "-", added green with "+". */
export const DiffView = ({ problemId, change }: { problemId: string; change: FileChange }) => {
    const before = useContent(problemId, change.before);
    const after = useContent(problemId, change.after);
    const pending = (change.before && before.isPending) || (change.after && after.isPending);
    const error = before.error ?? after.error;

    const beforeText = before.data?.kind === "text" ? before.data.text : "";
    const afterText = after.data?.kind === "text" ? after.data.text : "";
    const notText =
        (before.data && before.data.kind !== "text") || (after.data && after.data.kind !== "text");
    const lines = useMemo(
        () => (pending || error || notText ? undefined : diffLines(beforeText, afterText)),
        [pending, error, notText, beforeText, afterText],
    );

    if (pending) return <Spinner label="Loading both versions" />;
    if (error) return <ErrorNotice error={error} />;
    if (notText || !lines) return <Notice>Binary or too large to diff.</Notice>;

    const added = lines.filter((line) => line.kind === "add").length;
    const removed = lines.filter((line) => line.kind === "del").length;
    const hunks = toHunks(lines);
    const shown = hunks.reduce((sum, hunk) => sum + hunk.hiddenBefore + hunk.lines.length, 0);
    const hiddenAfter = lines.length - shown;

    return (
        <div className="flex min-w-0 flex-col gap-2" data-testid="line-diff">
            <p className="text-xs text-muted">
                <span className="font-medium text-success">+{added}</span>{" "}
                <span className="font-medium text-danger">-{removed}</span>{" "}
                {added + removed === 0
                    ? "No line changes (only whitespace at line ends or the final newline)."
                    : "lines"}
            </p>
            <div className="overflow-x-auto rounded-lg border border-line bg-surface">
                <table className="w-full border-collapse font-mono text-[12.5px]">
                    <tbody>
                        {hunks.map((hunk, index) => (
                            <Fragment key={index}>
                                {hunk.hiddenBefore > 0 && <Gap count={hunk.hiddenBefore} />}
                                {hunk.lines.map((line, lineIndex) => (
                                    <tr
                                        key={lineIndex}
                                        data-kind={line.kind}
                                        className={cx(
                                            line.kind === "add" && "bg-success-soft",
                                            line.kind === "del" && "bg-danger-soft",
                                        )}
                                    >
                                        <td className="w-0 px-2 text-right text-subtle select-none">
                                            {line.oldLine ?? ""}
                                        </td>
                                        <td className="w-0 px-2 text-right text-subtle select-none">
                                            {line.newLine ?? ""}
                                        </td>
                                        <td
                                            className={cx(
                                                "w-0 px-1 text-center font-semibold select-none",
                                                line.kind === "add" && "text-success",
                                                line.kind === "del" && "text-danger",
                                            )}
                                            aria-label={
                                                line.kind === "add"
                                                    ? "added"
                                                    : line.kind === "del"
                                                      ? "removed"
                                                      : undefined
                                            }
                                        >
                                            {line.kind === "add"
                                                ? "+"
                                                : line.kind === "del"
                                                  ? "-"
                                                  : " "}
                                        </td>
                                        <td className="pr-3 whitespace-pre">{line.text}</td>
                                    </tr>
                                ))}
                            </Fragment>
                        ))}
                        {hiddenAfter > 0 && hunks.length > 0 && <Gap count={hiddenAfter} />}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

const Gap = ({ count }: { count: number }) => (
    <tr className="bg-surface-2 text-muted">
        <td colSpan={4} className="px-2 py-0.5 font-sans text-xs">
            {count} unchanged {count === 1 ? "line" : "lines"}
        </td>
    </tr>
);
