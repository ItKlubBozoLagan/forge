import { useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { useNavigate } from "react-router";

import { api } from "../../lib/api";
import { can, keys } from "../../lib/queries";
import type { Problem } from "../../lib/types";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/Dialog";
import { Field, Input } from "../../ui/Field";
import { Card } from "../../ui/misc";
import { useToast } from "../../ui/Toast";

/** Retitle and delete: the things about a problem that are not files in its package. */
export const ProblemSettings = ({ problem }: { problem: Problem }) => {
    const [title, setTitle] = useState(problem.title);
    const [pending, setPending] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const toast = useToast();
    if (!can(problem.role, "write")) return null;

    const rename = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        try {
            await api.patch(`/problems/${problem.id}`, { title: title.trim() });
            await queryClient.invalidateQueries({ queryKey: keys.problem(problem.id) });
            await queryClient.invalidateQueries({ queryKey: keys.problems(problem.workspace.id) });
            toast.success("Title updated");
        } catch (error) {
            toast.error(error);
        } finally {
            setPending(false);
        }
    };

    return (
        <Card title="Problem settings">
            <form onSubmit={rename} className="flex flex-wrap items-end gap-2">
                <Field
                    label="Title"
                    hint="Shown in lists. The title contestants see comes from problem.yaml."
                    className="min-w-0 flex-1"
                >
                    {(id, describedBy) => (
                        <Input
                            id={id}
                            aria-describedby={describedBy}
                            value={title}
                            maxLength={120}
                            onChange={(event) => setTitle(event.target.value)}
                        />
                    )}
                </Field>
                <Button
                    type="submit"
                    pending={pending}
                    disabled={!title.trim() || title.trim() === problem.title}
                >
                    Save title
                </Button>
            </form>
            {can(problem.role, "manage") && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
                    <p className="text-sm text-muted">
                        Deleting removes the problem, its revisions, builds and discussions.
                    </p>
                    <Button variant="danger" onClick={() => setDeleting(true)}>
                        Delete problem
                    </Button>
                </div>
            )}
            <ConfirmDialog
                open={deleting}
                onClose={() => setDeleting(false)}
                title="Delete problem"
                message={
                    <>
                        Delete <span className="font-mono">{problem.name}</span> for good? This
                        cannot be undone.
                    </>
                }
                confirmLabel="Delete"
                danger
                onConfirm={async () => {
                    await api.del(`/problems/${problem.id}`);
                    await queryClient.invalidateQueries({ queryKey: keys.problems(problem.workspace.id) });
                    navigate("/");
                }}
            />
        </Card>
    );
};
