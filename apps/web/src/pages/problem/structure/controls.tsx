import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { InputHTMLAttributes, KeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "../../../ui/Button";
import { cx } from "../../../ui/cx";
import { Input, Select } from "../../../ui/Field";

/** A manifest edit: takes problem.yaml and returns the new text. */
export type Op = (text: string) => string;

type CommitProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
    value: string;
    onCommit: (value: string) => void;
    /** Returns a message when the value cannot be committed; the field then reverts. */
    check?: (value: string) => string | undefined;
};

/**
 * A text field that commits on blur or Enter (not on every keystroke), so a value is only
 * written to problem.yaml once it is complete. Escape reverts.
 */
export const CommitInput = ({ value, onCommit, check, className, ...rest }: CommitProps) => {
    const [local, setLocal] = useState(value);
    const [problem, setProblem] = useState<string>();
    const focused = useRef(false);
    useEffect(() => {
        if (!focused.current) setLocal(value);
    }, [value]);

    const commit = () => {
        if (local === value) {
            setProblem(undefined);
            return;
        }
        const message = check?.(local);
        if (message) {
            setProblem(message);
            setLocal(value);
            return;
        }
        setProblem(undefined);
        onCommit(local);
    };

    return (
        <Input
            {...rest}
            value={local}
            title={problem ?? rest.title}
            aria-invalid={problem ? true : undefined}
            className={cx(problem && "border-danger", className)}
            onFocus={() => (focused.current = true)}
            onChange={(event) => setLocal(event.target.value)}
            onBlur={() => {
                focused.current = false;
                commit();
            }}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    commit();
                } else if (event.key === "Escape") {
                    setLocal(value);
                    setProblem(undefined);
                }
            }}
        />
    );
};

/** A number field committing on blur or Enter. Empty commits undefined when `optional`. */
export const NumberInput = ({
    value,
    onCommit,
    optional,
    integer,
    min,
    ...rest
}: Omit<CommitProps, "value" | "onCommit" | "check" | "min"> & {
    value: number | undefined;
    onCommit: (value: number | undefined) => void;
    optional?: boolean;
    integer?: boolean;
    min?: number;
}) => (
    <CommitInput
        {...rest}
        inputMode={integer ? "numeric" : "decimal"}
        value={value === undefined ? "" : String(value)}
        check={(text) => {
            if (text.trim() === "") return optional ? undefined : "A value is required";
            const number = Number(text);
            if (!Number.isFinite(number)) return "Enter a number";
            if (integer && !Number.isInteger(number)) return "Enter a whole number";
            if (min !== undefined && number < min) return `At least ${min}`;
            return undefined;
        }}
        onCommit={(text) => onCommit(text.trim() === "" ? undefined : Number(text))}
    />
);

/** Picks a file of the package. A current value that is not in `files` is still shown. */
export const FileSelect = ({
    value,
    files,
    onChange,
    none,
    className,
    ...rest
}: {
    value: string | undefined;
    files: string[];
    onChange: (path: string | undefined) => void;
    /** Label of the empty choice; without it a file must be chosen. */
    none?: string;
    className?: string;
    disabled?: boolean;
    "aria-label"?: string;
    id?: string;
}) => (
    <Select
        {...rest}
        className={cx("font-mono text-[13px]", className)}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
    >
        {(none !== undefined || !value) && <option value="">{none ?? "Choose a file"}</option>}
        {value && !files.includes(value) && <option value={value}>{value} (missing)</option>}
        {files.map((file) => (
            <option key={file} value={file}>
                {file}
            </option>
        ))}
    </Select>
);

/** Move up / move down / remove buttons for a row. */
export const RowActions = ({
    label,
    index,
    count,
    onMove,
    onRemove,
    disabled,
}: {
    label: string;
    index: number;
    count: number;
    onMove?: (to: number) => void;
    onRemove: () => void;
    disabled?: boolean;
}) => (
    <div className="flex justify-end gap-0.5">
        {onMove && (
            <>
                <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${label} up`}
                    title="Move up"
                    disabled={disabled || index === 0}
                    onClick={() => onMove(index - 1)}
                    icon={<ArrowUp className="size-3.5" />}
                />
                <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${label} down`}
                    title="Move down"
                    disabled={disabled || index === count - 1}
                    onClick={() => onMove(index + 1)}
                    icon={<ArrowDown className="size-3.5" />}
                />
            </>
        )}
        <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${label}`}
            title="Remove"
            disabled={disabled}
            onClick={onRemove}
            icon={<Trash2 className="size-3.5" />}
        />
    </div>
);

export const SectionHint = ({ children }: { children: ReactNode }) => (
    <p className="mb-2 text-xs text-muted">{children}</p>
);

export const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
export const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
