import {
    addGroup,
    addTest,
    DraftGroup,
    DraftTest,
    moveGroup,
    moveTest,
    Plan,
    removeGroup,
    removeTest,
    TestEdit,
    updateGroup,
    updateTest,
} from "@forge/core";
import { useState } from "react";

import { Badge } from "../../../ui/Badge";
import { Field, Input, Select } from "../../../ui/Field";
import { Card } from "../../../ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "../../../ui/Table";
import {
    CommitInput,
    FileSelect,
    GROUP_NAME,
    NumberInput,
    Op,
    RowActions,
    SectionHint,
} from "./controls";
import { AddRow, ConstraintTable, SectionProps } from "./GeneralSections";

/**
 * The planned test ids of each test line of a group, matched in order against the build plan.
 * A line whose generator cannot be resolved plans no tests.
 */
const plannedIds = (group: DraftGroup, plan: Plan | undefined): string[][] | undefined => {
    if (!plan) return undefined;
    const tests = plan.tests.filter((test) => test.group === group.name);
    let next = 0;
    return group.tests.map((spec) => {
        const ids: string[] = [];
        if (spec.manual !== undefined) {
            const test = tests[next];
            if (test?.source.kind === "manual" && test.source.path === spec.manual) {
                ids.push(test.id);
                next++;
            }
            return ids;
        }
        const count = spec.count ?? 1;
        while (ids.length < count) {
            const test = tests[next];
            if (test?.source.kind !== "gen" || test.source.generator !== spec.gen) break;
            ids.push(test.id);
            next++;
        }
        return ids;
    });
};

const idRange = (ids: string[]) => {
    if (ids.length === 0) return "none";
    if (ids.length === 1) return ids[0]!;
    return `${ids[0]} to ${ids[ids.length - 1]!.split("/").pop()}`;
};

const toEdit = (test: DraftTest): TestEdit =>
    test.manual !== undefined
        ? { manual: test.manual, answer: test.answer, desc: test.desc }
        : { gen: test.gen ?? "", args: test.args, count: test.count, desc: test.desc };

export const GroupsSection = (props: SectionProps & { plan?: Plan }) => {
    const { draft, apply, readOnly } = props;
    const [name, setName] = useState("");
    const names = draft.groups.map((group) => group.name);
    const invalid =
        name && !GROUP_NAME.test(name)
            ? "Letters, digits, - and _"
            : names.includes(name)
              ? "Already listed"
              : undefined;
    return (
        <Card title="Groups and tests" data-testid="structure-groups">
            <SectionHint>
                Tests are numbered inside their group; the ids shown are the ones a build uses.
            </SectionHint>
            <div className="flex flex-col gap-3">
                {draft.groups.map((group, index) => (
                    <GroupEditor
                        key={`${index}-${group.name}`}
                        {...props}
                        group={group}
                        index={index}
                        ids={plannedIds(group, props.plan)}
                    />
                ))}
            </div>
            {!readOnly && (
                <AddRow
                    label="Add group"
                    disabled={!name || !!invalid}
                    onSubmit={() => {
                        if (!name || invalid) return;
                        const added = name;
                        apply((text) => addGroup(text, { name: added }));
                        setName("");
                    }}
                >
                    <Field label="New group" error={invalid} className="w-48">
                        {(id, describedBy) => (
                            <Input
                                id={id}
                                className="font-mono"
                                placeholder="subtask2"
                                value={name}
                                aria-describedby={describedBy}
                                onChange={(event) => setName(event.target.value.trim())}
                            />
                        )}
                    </Field>
                </AddRow>
            )}
        </Card>
    );
};

