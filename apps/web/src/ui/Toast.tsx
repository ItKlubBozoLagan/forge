import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from "react";

import { errorMessage } from "../lib/api";
import { cx } from "./cx";

type ToastKind = "success" | "error" | "info";
type ToastItem = {
    id: number;
    kind: ToastKind;
    message: ReactNode;
    action?: { label: string; onClick: () => void };
};

type ToastApi = {
    show: (toast: Omit<ToastItem, "id">) => void;
    success: (message: ReactNode, action?: ToastItem["action"]) => void;
    error: (error: unknown) => void;
    info: (message: ReactNode) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export const useToast = () => {
    const context = useContext(ToastContext);
    if (!context) throw new Error("useToast outside ToastProvider");
    return context;
};

let nextId = 1;

export const ToastProvider = ({ children }: { children: ReactNode }) => {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const dismiss = useCallback(
        (id: number) => setToasts((all) => all.filter((toast) => toast.id !== id)),
        [],
    );
    const show = useCallback(
        (toast: Omit<ToastItem, "id">) => {
            const id = nextId++;
            setToasts((all) => [...all.slice(-3), { ...toast, id }]);
            window.setTimeout(() => dismiss(id), toast.kind === "error" ? 8000 : 5000);
        },
        [dismiss],
    );
    const api = useMemo<ToastApi>(
        () => ({
            show,
            success: (message, action) => show({ kind: "success", message, action }),
            error: (error) =>
                show({
                    kind: "error",
                    message: typeof error === "string" ? error : errorMessage(error),
                }),
            info: (message) => show({ kind: "info", message }),
        }),
        [show],
    );
    return (
        <ToastContext.Provider value={api}>
            {children}
            <div
                aria-live="polite"
                className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2"
            >
                {toasts.map((toast) => (
                    <div
                        key={toast.id}
                        role={toast.kind === "error" ? "alert" : "status"}
                        className={cx(
                            "pointer-events-auto flex items-start gap-2 rounded-lg border bg-surface px-3 py-2.5 text-sm shadow-[var(--shadow)]",
                            toast.kind === "error" ? "border-danger/50" : "border-line",
                        )}
                    >
                        {toast.kind === "success" && (
                            <CheckCircle2
                                className="mt-0.5 size-4 shrink-0 text-success"
                                aria-hidden
                            />
                        )}
                        {toast.kind === "error" && (
                            <TriangleAlert
                                className="mt-0.5 size-4 shrink-0 text-danger"
                                aria-hidden
                            />
                        )}
                        {toast.kind === "info" && (
                            <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                        )}
                        <div className="min-w-0 flex-1 break-words">{toast.message}</div>
                        {toast.action && (
                            <button
                                type="button"
                                className="shrink-0 font-medium text-accent hover:underline"
                                onClick={() => {
                                    toast.action!.onClick();
                                    dismiss(toast.id);
                                }}
                            >
                                {toast.action.label}
                            </button>
                        )}
                        <button
                            type="button"
                            aria-label="Dismiss"
                            className="shrink-0 text-subtle hover:text-fg"
                            onClick={() => dismiss(toast.id)}
                        >
                            <X className="size-4" />
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
};
