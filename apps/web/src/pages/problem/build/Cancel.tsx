import { useQueryClient } from "@tanstack/react-query";
import { Square } from "lucide-react";
import { useState } from "react";

import { api } from "../../../lib/api";
import { can, isActive, keys, useMe } from "../../../lib/queries";
import type { BuildSummary, Problem } from "../../../lib/types";
import { Button } from "../../../ui/Button";
import { Notice } from "../../../ui/misc";
import { useToast } from "../../../ui/Toast";

type Run = Pick<BuildSummary, "id" | "kind" | "status" | "error" | "createdBy">;

/** A run stopped on request is stored as failed with an error that starts with "Cancelled by". */
export const isCancelled = (run: Pick<BuildSummary, "status" | "error">) =>
    run.status === "failed" && !!run.error?.startsWith("Cancelled by");

/** Stops a queued or running build, invocation or stress run. Writers and the run's creator may. */
export const CancelButton = ({ problem, run }: { problem: Problem; run: Run }) => {
    const queryClient = useQueryClient();
    const toast = useToast();
    const me = useMe();
    const [cancelling, setCancelling] = useState(false);
    const may = can(problem.role, "write") || (!!me.data && me.data.user.id === run.createdBy);
    if (!isActive(run.status) || !may) return null;

    const cancel = async () => {
        setCancelling(true);
        try {
            await api.post(`/builds/${run.id}/cancel`);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: keys.build(run.id) }),
                queryClient.invalidateQueries({ queryKey: keys.builds(problem.id, run.kind) }),
            ]);
        } catch (error) {
            toast.error(error);
        } finally {
            setCancelling(false);
        }
    };

    return (
        <Button
            size="sm"
            variant="danger"
            icon={<Square className="size-3.5" />}
            pending={cancelling}
            onClick={cancel}
            title="Stop this run: work already handed to the runner finishes, nothing new starts"
        >
            Cancel
        </Button>
    );
};

/** Neutral notice for a cancelled run; the caller shows it only when `isCancelled` is true. */
export const CancelledNotice = ({ run, next }: { run: Pick<BuildSummary, "error">; next: string }) => (
    <Notice>
        <span data-testid="build-cancelled">{run.error}.</span> {next}
    </Notice>
);