const GroupEditor = ({
    draft,
    apply,
    readOnly,
    paths,
    group,
    index,
    ids,
}: SectionProps & { group: DraftGroup; index: number; ids?: string[][] }) => {
    const others = draft.groups.map((item) => item.name).filter((name) => name !== group.name);
    const testFiles = paths.filter((path) => path !== "problem.yaml");
    const generators = Object.keys(draft.generators);
    const total = ids?.reduce((sum, item) => sum + item.length, 0);
    const name = group.name;

    return (
        <section
            className="rounded-lg border border-line"
            data-testid={`group-${name}`}
            aria-label={`Group ${name}`}
        >
            <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5">
                <h4 className="font-mono text-[13px] font-semibold">{name || "(no name)"}</h4>
                {group.sample && <Badge tone="accent">sample</Badge>}
                {total !== undefined && (
                    <span className="text-xs text-muted">
                        {total} test{total === 1 ? "" : "s"}
                    </span>
                )}
                <div className="ml-auto">
                    <RowActions
                        label={`group ${name}`}
                        index={index}
                        count={draft.groups.length}
                        disabled={readOnly}
                        onMove={(to) => apply((text) => moveGroup(text, name, to))}
                        onRemove={() => apply((text) => removeGroup(text, name))}
                    />
                </div>
            </header>
            <div className="flex flex-col gap-3 p-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Field label="Name">
                        {(id) => (
                            <CommitInput
                                id={id}
                                className="font-mono"
                                value={name}
                                disabled={readOnly}
                                check={(value) =>
                                    !GROUP_NAME.test(value)
                                        ? "Letters, digits, - and _"
                                        : others.includes(value)
                                          ? "Already listed"
                                          : undefined
                                }
                                onCommit={(value) =>
                                    apply((text) => updateGroup(text, name, { name: value }))
                                }
                            />
                        )}
                    </Field>
                    <Field label="Points">
                        {(id) => (
                            <NumberInput
                                id={id}
                                min={0}
                                optional
                                placeholder="0"
                                value={group.points}
                                disabled={readOnly}
                                onCommit={(value) =>
                                    apply((text) => updateGroup(text, name, { points: value }))
                                }
                            />
                        )}
                    </Field>
                    <Field label="Scored by">
                        {(id) => (
                            <Select
                                id={id}
                                value={group.aggregate ?? "min"}
                                disabled={readOnly}
                                onChange={(event) => {
                                    const aggregate = event.target.value as "min" | "sum";
                                    apply((text) => updateGroup(text, name, { aggregate }));
                                }}
                            >
                                <option value="min">All tests (min)</option>
                                <option value="sum">Average of tests (sum)</option>
                            </Select>
                        )}
                    </Field>
                    <label className="flex items-center gap-2 self-end pb-1.5 text-sm">
                        <input
                            type="checkbox"
                            checked={group.sample}
                            disabled={readOnly}
                            onChange={(event) => {
                                const sample = event.target.checked;
                                apply((text) => updateGroup(text, name, { sample }));
                            }}
                        />
                        Sample (shown in the statement)
                    </label>
                </div>
                {others.length > 0 && (
                    <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <legend className="mb-1 text-[13px] font-medium">
                            Depends on (scores only when these are solved, and includes their tests)
                        </legend>
                        {others.map((other) => (
                            <label key={other} className="flex items-center gap-1.5 text-sm">
                                <input
                                    type="checkbox"
                                    checked={group.depends.includes(other)}
                                    disabled={readOnly}
                                    onChange={(event) => {
                                        const depends = event.target.checked
                                            ? [...group.depends, other]
                                            : group.depends.filter((item) => item !== other);
                                        apply((text) => updateGroup(text, name, { depends }));
                                    }}
                                />
                                <span className="font-mono">{other}</span>
                            </label>
                        ))}
                    </fieldset>
                )}
                {(Object.keys(group.constraints).length > 0 ||
                    (!readOnly && Object.keys(draft.constraints).length > 0)) && (
                    <div>
                        <h5 className="mb-1 text-[13px] font-medium">Constraint overrides</h5>
                        <ConstraintTable
                            bounds={group.constraints}
                            apply={apply}
                            readOnly={readOnly}
                            group={name}
                            names={Object.keys(draft.constraints)}
                        />
                    </div>
                )}
                <div>
                    <h5 className="mb-1 text-[13px] font-medium">Tests</h5>
                    {group.tests.length === 0 ? (
                        <p className="text-sm text-muted">
                            {group.depends.length > 0
                                ? "No tests of its own; it uses the tests of the groups it depends on."
                                : "No tests yet."}
                        </p>
                    ) : (
                        <TableWrap>
                            <Table>
                                <thead>
                                    <tr>
                                        <Th>Test ids</Th>
                                        <Th>Source</Th>
                                        <Th>File or generator</Th>
                                        <Th>Arguments / answer</Th>
                                        <Th>Count</Th>
                                        <Th>Description</Th>
                                        <Th className="w-0">
                                            <span className="sr-only">Actions</span>
                                        </Th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {group.tests.map((test, row) => (
                                        <TestRow
                                            key={row}
                                            test={test}
                                            row={row}
                                            count={group.tests.length}
                                            group={name}
                                            ids={ids?.[row]}
                                            apply={apply}
                                            readOnly={readOnly}
                                            files={testFiles}
                                            generators={generators}
                                        />
                                    ))}
                                </tbody>
                            </Table>
                        </TableWrap>
                    )}
                    {!readOnly && (
                        <AddTestForm
                            group={name}
                            apply={apply}
                            files={testFiles}
                            generators={generators}
                        />
                    )}
                </div>
            </div>
        </section>
    );
};

