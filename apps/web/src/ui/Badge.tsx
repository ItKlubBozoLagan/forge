import { ReactNode } from "react";

import { cx } from "./cx";

export type Tone = "neutral" | "accent" | "success" | "danger" | "warning";

const tones: Record<Tone, string> = {
    neutral: "bg-surface-2 text-muted border-line",
    accent: "bg-accent-soft text-accent border-transparent",
    success: "bg-success-soft text-success border-transparent",
    danger: "bg-danger-soft text-danger border-transparent",
    warning: "bg-warning-soft text-warning border-transparent",
};

export const Badge = ({
    tone = "neutral",
    children,
    className,
    title,
    ...rest
}: {
    tone?: Tone;
    children: ReactNode;
    className?: string;
    title?: string;
    "data-testid"?: string;
}) => (
    <span
        title={title}
        className={cx(
            "inline-flex items-center gap-1 rounded border px-1.5 h-5 text-xs font-medium whitespace-nowrap",
            tones[tone],
            className,
        )}
        {...rest}
    >
        {children}
    </span>
);

const KNOWN = new Set(["AC", "PA", "WA", "TLE", "MLE", "RE", "CE", "JE"]);

/** A verdict chip: colour plus the verdict's text, never colour alone. */
export const Verdict = ({
    verdict,
    className,
    title,
}: {
    verdict: string;
    className?: string;
    title?: string;
}) => (
    <span
        title={title}
        className={cx(
            "verdict inline-flex items-center justify-center rounded px-1.5 h-5 font-mono text-[11px] font-semibold",
            KNOWN.has(verdict) ? `verdict-${verdict}` : "verdict-CE",
            className,
        )}
    >
        {verdict}
    </span>
);

/** Renders a summary like "TLE, WA" as verdict chips. */
export const VerdictSummary = ({ summary }: { summary: string }) => {
    if (!summary || summary === "-") return <span className="text-subtle">-</span>;
    return (
        <span className="inline-flex flex-wrap gap-1">
            {summary.split(/\s*[,|]\s*/).map((part) => (
                <Verdict key={part} verdict={part} />
            ))}
        </span>
    );
};

/** Build status/result: "green", "red", "queued", "running" or "failed". */
export const BuildBadge = ({
    status,
    result,
    testId,
}: {
    status: string | null | undefined;
    result: string | null | undefined;
    testId?: string;
}) => {
    const label = status === "done" ? (result ?? "done") : (status ?? "none");
    const tone: Tone =
        label === "green"
            ? "success"
            : label === "red" || label === "failed"
              ? "danger"
              : label === "running" || label === "queued"
                ? "accent"
                : "neutral";
    return (
        <Badge tone={tone} data-testid={testId}>
            <span
                aria-hidden
                className={cx(
                    "size-1.5 rounded-full bg-current",
                    (label === "running" || label === "queued") && "animate-pulse",
                )}
            />
            {label}
        </Badge>
    );
};

export const RoleBadge = ({ role }: { role: string }) => (
    <Badge tone={role === "owner" ? "accent" : role === "tester" ? "warning" : "neutral"}>
        {role}
    </Badge>
);
