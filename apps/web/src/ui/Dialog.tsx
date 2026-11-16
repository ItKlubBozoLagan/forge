import { X } from "lucide-react";
import { ReactNode, useEffect, useId, useRef, useState } from "react";

import { errorMessage } from "../lib/api";
import { Button } from "./Button";
import { cx } from "./cx";

type Props = {
    open: boolean;
    onClose: () => void;
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
    footer?: ReactNode;
    /** "drawer" slides in from the right and takes the full height. */
    variant?: "center" | "drawer";
    width?: string;
};

/** Modal dialog built on the native <dialog> element (focus trap, Escape, top layer). */
export const Dialog = ({
    open,
    onClose,
    title,
    description,
    children,
    footer,
    variant = "center",
    width,
}: Props) => {
    const ref = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const descriptionId = useId();
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        if (open && !dialog.open) dialog.showModal();
        else if (!open && dialog.open) dialog.close();
    }, [open]);

    const drawer = variant === "drawer";
    return (
        <dialog
            ref={ref}
            role="dialog"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            onCancel={(event) => {
                event.preventDefault();
                onCloseRef.current();
            }}
            onMouseDown={(event) => {
                if (event.target === ref.current) onCloseRef.current();
            }}
            className={cx(
                "bg-transparent p-0 m-0 max-w-none max-h-none overflow-visible",
                drawer ? "ml-auto h-dvh" : "mx-auto my-[8vh]",
            )}
        >
            {open && (
                <div
                    className={cx(
                        "flex flex-col bg-surface border border-line shadow-[var(--shadow)]",
                        drawer
                            ? "h-dvh w-[min(760px,100vw)] border-y-0 border-r-0"
                            : "rounded-lg max-h-[84vh]",
                    )}
                    style={
                        drawer ? undefined : { width: width ?? "min(480px, calc(100vw - 32px))" }
                    }
                >
                    <div className="flex items-start gap-3 border-b border-line px-4 py-3">
                        <div className="min-w-0 flex-1">
                            <h2 id={titleId} className="text-[15px] font-semibold break-words">
                                {title}
                            </h2>
                            {description && (
                                <p id={descriptionId} className="mt-0.5 text-[13px] text-muted">
                                    {description}
                                </p>
                            )}
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            aria-label="Close"
                            onClick={() => onCloseRef.current()}
                            icon={<X className="size-4" />}
                        />
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
                    {footer && (
                        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
                            {footer}
                        </div>
                    )}
                </div>
            )}
        </dialog>
    );
};

/** Asks for confirmation; the confirm button shows a pending state and errors stay inline. */
export const ConfirmDialog = ({
    open,
    onClose,
    title,
    message,
    confirmLabel,
    danger,
    onConfirm,
}: {
    open: boolean;
    onClose: () => void;
    title: string;
    message: ReactNode;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => Promise<unknown> | void;
}) => {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string>();
    useEffect(() => {
        if (open) setError(undefined);
    }, [open]);
    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={title}
            footer={
                <>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button
                        variant={danger ? "danger" : "primary"}
                        pending={pending}
                        onClick={async () => {
                            setPending(true);
                            setError(undefined);
                            try {
                                await onConfirm();
                                onClose();
                            } catch (caught) {
                                setError(errorMessage(caught));
                            } finally {
                                setPending(false);
                            }
                        }}
                    >
                        {confirmLabel}
                    </Button>
                </>
            }
        >
            <div className="text-sm">{message}</div>
            {error && (
                <p role="alert" className="mt-3 text-sm text-danger">
                    {error}
                </p>
            )}
        </Dialog>
    );
};
