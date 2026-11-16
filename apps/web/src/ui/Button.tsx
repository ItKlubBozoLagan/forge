import { Loader2 } from "lucide-react";
import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";
import { Link, LinkProps } from "react-router";

import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap " +
    "transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none";

const variants: Record<ButtonVariant, string> = {
    primary: "bg-accent text-accent-fg hover:bg-accent-hover border border-transparent",
    secondary: "bg-surface text-fg border border-line hover:bg-surface-2 hover:border-line-strong",
    ghost: "text-muted hover:text-fg hover:bg-surface-2 border border-transparent",
    danger: "bg-surface text-danger border border-line hover:bg-danger-soft hover:border-danger",
};

const sizes: Record<ButtonSize, string> = {
    sm: "h-7 px-2 text-[13px]",
    md: "h-8 px-3 text-sm",
};

export const buttonClass = (variant: ButtonVariant = "secondary", size: ButtonSize = "md") =>
    cx(base, variants[variant], sizes[size]);

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    pending?: boolean;
    icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
    {
        variant = "secondary",
        size = "md",
        pending,
        icon,
        className,
        children,
        disabled,
        type,
        ...rest
    },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type ?? "button"}
            className={cx(buttonClass(variant, size), className)}
            disabled={disabled || pending}
            aria-busy={pending || undefined}
            {...rest}
        >
            {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
            {children}
        </button>
    );
});

export const ButtonLink = ({
    variant = "secondary",
    size = "md",
    className,
    icon,
    children,
    ...rest
}: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) => (
    <Link className={cx(buttonClass(variant, size), className)} {...rest}>
        {icon}
        {children}
    </Link>
);
