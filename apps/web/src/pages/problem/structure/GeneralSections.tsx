import {
    BUILTIN_CHECKERS,
    BuiltinChecker,
    ManifestDraft,
    removeConstraint,
    removeGenerator,
    renameConstraint,
    renameGenerator,
    RUNNABLE_TASK_TYPES,
    setChecker,
    setConstraint,
    setGenerator,
    setLimits,
    setScoringMode,
    setTitle,
    setType,
    setValidator,
    TASK_TYPES,
} from "@forge/core";
import { Plus } from "lucide-react";
import { FormEvent, ReactNode, useState } from "react";

import { Button } from "../../../ui/Button";
import { Field, Input, Select } from "../../../ui/Field";
import { Card } from "../../../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../../../ui/Table";
import {
    CommitInput,
    FileSelect,
    IDENTIFIER,
    NumberInput,
    Op,
    RowActions,
    SectionHint,
} from "./controls";

export type SectionProps = {
    draft: ManifestDraft;
    apply: (op: Op) => void;
    readOnly: boolean;
    /** Every file of the working copy. */
    paths: string[];
    /** Files in a language Forge can run. */
    programs: string[];
};

const BUILTIN_LABELS: Record<BuiltinChecker, string> = {
    tokens: "Built-in: compare tokens",
    lines: "Built-in: compare lines",
    float: "Built-in: numbers with tolerance",
    yesno: "Built-in: yes / no",
};

/** The checker as a select value: "" (default), "builtin:<kind>", "file:<path>" or "custom". */
const checkerChoice = (checker: unknown): string => {
    if (checker === undefined || checker === null) return "";
    if (typeof checker === "string") return `file:${checker}`;
    if (
        typeof checker === "object" &&
        BUILTIN_CHECKERS.includes((checker as { builtin?: BuiltinChecker }).builtin!)
    )
        return `builtin:${(checker as { builtin: string }).builtin}`;
    return "custom";
};

