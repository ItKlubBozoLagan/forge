import { Download } from "lucide-react";
import { DragEvent, useCallback, useRef, useState } from "react";

import { archiveUrl, downloadFrom, syncChanges } from "../../../lib/files";
import { plural } from "../../../lib/format";
import type { TreeFile } from "../../../lib/types";
import { Button, ButtonSize } from "../../../ui/Button";
import { ConfirmDialog } from "../../../ui/Dialog";
import { useToast } from "../../../ui/Toast";
import { Picked, readDrop } from "./pick";
import { UploadDialog } from "./UploadDialog";

/**
 * Bulk changes in the Files tab: the upload dialog, dropping files on the tree and deleting
 * whole folders. Everything is applied with one atomic `sync`.
 */
export const useBulkFiles = ({
    problemId,
    files,
    writable,
    onApplied,
    onReloadTree,
}: {
    problemId: string;
    files: TreeFile[];
    writable: boolean;
    /** Called after a change was applied, with the paths it touched. */
    onApplied: (paths: string[], deleted: boolean) => Promise<void> | void;
    onReloadTree: () => Promise<unknown>;
}) => {
    const [upload, setUpload] = useState<{ picked?: Picked; dir: string }>();
    const [folder, setFolder] = useState<string>();
    const [dragging, setDragging] = useState(false);
    const depth = useRef(0);
    const toast = useToast();

    const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
    const dropProps = writable
        ? {
              onDragEnter: (event: DragEvent) => {
                  if (!hasFiles(event)) return;
                  event.preventDefault();
                  depth.current++;
                  setDragging(true);
              },
              onDragOver: (event: DragEvent) => {
                  if (!hasFiles(event)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
              },
              onDragLeave: () => {
                  depth.current = Math.max(0, depth.current - 1);
                  if (depth.current === 0) setDragging(false);
              },
              onDrop: (event: DragEvent) => {
                  if (!hasFiles(event)) return;
                  event.preventDefault();
                  depth.current = 0;
                  setDragging(false);
                  // dropping on a folder of the tree uploads into that folder
                  const target = (event.target as HTMLElement).closest<HTMLElement>(
                      "[data-folder]",
                  );
                  const dir = target?.dataset.folder ?? "";
                  readDrop(event.dataTransfer)
                      .then((picked) => picked && setUpload({ picked, dir }))
                      .catch((error) => toast.error(error));
              },
          }
        : {};

    const folderFiles = folder ? files.filter((file) => file.path.startsWith(`${folder}/`)) : [];

    const dialogs = (
        <>
            <UploadDialog
                open={!!upload}
                onClose={() => setUpload(undefined)}
                problemId={problemId}
                files={files}
                initial={upload?.picked}
                initialDir={upload?.dir ?? ""}
                onApplied={(paths) => onApplied(paths, false)}
                onReloadTree={onReloadTree}
            />
            <ConfirmDialog
                open={!!folder}
                onClose={() => setFolder(undefined)}
                title={`Delete folder ${folder ?? ""}`}
                message={
                    <>
                        <p>
                            Delete <span className="font-mono">{folder}/</span> and the{" "}
                            {plural(folderFiles.length, "file")} in it from the working copy?
                            Committed revisions keep their copy.
                        </p>
                        <ul className="mt-2 max-h-40 overflow-auto font-mono text-[12.5px] text-muted">
                            {folderFiles.slice(0, 50).map((file) => (
                                <li key={file.path} className="break-all">
                                    {file.path}
                                </li>
                            ))}
                            {folderFiles.length > 50 && <li>and {folderFiles.length - 50} more</li>}
                        </ul>
                    </>
                }
                confirmLabel={`Delete ${plural(folderFiles.length, "file")}`}
                danger
                onConfirm={async () => {
                    const paths = folderFiles.map((file) => file.path);
                    await syncChanges(
                        problemId,
                        folderFiles.map((file) => ({
                            path: file.path,
                            base: file.hash,
                            hash: null,
                        })),
                    );
                    await onApplied(paths, true);
                    toast.success(`Deleted ${folder}/ (${plural(paths.length, "file")})`);
                }}
            />
        </>
    );

    return {
        openUpload: useCallback(() => setUpload({ dir: "" }), []),
        deleteFolder: setFolder,
        dropProps,
        dragging,
        dialogs,
    };
};

/** Downloads the package files (the working copy, or a revision) as a zip. */
export const DownloadPackageButton = ({
    problemId,
    revisionId,
    name,
    size = "sm",
    iconOnly,
}: {
    problemId: string;
    revisionId?: string;
    name: string;
    size?: ButtonSize;
    iconOnly?: boolean;
}) => {
    const [pending, setPending] = useState(false);
    const toast = useToast();
    return (
        <Button
            size={size}
            icon={<Download className="size-3.5" />}
            pending={pending}
            title="Download package"
            aria-label={iconOnly ? "Download package" : undefined}
            onClick={async () => {
                setPending(true);
                try {
                    await downloadFrom(archiveUrl(problemId, revisionId), `${name}.zip`);
                } catch (error) {
                    toast.error(error);
                } finally {
                    setPending(false);
                }
            }}
        >
            {iconOnly ? undefined : "Download package"}
        </Button>
    );
};
