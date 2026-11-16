import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import { api, decodeText, isBinary } from "../../../lib/api";
import { formatBytes } from "../../../lib/format";
import { ErrorNotice, Spinner } from "../../../ui/misc";

const MAX_BYTES = 64 * 1024;
const MAX_LINES = 200;

/** Shows the start of a stored blob (test input/answer): at most 200 lines / 64 KB. */
export const BlobPreview = ({
    problemId,
    hash,
    size,
    label,
    fileName,
}: {
    problemId: string;
    hash: string | undefined;
    size?: number;
    label: string;
    fileName?: string;
}) => {
    const blob = useQuery({
        queryKey: ["blob", problemId, hash],
        queryFn: () => api.bytes(`/problems/${problemId}/blobs/${hash}`),
        enabled: !!hash,
        staleTime: Infinity,
    });
    const headingId = `blob-${label}-${hash ?? "none"}`.replace(/[^a-zA-Z0-9-]/g, "-");
    let body = null;
    if (!hash) body = <p className="text-sm text-muted">Not available.</p>;
    else if (blob.isPending) body = <Spinner />;
    else if (blob.error) body = <ErrorNotice error={blob.error} />;
    else if (blob.data) {
        const bytes = blob.data.bytes;
        if (isBinary(bytes.subarray(0, MAX_BYTES)))
            body = (
                <p className="text-sm text-muted">Binary content ({formatBytes(bytes.length)}).</p>
            );
        else {
            const head = decodeText(bytes.subarray(0, MAX_BYTES));
            const lines = head.split("\n");
            const shown = lines.slice(0, MAX_LINES).join("\n");
            const truncated = bytes.length > MAX_BYTES || lines.length > MAX_LINES;
            body = (
                <>
                    <pre
                        aria-labelledby={headingId}
                        className="max-h-80 overflow-auto rounded-md border border-line bg-surface-2 p-2 font-mono text-xs leading-relaxed whitespace-pre"
                    >
                        {shown || <span className="text-subtle">(empty)</span>}
                    </pre>
                    {truncated && (
                        <p className="mt-1 text-xs text-muted">
                            Showing the first {Math.min(lines.length, MAX_LINES)} lines
                            {bytes.length > MAX_BYTES ? ` (${formatBytes(MAX_BYTES)})` : ""} of{" "}
                            {formatBytes(bytes.length)}.
                        </p>
                    )}
                </>
            );
        }
    }
    const total = size ?? blob.data?.bytes.length;
    return (
        <section>
            <div className="mb-1 flex items-center gap-2">
                <h3 id={headingId} className="text-[13px] font-semibold">
                    {label}
                </h3>
                {total !== undefined && (
                    <span className="text-xs text-muted">{formatBytes(total)}</span>
                )}
                {hash && (
                    <a
                        href={`/api/problems/${problemId}/blobs/${hash}`}
                        download={fileName ?? `${label.toLowerCase()}.txt`}
                        className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline"
                    >
                        <Download className="size-3.5" aria-hidden />
                        Download
                    </a>
                )}
            </div>
            {body}
        </section>
    );
};