const TestRow = ({
    test,
    row,
    count,
    group,
    ids,
    apply,
    readOnly,
    files,
    generators,
}: {
    test: DraftTest;
    row: number;
    count: number;
    group: string;
    ids?: string[];
    apply: (op: Op) => void;
    readOnly: boolean;
    files: string[];
    generators: string[];
}) => {
    const manual = test.manual !== undefined;
    const label = `test ${row + 1} of ${group}`;
    const update = (edit: TestEdit) => apply((text) => updateTest(text, group, row, edit));
    const current = toEdit(test);
    return (
        <Tr data-testid={`test-${group}-${row + 1}`}>
            <Td className="font-mono text-xs whitespace-nowrap text-muted">
                {ids ? idRange(ids) : "-"}
            </Td>
            <Td className="min-w-40">
                <Select
                    aria-label={`Source of ${label}`}
                    value={manual ? "manual" : "gen"}
                    disabled={readOnly}
                    onChange={(event) => {
                        if (event.target.value === "manual") {
                            const file = files[0];
                            if (file) update({ manual: file, desc: test.desc });
                        } else update({ gen: generators[0] ?? "", args: "", desc: test.desc });
                    }}
                >
                    <option value="manual">File</option>
                    <option value="gen" disabled={generators.length === 0 && manual}>
                        Generator
                    </option>
                </Select>
            </Td>
            <Td className="min-w-44">
                {manual ? (
                    <FileSelect
                        aria-label={`File of ${label}`}
                        value={test.manual}
                        files={files}
                        disabled={readOnly}
                        onChange={(path) => path && update({ ...current, manual: path } as TestEdit)}
                    />
                ) : (
                    <Select
                        aria-label={`Generator of ${label}`}
                        className="font-mono"
                        value={test.gen ?? ""}
                        disabled={readOnly}
                        onChange={(event) =>
                            update({ ...current, gen: event.target.value } as TestEdit)
                        }
                    >
                        {test.gen !== undefined && !generators.includes(test.gen) && (
                            <option value={test.gen}>{test.gen} (unknown)</option>
                        )}
                        {generators.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </Select>
                )}
            </Td>
            <Td className="min-w-48">
                {manual ? (
                    <FileSelect
                        aria-label={`Answer file of ${label}`}
                        value={test.answer}
                        files={files}
                        none="Answer from the main solution"
                        disabled={readOnly}
                        onChange={(path) => update({ ...current, answer: path } as TestEdit)}
                    />
                ) : (
                    <CommitInput
                        aria-label={`Arguments of ${label}`}
                        className="font-mono"
                        value={test.args ?? ""}
                        placeholder="n=10 seed={i}"
                        disabled={readOnly}
                        onCommit={(args) => update({ ...current, args } as TestEdit)}
                    />
                )}
            </Td>
            <Td className="min-w-20">
                {!manual && (
                    <NumberInput
                        aria-label={`Count of ${label}`}
                        integer
                        min={1}
                        optional
                        placeholder="1"
                        value={test.count}
                        disabled={readOnly}
                        onCommit={(value) => update({ ...current, count: value } as TestEdit)}
                    />
                )}
            </Td>
            <Td className="min-w-40">
                <CommitInput
                    aria-label={`Description of ${label}`}
                    value={test.desc ?? ""}
                    placeholder="optional"
                    maxLength={200}
                    disabled={readOnly}
                    onCommit={(desc) => update({ ...current, desc: desc || undefined })}
                />
            </Td>
            <Td>
                <RowActions
                    label={label}
                    index={row}
                    count={count}
                    disabled={readOnly}
                    onMove={(to) => apply((text) => moveTest(text, group, row, to))}
                    onRemove={() => apply((text) => removeTest(text, group, row))}
                />
            </Td>
        </Tr>
    );
};

const AddTestForm = ({
    group,
    apply,
    files,
    generators,
}: {
    group: string;
    apply: (op: Op) => void;
    files: string[];
    generators: string[];
}) => {
    const [kind, setKind] = useState<"gen" | "manual">(generators.length > 0 ? "gen" : "manual");
    const [file, setFile] = useState<string>();
    const [gen, setGen] = useState(generators[0] ?? "");
    const [args, setArgs] = useState("");
    const [count, setCount] = useState("");
    const [desc, setDesc] = useState("");
    const generator = generators.includes(gen) ? gen : (generators[0] ?? "");
    const copies = count.trim() === "" ? undefined : Number(count);
    const countProblem =
        copies !== undefined && (!Number.isInteger(copies) || copies < 1 || copies > 1000)
            ? "1 to 1000"
            : copies !== undefined && copies > 1 && !args.includes("{i}")
              ? "Use {i} in the arguments"
              : undefined;
    const ready = kind === "manual" ? !!file : !!generator && !countProblem;

    return (
        <AddRow
            label="Add test"
            disabled={!ready}
            onSubmit={() => {
                if (!ready) return;
                const test: TestEdit =
                    kind === "manual"
                        ? { manual: file!, desc: desc.trim() || undefined }
                        : {
                              gen: generator,
                              args: args.trim(),
                              count: copies,
                              desc: desc.trim() || undefined,
                          };
                apply((text) => addTest(text, group, test));
                setArgs("");
                setCount("");
                setDesc("");
                setFile(undefined);
            }}
        >
            <Field label="Source" className="w-32">
                {(id) => (
                    <Select
                        id={id}
                        value={kind}
                        onChange={(event) => setKind(event.target.value as "gen" | "manual")}
                    >
                        <option value="gen" disabled={generators.length === 0}>
                            Generator
                        </option>
                        <option value="manual">File</option>
                    </Select>
                )}
            </Field>
            {kind === "manual" ? (
                <Field label="Test file" className="min-w-48 flex-1">
                    {(id) => <FileSelect id={id} value={file} files={files} onChange={setFile} />}
                </Field>
            ) : (
                <>
                    <Field label="Generator" className="w-32">
                        {(id) => (
                            <Select
                                id={id}
                                className="font-mono"
                                value={generator}
                                onChange={(event) => setGen(event.target.value)}
                            >
                                {generators.map((name) => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </Select>
                        )}
                    </Field>
                    <Field label="Arguments" className="min-w-40 flex-1">
                        {(id) => (
                            <Input
                                id={id}
                                className="font-mono"
                                placeholder="n=10 seed={i}"
                                value={args}
                                onChange={(event) => setArgs(event.target.value)}
                            />
                        )}
                    </Field>
                    <Field label="Count" error={countProblem} className="w-24">
                        {(id, describedBy) => (
                            <Input
                                id={id}
                                inputMode="numeric"
                                placeholder="1"
                                value={count}
                                aria-describedby={describedBy}
                                onChange={(event) => setCount(event.target.value)}
                            />
                        )}
                    </Field>
                </>
            )}
            <Field label="Description" className="min-w-36 flex-1">
                {(id) => (
                    <Input
                        id={id}
                        placeholder="optional"
                        maxLength={200}
                        value={desc}
                        onChange={(event) => setDesc(event.target.value)}
                    />
                )}
            </Field>
        </AddRow>
    );
};