export const GeneralSection = ({ draft, apply, readOnly, programs }: SectionProps) => {
    const type = draft.type ?? "batch";
    const interactive = type === "interactive";
    const choice = checkerChoice(draft.checker);
    const eps =
        typeof draft.checker === "object" && draft.checker !== null
            ? (draft.checker as { eps?: number }).eps
            : undefined;

    return (
        <Card title="General" data-testid="structure-general">
            <div className="grid gap-3 sm:grid-cols-2">
                {typeof draft.title === "object" ? (
                    <Field label="Title" hint="The title has several languages; edit it in problem.yaml.">
                        {(id) => (
                            <Input id={id} value={Object.values(draft.title as object).join(" / ")} disabled />
                        )}
                    </Field>
                ) : (
                    <Field label="Title">
                        {(id) => (
                            <CommitInput
                                id={id}
                                value={typeof draft.title === "string" ? draft.title : ""}
                                disabled={readOnly}
                                onCommit={(value) => apply((text) => setTitle(text, value))}
                            />
                        )}
                    </Field>
                )}
                <Field label="Task type">
                    {(id) => (
                        <Select
                            id={id}
                            value={type}
                            disabled={readOnly}
                            onChange={(event) => {
                                const value = event.target.value;
                                apply((text) => setType(text, value));
                            }}
                        >
                            {TASK_TYPES.map((item) => {
                                const runnable = RUNNABLE_TASK_TYPES.includes(item);
                                return (
                                    <option key={item} value={item} disabled={!runnable}>
                                        {runnable ? item : `${item} (not buildable yet)`}
                                    </option>
                                );
                            })}
                        </Select>
                    )}
                </Field>
                <Field label="Time limit (ms)">
                    {(id) => (
                        <NumberInput
                            id={id}
                            integer
                            min={1}
                            value={draft.limits.time_ms}
                            disabled={readOnly}
                            onCommit={(value) => apply((text) => setLimits(text, { time_ms: value }))}
                        />
                    )}
                </Field>
                <Field label="Memory limit (MB)">
                    {(id) => (
                        <NumberInput
                            id={id}
                            integer
                            min={1}
                            value={draft.limits.memory_mb}
                            disabled={readOnly}
                            onCommit={(value) =>
                                apply((text) => setLimits(text, { memory_mb: value }))
                            }
                        />
                    )}
                </Field>
                <Field label="Scoring">
                    {(id) => (
                        <Select
                            id={id}
                            value={draft.scoring.mode ?? "sum"}
                            disabled={readOnly}
                            onChange={(event) => {
                                const mode = event.target.value as "sum" | "binary";
                                apply((text) => setScoringMode(text, mode));
                            }}
                        >
                            <option value="sum">Sum of group points</option>
                            <option value="binary">Binary (all tests or nothing)</option>
                        </Select>
                    )}
                </Field>
                <Field label="Validator">
                    {(id) => (
                        <FileSelect
                            id={id}
                            value={draft.validator}
                            files={programs}
                            none="None"
                            disabled={readOnly}
                            onChange={(path) => apply((text) => setValidator(text, path))}
                        />
                    )}
                </Field>
                <Field label={interactive ? "Interactor" : "Checker"}>
                    {(id) => (
                        <Select
                            id={id}
                            className="font-mono text-[13px]"
                            value={choice}
                            disabled={readOnly}
                            onChange={(event) => {
                                const value = event.target.value;
                                if (value === "custom") return;
                                apply((text) =>
                                    setChecker(
                                        text,
                                        value === ""
                                            ? undefined
                                            : value.startsWith("builtin:")
                                              ? {
                                                    builtin: value.slice(8) as BuiltinChecker,
                                                    ...(value === "builtin:float"
                                                        ? { eps: eps ?? 1e-6 }
                                                        : {}),
                                                }
                                              : value.slice(5),
                                    ),
                                );
                            }}
                        >
                            <option value="">
                                {interactive ? "None" : "Compare tokens (default)"}
                            </option>
                            {!interactive &&
                                BUILTIN_CHECKERS.filter(
                                    (kind) => kind !== "tokens" || choice === "builtin:tokens",
                                ).map((kind) => (
                                    <option key={kind} value={`builtin:${kind}`}>
                                        {BUILTIN_LABELS[kind]}
                                    </option>
                                ))}
                            {choice === "custom" && (
                                <option value="custom">Custom (kept as written)</option>
                            )}
                            {choice.startsWith("file:") &&
                                !programs.includes(choice.slice(5)) && (
                                    <option value={choice}>{choice.slice(5)} (missing)</option>
                                )}
                            {programs.map((path) => (
                                <option key={path} value={`file:${path}`}>
                                    {path}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
                {choice === "builtin:float" && (
                    <Field label="Tolerance (absolute or relative)">
                        {(id) => (
                            <NumberInput
                                id={id}
                                value={eps}
                                optional
                                disabled={readOnly}
                                onCommit={(value) =>
                                    apply((text) => setChecker(text, { builtin: "float", eps: value }))
                                }
                            />
                        )}
                    </Field>
                )}
            </div>
        </Card>
    );
};

export const AddRow = ({
    onSubmit,
    children,
    disabled,
    label,
}: {
    onSubmit: () => void;
    children: ReactNode;
    disabled: boolean;
    label: string;
}) => (
    <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onSubmit();
        }}
    >
        {children}
        <Button type="submit" size="md" icon={<Plus className="size-4" />} disabled={disabled}>
            {label}
        </Button>
    </form>
);

/** Rows of name, min and max; shared by the global constraints and a group's overrides. */
export const ConstraintTable = ({
    bounds,
    apply,
    readOnly,
    group,
    names,
}: {
    bounds: Record<string, { min?: number; max?: number }>;
    apply: (op: Op) => void;
    readOnly: boolean;
    /** Set for a group's overrides. */
    group?: string;
    /** Constraints that can be added (a group overrides the global ones). */
    names?: string[];
}) => {
    const [name, setName] = useState("");
    const entries = Object.entries(bounds);
    const where = group ? ` in ${group}` : "";
    const invalid =
        name && !IDENTIFIER.test(name)
            ? "Letters, digits and _, starting with a letter"
            : name in bounds
              ? "Already listed"
              : undefined;
    return (
        <div>
            {entries.length > 0 && (
                <TableWrap>
                    <Table>
                        <thead>
                            <tr>
                                <Th>Name</Th>
                                <Th>Min</Th>
                                <Th>Max</Th>
                                <Th className="w-0">
                                    <span className="sr-only">Actions</span>
                                </Th>
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map(([key, bound], index) => (
                                <Tr key={key}>
                                    <Td className="min-w-24">
                                        {group ? (
                                            <span className="font-mono">{key}</span>
                                        ) : (
                                            <CommitInput
                                                aria-label={`Name of constraint ${key}`}
                                                className="font-mono"
                                                value={key}
                                                disabled={readOnly}
                                                check={(value) =>
                                                    !IDENTIFIER.test(value)
                                                        ? "Letters, digits and _, starting with a letter"
                                                        : value in bounds
                                                          ? "Already listed"
                                                          : undefined
                                                }
                                                onCommit={(value) =>
                                                    apply((text) => renameConstraint(text, key, value))
                                                }
                                            />
                                        )}
                                    </Td>
                                    <Td className="min-w-28">
                                        <NumberInput
                                            aria-label={`Minimum of ${key}${where}`}
                                            value={bound.min}
                                            optional
                                            disabled={readOnly}
                                            onCommit={(value) =>
                                                apply((text) =>
                                                    setConstraint(
                                                        text,
                                                        key,
                                                        { min: value, max: bound.max },
                                                        group,
                                                    ),
                                                )
                                            }
                                        />
                                    </Td>
                                    <Td className="min-w-28">
                                        <NumberInput
                                            aria-label={`Maximum of ${key}${where}`}
                                            value={bound.max}
                                            optional
                                            disabled={readOnly}
                                            onCommit={(value) =>
                                                apply((text) =>
                                                    setConstraint(
                                                        text,
                                                        key,
                                                        { min: bound.min, max: value },
                                                        group,
                                                    ),
                                                )
                                            }
                                        />
                                    </Td>
                                    <Td>
                                        <RowActions
                                            label={`constraint ${key}${where}`}
                                            index={index}
                                            count={entries.length}
                                            disabled={readOnly}
                                            onRemove={() =>
                                                apply((text) => removeConstraint(text, key, group))
                                            }
                                        />
                                    </Td>
                                </Tr>
                            ))}
                        </tbody>
                    </Table>
                </TableWrap>
            )}
            {!readOnly && (
                <AddRow
                    label={group ? "Override" : "Add constraint"}
                    disabled={!name || !!invalid}
                    onSubmit={() => {
                        if (!name || invalid) return;
                        const added = name;
                        apply((text) => setConstraint(text, added, {}, group));
                        setName("");
                    }}
                >
                    {names ? (
                        <Field label="Constraint to override" className="w-48">
                            {(id) => (
                                <Select
                                    id={id}
                                    className="font-mono"
                                    value={name}
                                    onChange={(event) => setName(event.target.value)}
                                >
                                    <option value="">Choose</option>
                                    {names
                                        .filter((item) => !(item in bounds))
                                        .map((item) => (
                                            <option key={item} value={item}>
                                                {item}
                                            </option>
                                        ))}
                                </Select>
                            )}
                        </Field>
                    ) : (
                        <Field label="New constraint" error={invalid} className="w-40">
                            {(id, describedBy) => (
                                <Input
                                    id={id}
                                    className="font-mono"
                                    placeholder="N"
                                    value={name}
                                    aria-describedby={describedBy}
                                    onChange={(event) => setName(event.target.value.trim())}
                                />
                            )}
                        </Field>
                    )}
                </AddRow>
            )}
        </div>
    );
};

export const ConstraintsSection = ({ draft, apply, readOnly }: SectionProps) => (
    <Card title="Constraints" data-testid="structure-constraints">
        <SectionHint>
            Injected as N_MIN, N_MAX... into the validator, generators and checker, and readable in
            the statement as {"{{N.max}}"}. Groups can override them below.
        </SectionHint>
        <ConstraintTable bounds={draft.constraints} apply={apply} readOnly={readOnly} />
    </Card>
);

export const GeneratorsSection = ({ draft, apply, readOnly, programs }: SectionProps) => {
    const [name, setName] = useState("");
    const [file, setFile] = useState<string>();
    const entries = Object.entries(draft.generators);
    const invalid =
        name && !IDENTIFIER.test(name)
            ? "Letters, digits and _, starting with a letter"
            : name in draft.generators
              ? "Already listed"
              : undefined;
    return (
        <Card title="Generators" data-testid="structure-generators">
            {entries.length === 0 && <SectionHint>No generators yet.</SectionHint>}
            {entries.length > 0 && (
                <TableWrap>
                    <Table>
                        <thead>
                            <tr>
                                <Th>Name</Th>
                                <Th>File</Th>
                                <Th className="w-0">
                                    <span className="sr-only">Actions</span>
                                </Th>
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map(([key, path], index) => (
                                <Tr key={key}>
                                    <Td className="min-w-28">
                                        <CommitInput
                                            aria-label={`Name of generator ${key}`}
                                            className="font-mono"
                                            value={key}
                                            disabled={readOnly}
                                            check={(value) =>
                                                !IDENTIFIER.test(value)
                                                    ? "Letters, digits and _, starting with a letter"
                                                    : value in draft.generators
                                                      ? "Already listed"
                                                      : undefined
                                            }
                                            onCommit={(value) =>
                                                apply((text) => renameGenerator(text, key, value))
                                            }
                                        />
                                    </Td>
                                    <Td className="min-w-48">
                                        <FileSelect
                                            aria-label={`File of generator ${key}`}
                                            value={path}
                                            files={programs}
                                            disabled={readOnly}
                                            onChange={(value) =>
                                                value && apply((text) => setGenerator(text, key, value))
                                            }
                                        />
                                    </Td>
                                    <Td>
                                        <RowActions
                                            label={`generator ${key}`}
                                            index={index}
                                            count={entries.length}
                                            disabled={readOnly}
                                            onRemove={() =>
                                                apply((text) => removeGenerator(text, key))
                                            }
                                        />
                                    </Td>
                                </Tr>
                            ))}
                        </tbody>
                    </Table>
                </TableWrap>
            )}
            {!readOnly && (
                <AddRow
                    label="Add generator"
                    disabled={!name || !file || !!invalid}
                    onSubmit={() => {
                        if (!name || !file || invalid) return;
                        const added = name;
                        const path = file;
                        apply((text) => setGenerator(text, added, path));
                        setName("");
                        setFile(undefined);
                    }}
                >
                    <Field label="New generator" error={invalid} className="w-36">
                        {(id, describedBy) => (
                            <Input
                                id={id}
                                className="font-mono"
                                placeholder="rand"
                                value={name}
                                aria-describedby={describedBy}
                                onChange={(event) => setName(event.target.value.trim())}
                            />
                        )}
                    </Field>
                    <Field label="Generator file" className="min-w-48 flex-1">
                        {(id) => (
                            <FileSelect id={id} value={file} files={programs} onChange={setFile} />
                        )}
                    </Field>
                </AddRow>
            )}
        </Card>
    );
};
