import {
    addSolution,
    DraftSolution,
    EXPECTABLE,
    removeSolution,
    setExpectation,
    setMainSolution,
    updateSolution,
} from "@forge/core";
import { useState } from "react";

import { Badge } from "../../../ui/Badge";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { Field, Select } from "../../../ui/Field";
import { Card, Mono } from "../../../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../../../ui/Table";
import { FileSelect, Op, RowActions, SectionHint } from "./controls";
import { AddRow, SectionProps } from "./GeneralSections";

const FAILURES = EXPECTABLE.filter((value) => value !== "AC");
/** Choices offered directly; anything else is built in the combination dialog. */
const COMMON = ["AC", ...FAILURES, "WA|TLE", "TLE|RE", "TLE|MLE", "WA|RE"];
const OTHER = "__other";

/** What a solution expects on a group: a value, or undefined for no expectation. */
const cellValue = (solution: DraftSolution, group: string): string | undefined => {
    if (solution.role === "main") return "AC";
    if (solution.expect === undefined) return "AC";
    if (typeof solution.expect === "string") return solution.expect;
    return solution.expect[group];
};

const ExpectationSelect = ({
    value,
    label,
    disabled,
    allowNone,
    noneLabel = "-",
    onChange,
    onOther,
}: {
    value: string | undefined;
    label: string;
    disabled: boolean;
    allowNone: boolean;
    noneLabel?: string;
    onChange: (value: string | undefined) => void;
    onOther: () => void;
}) => (
    <Select
        aria-label={label}
        className="w-auto min-w-20 font-mono text-[12.5px]"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => {
            const next = event.target.value;
            if (next === OTHER) onOther();
            else onChange(next || undefined);
        }}
    >
        {allowNone && <option value="">{noneLabel}</option>}
        {value !== undefined && !COMMON.includes(value) && <option value={value}>{value}</option>}
        {COMMON.map((item) => (
            <option key={item} value={item}>
                {item}
            </option>
        ))}
        <option value={OTHER}>Other...</option>
    </Select>
);

/** Builds a combination like WA|TLE|RE from checkboxes. */
const CombinationDialog = ({
    target,
    onClose,
    onPick,
}: {
    target?: { label: string; value?: string };
    onClose: () => void;
    onPick: (value: string) => void;
}) => {
    const [picked, setPicked] = useState<string[]>([]);
    const [shown, setShown] = useState<typeof target>();
    if (target !== shown) {
        setShown(target);
        setPicked(
            target?.value && target.value !== "AC"
                ? target.value.split("|").map((part) => part.trim())
                : [],
        );
    }
    return (
        <Dialog
            open={!!target}
            onClose={onClose}
            title="Expected failures"
            description={target?.label}
            footer={
                <>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button
                        variant="primary"
                        disabled={picked.length === 0}
                        onClick={() => onPick(FAILURES.filter((v) => picked.includes(v)).join("|"))}
                    >
                        Use {FAILURES.filter((v) => picked.includes(v)).join("|") || "..."}
                    </Button>
                </>
            }
        >
            <p className="mb-2 text-sm text-muted">
                At least one test fails, and every failing test fails in one of these ways.
            </p>
            <div className="flex flex-wrap gap-3">
                {FAILURES.map((value) => (
                    <label key={value} className="flex items-center gap-1.5 font-mono text-sm">
                        <input
                            type="checkbox"
                            checked={picked.includes(value)}
                            onChange={(event) =>
                                setPicked((current) =>
                                    event.target.checked
                                        ? [...current, value]
                                        : current.filter((item) => item !== value),
                                )
                            }
                        />
                        {value}
                    </label>
                ))}
            </div>
        </Dialog>
    );
};

