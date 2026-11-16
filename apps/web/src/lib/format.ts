export const formatBytes = (bytes: number | undefined | null): string => {
    if (bytes === undefined || bytes === null) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

export const formatMs = (ms: number | undefined | null): string =>
    ms === undefined || ms === null ? "-" : `${Math.round(ms)} ms`;

export const formatKb = (kb: number | undefined | null): string => {
    if (kb === undefined || kb === null) return "-";
    if (kb < 1024) return `${kb} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
};

export const formatDate = (iso: string | null | undefined): string => {
    if (!iso) return "-";
    const date = new Date(iso);
    return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
};

export const formatRelative = (iso: string | null | undefined): string => {
    if (!iso) return "-";
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 45) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 14) return `${days} d ago`;
    return formatDate(iso);
};

export const formatDuration = (from: string | null, to: string | null): string => {
    if (!from) return "-";
    const end = to ? new Date(to).getTime() : Date.now();
    const seconds = Math.max(0, Math.round((end - new Date(from).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export const slugify = (title: string) =>
    title
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);

export const plural = (count: number, word: string, many = `${word}s`) =>
    `${count} ${count === 1 ? word : many}`;
