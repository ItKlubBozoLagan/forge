import { ChevronDown, ChevronRight, FileText, Folder, Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { formatBytes } from "../../lib/format";
import type { TreeFile } from "../../lib/types";
import { cx } from "../../ui/cx";

type FolderNode = { name: string; path: string; folders: FolderNode[]; files: TreeFile[] };

const buildTree = (files: TreeFile[]): FolderNode => {
    const root: FolderNode = { name: "", path: "", folders: [], files: [] };
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
        const parts = file.path.split("/");
        let node = root;
        for (const part of parts.slice(0, -1)) {
            const path = node.path ? `${node.path}/${part}` : part;
            let child = node.folders.find((folder) => folder.name === part);
            if (!child) {
                child = { name: part, path, folders: [], files: [] };
                node.folders.push(child);
            }
            node = child;
        }
        node.files.push(file);
    }
    return root;
};

type Props = {
    files: TreeFile[];
    selected?: string;
    dirtyPath?: string;
    writable: boolean;
    onSelect: (path: string) => void;
    onRename: (path: string) => void;
    onDelete: (path: string) => void;
};

export const FileTree = (props: Props) => {
    const root = useMemo(() => buildTree(props.files), [props.files]);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const toggle = (path: string) =>
        setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });

    const renderFolder = (node: FolderNode, depth: number) => (
        <ul role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "Files" : undefined}>
            {node.folders.map((folder) => {
                const open = !collapsed.has(folder.path);
                return (
                    <li
                        key={folder.path}
                        role="treeitem"
                        aria-expanded={open}
                        aria-selected={false}
                    >
                        <button
                            type="button"
                            onClick={() => toggle(folder.path)}
                            className="flex h-7 w-full items-center gap-1 rounded px-1 text-left text-[13px] text-muted hover:bg-surface-2 hover:text-fg"
                            style={{ paddingLeft: 4 + depth * 12 }}
                        >
                            {open ? (
                                <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                            ) : (
                                <ChevronRight className="size-3.5 shrink-0" aria-hidden />
                            )}
                            <Folder className="size-3.5 shrink-0" aria-hidden />
                            <span className="truncate">{folder.name}</span>
                        </button>
                        {open && renderFolder(folder, depth + 1)}
                    </li>
                );
            })}
            {node.files.map((file) => {
                const name = file.path.slice(file.path.lastIndexOf("/") + 1);
                const active = file.path === props.selected;
                return (
                    <li
                        key={file.path}
                        role="treeitem"
                        aria-selected={active}
                        className={cx(
                            "group flex items-center rounded",
                            active ? "bg-accent-soft" : "hover:bg-surface-2",
                        )}
                    >
                        <button
                            type="button"
                            data-testid={`file-${file.path}`}
                            title={`${file.path} (${formatBytes(file.size)})`}
                            aria-current={active ? "true" : undefined}
                            onClick={() => props.onSelect(file.path)}
                            className={cx(
                                "flex h-7 min-w-0 flex-1 items-center gap-1.5 px-1 text-left text-[13px]",
                                active ? "font-medium text-accent" : "text-fg",
                            )}
                            style={{ paddingLeft: 4 + depth * 12 + 18 }}
                        >
                            <FileText className="size-3.5 shrink-0 opacity-60" aria-hidden />
                            <span className="truncate font-mono text-[12.5px]">{name}</span>
                            {props.dirtyPath === file.path && (
                                <span
                                    className="text-warning"
                                    title="Modified, not saved"
                                    aria-label="modified"
                                >
                                    ●
                                </span>
                            )}
                        </button>
                        {props.writable && (
                            <span className="flex shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                                <button
                                    type="button"
                                    aria-label={`Rename ${file.path}`}
                                    title="Rename"
                                    onClick={() => props.onRename(file.path)}
                                    className="rounded p-1 text-muted hover:bg-surface-3 hover:text-fg"
                                >
                                    <Pencil className="size-3.5" />
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Delete ${file.path}`}
                                    title="Delete"
                                    onClick={() => props.onDelete(file.path)}
                                    className="rounded p-1 text-muted hover:bg-surface-3 hover:text-danger"
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            </span>
                        )}
                    </li>
                );
            })}
        </ul>
    );

    return <div className="text-sm">{renderFolder(root, 0)}</div>;
};