export const SolutionsSection = ({ draft, apply, readOnly, paths, programs }: SectionProps) => {
    const [adding, setAdding] = useState<string>();
    const [other, setOther] = useState<{
        label: string;
        value?: string;
        apply: (value: string) => Op;
    }>();
    const groups = draft.groups.map((group) => group.name);
    const listed = new Set(draft.solutions.map((solution) => solution.path.replace(/\/+$/, "")));
    const used = new Set(
        [
            draft.validator,
            typeof draft.checker === "string" ? draft.checker : undefined,
            ...Object.values(draft.generators),
        ].filter(Boolean),
    );
    const folders = [
        ...new Set(
            paths.flatMap((path) => {
                const parts = path.split("/");
                return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
            }),
        ),
    ].sort();
    const candidates = [
        ...programs.filter((path) => !listed.has(path) && !used.has(path)),
        ...(draft.type === "output-only"
            ? folders.filter((folder) => !listed.has(folder)).map((folder) => `${folder}/`)
            : []),
    ];
    const hasMain = draft.solutions.some((solution) => solution.role === "main");

    return (
        <Card title="Solutions and expectations" data-testid="structure-solutions">
            <SectionHint>
                What each solution should do on each group. AC: every test passes. WA, TLE, MLE, RE,
                PA: at least one test fails and every failing test fails that way. FAIL: fails in
                any way. - : no expectation. The main solution produces the answers and is always AC.
            </SectionHint>
            {draft.solutions.length === 0 ? (
                <p className="text-sm text-muted">No solutions yet.</p>
            ) : (
                <TableWrap>
                    <Table data-testid="expectations">
                        <thead>
                            <tr>
                                <Th>Solution</Th>
                                <Th>Main</Th>
                                <Th>All groups</Th>
                                {groups.map((group) => (
                                    <Th key={group} className="font-mono">
                                        {group}
                                    </Th>
                                ))}
                                <Th className="w-0">
                                    <span className="sr-only">Actions</span>
                                </Th>
                            </tr>
                        </thead>
                        <tbody>
                            {draft.solutions.map((solution, index) => {
                                const main = solution.role === "main";
                                const path = solution.path;
                                const all =
                                    typeof solution.expect === "object"
                                        ? undefined
                                        : (solution.expect ?? "AC");
                                return (
                                    <Tr key={`${index}-${path}`} data-testid={`solution-${path}`}>
                                        <Td className="max-w-64">
                                            <Mono className="break-all">{path}</Mono>
                                        </Td>
                                        <Td>
                                            <input
                                                type="radio"
                                                name="main-solution"
                                                aria-label={`${path} is the main solution`}
                                                checked={main}
                                                disabled={readOnly}
                                                onChange={() =>
                                                    apply((text) => setMainSolution(text, path))
                                                }
                                            />
                                        </Td>
                                        <Td>
                                            {main ? (
                                                <Badge tone="accent">main</Badge>
                                            ) : (
                                                <ExpectationSelect
                                                    label={`Expected result of ${path} on all groups`}
                                                    value={all}
                                                    allowNone={all === undefined}
                                                    noneLabel="per group"
                                                    disabled={readOnly}
                                                    onChange={(value) =>
                                                        value &&
                                                        apply((text) =>
                                                            updateSolution(text, path, {
                                                                expect: value,
                                                            }),
                                                        )
                                                    }
                                                    onOther={() =>
                                                        setOther({
                                                            label: `${path} on all groups`,
                                                            value: all,
                                                            apply: (value) => (text) =>
                                                                updateSolution(text, path, {
                                                                    expect: value,
                                                                }),
                                                        })
                                                    }
                                                />
                                            )}
                                        </Td>
                                        {groups.map((group) => (
                                            <Td key={group}>
                                                <ExpectationSelect
                                                    label={`Expected result of ${path} on ${group}`}
                                                    value={cellValue(solution, group)}
                                                    allowNone
                                                    disabled={readOnly || main}
                                                    onChange={(value) =>
                                                        apply((text) =>
                                                            setExpectation(text, path, group, value),
                                                        )
                                                    }
                                                    onOther={() =>
                                                        setOther({
                                                            label: `${path} on ${group}`,
                                                            value: cellValue(solution, group),
                                                            apply: (value) => (text) =>
                                                                setExpectation(
                                                                    text,
                                                                    path,
                                                                    group,
                                                                    value,
                                                                ),
                                                        })
                                                    }
                                                />
                                            </Td>
                                        ))}
                                        <Td>
                                            <RowActions
                                                label={`solution ${path}`}
                                                index={index}
                                                count={draft.solutions.length}
                                                disabled={readOnly}
                                                onRemove={() =>
                                                    apply((text) => removeSolution(text, path))
                                                }
                                            />
                                        </Td>
                                    </Tr>
                                );
                            })}
                        </tbody>
                    </Table>
                </TableWrap>
            )}
            {!readOnly && (
                <AddRow
                    label="Add solution"
                    disabled={!adding}
                    onSubmit={() => {
                        if (!adding) return;
                        const path = adding;
                        apply((text) =>
                            addSolution(text, { path, role: hasMain ? undefined : "main" }),
                        );
                        setAdding(undefined);
                    }}
                >
                    <Field
                        label="New solution"
                        hint={
                            candidates.length === 0
                                ? "Every program in the package is already listed."
                                : draft.type === "output-only"
                                  ? "A program, or a folder of outputs named <group>/<index>.out."
                                  : undefined
                        }
                        className="min-w-56 flex-1"
                    >
                        {(id) => (
                            <FileSelect
                                id={id}
                                value={adding}
                                files={candidates}
                                onChange={setAdding}
                            />
                        )}
                    </Field>
                </AddRow>
            )}
            <CombinationDialog
                target={other}
                onClose={() => setOther(undefined)}
                onPick={(value) => {
                    if (other) apply(other.apply(value));
                    setOther(undefined);
                }}
            />
        </Card>
    );
};
