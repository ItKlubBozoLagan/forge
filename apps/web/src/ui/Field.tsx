import {
    InputHTMLAttributes,
    ReactNode,
    SelectHTMLAttributes,
    TextareaHTMLAttributes,
    forwardRef,
    useId,
} from "react";

import { cx } from "./cx";

const control =
    "w-full rounded-md border border-line bg-surface px-2.5 text-sm text-fg placeholder:text-subtle " +
    "hover:border-line-strong focus:border-accent focus:outline-none focus-visible:outline-2 " +
    "focus-visible:outline-offset-0 disabled:opacity-60 disabled:cursor-not-allowed";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
    function Input({ className, ...rest }, ref) {
        return <input ref={ref} className={cx(control, "h-8", className)} {...rest} />;
    },
);

export const Textarea = forwardRef<
    HTMLTextAreaElement,
    TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx(control, "py-1.5 min-h-20", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
    function Select({ className, children, ...rest }, ref) {
        return (
            <select
                ref={ref}
                className={cx(control, "h-8 pr-7 cursor-pointer", className)}
                {...rest}
            >
                {children}
            </select>
        );
    },
);

/**
 * A label tied to its control. The child is a render function receiving the generated id
 * so the `<label for>` association is always right.
 */
export const Field = ({
    label,
    hint,
    error,
    children,
    className,
}: {
    label: ReactNode;
    hint?: ReactNode;
    error?: ReactNode;
    children: (id: string, describedBy: string | undefined) => ReactNode;
    className?: string;
}) => {
    const id = useId();
    const hintId = hint || error ? `${id}-hint` : undefined;
    return (
        <div className={cx("flex flex-col gap-1", className)}>
            <label htmlFor={id} className="text-[13px] font-medium text-fg">
                {label}
            </label>
            {children(id, hintId)}
            {(hint || error) && (
                <p id={hintId} className={cx("text-xs", error ? "text-danger" : "text-muted")}>
                    {error ?? hint}
                </p>
            )}
        </div>
    );
};
