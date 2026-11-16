import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { ChangeEvent, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { send } from "../lib/api";
import { keys } from "../lib/queries";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { useToast } from "../ui/Toast";

type Imported = { id: string; name: string; title: string; notes: string[] };

/**
 * Creates a problem from a Polygon package and shows what the import could not carry over
 * before the author opens the result.
 */
export const PolygonImport = ({ workspaceId }: { workspaceId: string }) => {
    const input = useRef<HTMLInputElement>(null);
    const [pending, setPending] = useState(false);
    const [imported, setImported] = useState<Imported>();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const toast = useToast();

    const upload = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setPending(true);
        try {
            const response = await send("POST", `/workspaces/${workspaceId}/import/polygon`, {
                bytes: new Uint8Array(await file.arrayBuffer()) as BodyInit,
            });
            const result = (await response.json()) as Imported;
            await queryClient.invalidateQueries({ queryKey: keys.problems(workspaceId) });
            if (result.notes.length === 0) navigate(`/p/${result.id}`);
            else setImported(result);
        } catch (error) {
            toast.error(error);
        } finally {
            setPending(false);
        }
    };

    return (
        <>
            <input
                ref={input}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                aria-label="Polygon package"
                data-testid="polygon-file"
                onChange={upload}
            />
            <Button
                icon={<Upload className="size-4" />}
                pending={pending}
                onClick={() => input.current?.click()}
                title="Create a problem from a package downloaded from Polygon"
            >
                Import from Polygon
            </Button>
            <Dialog
                open={!!imported}
                onClose={() => setImported(undefined)}
                title={`Imported ${imported?.title ?? ""}`}
                description="The package was converted. These points need your attention before it builds the way it did on Polygon."
            >
                <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm" data-testid="import-notes">
                    {imported?.notes.map((note) => <li key={note}>{note}</li>)}
                </ul>
                <div className="mt-4 flex justify-end">
                    <Button variant="primary" onClick={() => imported && navigate(`/p/${imported.id}`)}>
                        Open problem
                    </Button>
                </div>
            </Dialog>
        </>
    );
};
