const SYNCABLE = /^[A-Za-z0-9._\-/]+$/;

/** A path the server accepts and that cannot escape the working directory. */
export const isSyncable = (path: string): boolean =>
    SYNCABLE.test(path) &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const escapeChar = (char: string) => char.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const globToRegExp = (glob: string): RegExp => {
    let out = "";
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i]!;
        if (char === "*") {
            if (glob[i + 1] === "*") {
                i++;
                if (glob[i + 1] === "/") {
                    i++;
                    out += "(?:.*/)?";
                } else out += ".*";
            } else out += "[^/]*";
        } else if (char === "?") out += "[^/]";
        else out += escapeChar(char);
    }
    return new RegExp(`^${out}$`);
};

type Rule = { regex: RegExp; dirOnly: boolean };

const parseRule = (line: string): Rule | undefined => {
    let pattern = line.trim();
    if (pattern === "" || pattern.startsWith("#")) return undefined;
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith("/") || pattern.includes("/");
    pattern = pattern.replace(/^\//, "");
    if (pattern === "") return undefined;
    return { regex: globToRegExp(anchored ? pattern : `**/${pattern}`), dirOnly };
};

export type IgnoreMatcher = (path: string, isDir?: boolean) => boolean;

/**
 * Built-in: dotfiles and `node_modules`. Extra lines are simple globs: `*` (within a segment),
 * `**` (across segments), `?`, a leading `/` to anchor, a trailing `/` for directories only.
 * A pattern without a slash matches at any depth. A match on a directory ignores its contents.
 */
export const createIgnore = (forgeignore = ""): IgnoreMatcher => {
    const rules = forgeignore
        .split(/\r?\n/)
        .map(parseRule)
        .filter((rule): rule is Rule => rule !== undefined);
    return (path, isDir = false) => {
        const parts = path.split("/");
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i]!;
            if (part.startsWith(".") || part === "node_modules") return true;
            const prefix = parts.slice(0, i + 1).join("/");
            const dir = i < parts.length - 1 || isDir;
            if (rules.some((rule) => (!rule.dirOnly || dir) && rule.regex.test(prefix))) return true;
        }
        return false;
    };
};
