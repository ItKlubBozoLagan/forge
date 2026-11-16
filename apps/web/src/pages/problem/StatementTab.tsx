import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useSearchParams } from "react-router";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { api, q } from "../../lib/api";
import { keys } from "../../lib/queries";
import type { Statement } from "../../lib/types";
import { Badge } from "../../ui/Badge";
import { EmptyState, ErrorNotice, Loading, Notice } from "../../ui/misc";
import { Tabs } from "../../ui/Tabs";
import { useProblemContext } from "./ProblemLayout";

export const StatementTab = () => {
    const { problem } = useProblemContext();
    const [params, setParams] = useSearchParams();
    const lang = params.get("lang") ?? undefined;
    const statement = useQuery({
        queryKey: keys.statement(problem.id, lang),
        queryFn: () => api.get<Statement>(`/problems/${problem.id}/statement${q({ lang })}`),
        placeholderData: (previous) => previous,
    });

    if (statement.isPending) return <Loading />;
    if (statement.error) return <ErrorNotice error={statement.error} />;
    const data = statement.data;
    if (!data.language)
        return (
            <EmptyState icon={<FileText className="size-6" />} title="No statement">
                {problem.role === "tester"
                    ? "The problem has no committed statement yet."
                    : "Add a statement as statement/en.md (one Markdown file per language) in the Files tab."}
            </EmptyState>
        );

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
                {data.languages.length > 1 ? (
                    <Tabs
                        label="Statement language"
                        value={data.language}
                        onChange={(value) => setParams({ lang: value }, { replace: true })}
                        tabs={data.languages.map((language) => ({
                            value: language,
                            label: language,
                        }))}
                    />
                ) : (
                    <Badge>language: {data.language}</Badge>
                )}
                {data.limits && (
                    <span className="ml-auto text-xs text-muted">
                        time limit <span className="font-mono">{data.limits.time_ms} ms</span> ·
                        memory limit <span className="font-mono">{data.limits.memory_mb} MB</span>
                    </span>
                )}
            </div>
            {!data.samplesBuilt && (
                <Notice>Build the problem to fill in the sample outputs.</Notice>
            )}
            {data.unresolved.length > 0 && (
                <Notice tone="warning">
                    These placeholders could not be resolved:{" "}
                    {data.unresolved.map((placeholder, index) => (
                        <span key={placeholder}>
                            {index > 0 && ", "}
                            <code className="font-mono">{`{{${placeholder}}}`}</code>
                        </span>
                    ))}
                    . Check the constraint names in problem.yaml.
                </Notice>
            )}
            {data.groups && data.groups.some((group) => group.points > 0) && (
                <div className="flex flex-wrap gap-1.5 text-xs text-muted">
                    Scoring:
                    {data.groups
                        .filter((group) => !group.sample)
                        .map((group) => (
                            <Badge key={group.name}>
                                {group.name}: {group.points} pts
                            </Badge>
                        ))}
                </div>
            )}
            <article className="markdown rounded-lg border border-line bg-surface px-6 py-5">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                >
                    {data.markdown}
                </ReactMarkdown>
            </article>
        </div>
    );
};
