import { Loader2, TriangleAlert } from "lucide-react";
import { HTMLAttributes, ReactNode } from "react";

import { errorMessage } from "../lib/api";
import { cx } from "./cx";

export const Spinner = ({
    label = "Loading",
    className,
}: {
    label?: string;
    className?: string;
}) => (
    <span
        role="status"
        className={cx("inline-flex items-center gap-2 text-sm text-muted", className)}
    >
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {label}
    </span>
);

export const Loading = ({ label }: { label?: string }) => (
    <div className="flex justify-center py-10">
        <Spinner label={label} />
    </div>
);

export const Card = ({
    title,
    actions,
    children,
    className,
    ...rest
}: { title?: ReactNode; actions?: ReactNode } & HTMLAttributes<HTMLElement>) => (
    <section className={cx("rounded-lg border border-line bg-surface", className)} {...rest}>
        {(title || actions) && (
            <header className="flex items-center gap-2 border-b border-line px-3 py-2">
                {title && <h3 className="flex-1 text-[13px] font-semibold">{title}</h3>}
                {actions}
            </header>
        )}
        <div className="p-3">{children}</div>
    </section>
);

export const EmptyState = ({
    title,
    children,
    action,
    icon,
}: {
    title: string;
    children?: ReactNode;
    action?: ReactNode;
    icon?: ReactNode;
}) => (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
        {icon && <div className="text-subtle">{icon}</div>}
        <p className="font-medium">{title}</p>
        {children && <div className="max-w-md text-sm text-muted">{children}</div>}
        {action && <div className="mt-2">{action}</div>}
    </div>
);

export const ErrorNotice = ({ error, className }: { error: unknown; className?: string }) => (
    <div
        role="alert"
        className={cx(
            "flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger",
            className,
        )}
    >
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="break-words">{errorMessage(error)}</span>
    </div>
);

export const Notice = ({
    tone = "info",
    children,
    className,
}: {
    tone?: "info" | "warning" | "success";
    children: ReactNode;
    className?: string;
}) => (
    <div
        className={cx(
            "rounded-md border px-3 py-2 text-sm",
            tone === "warning" && "border-warning/40 bg-warning-soft text-warning",
            tone === "info" && "border-line bg-surface-2 text-muted",
            tone === "success" && "border-success/40 bg-success-soft text-success",
            className,
        )}
    >
        {children}
    </div>
);

export const PageTitle = ({
    children,
    actions,
    subtitle,
}: {
    children: ReactNode;
    actions?: ReactNode;
    subtitle?: ReactNode;
}) => (
    <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">{children}</h1>
            {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
);

export const Mono = ({
    children,
    className,
    title,
}: {
    children: ReactNode;
    className?: string;
    title?: string;
}) => (
    <span title={title} className={cx("font-mono text-[12.5px]", className)}>
        {children}
    </span>
);

export const Progress = ({
    done,
    total,
    label,
}: {
    done: number;
    total: number;
    label: string;
}) => {
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return (
        <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={total || 100}
            aria-valuenow={total ? done : undefined}
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
        >
            <div
                className={cx(
                    "h-full rounded-full bg-accent transition-[width]",
                    total === 0 && "w-1/3 animate-pulse",
                )}
                style={total ? { width: `${percent}%` } : undefined}
            />
        </div>
    );
};
