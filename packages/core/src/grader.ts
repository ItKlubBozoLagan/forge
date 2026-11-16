import { Language } from "./languages";

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A grader task is judged as one program: the contestant's file followed by the grader, which
 * holds `main` and calls the contestant's functions. The judge compiles a single file, so the
 * two are joined here, with the shared headers inlined where they are first included.
 *
 * C and C++ keep their own file names and line numbers in compiler messages through `#line`.
 * Because both files end up in one translation unit, a helper with the same name in both
 * clashes; graders should keep their helpers in a namespace or give them a prefix.
 */
export const composeGrader = (
    solution: { path: string; source: string },
    grader: { path: string; source: string },
    language: Language,
    headers: Record<string, string>,
): string => {
    if (language === "python")
        return `${solution.source}\n\n# ---- grader: ${basename(grader.path)} ----\n${grader.source}`;
    const seen = new Set<string>();
    const byName = new Map(Object.entries(headers).map(([path, content]) => [basename(path), content]));
    const names = [...byName.keys()].map(escape).join("|");
    const inline = (source: string, file: string): string => {
        if (!names) return source;
        const include = new RegExp(`^[ \\t]*#[ \\t]*include[ \\t]*"(?:[^"]*/)?(${names})"[^\\n]*$`, "gm");
        // line numbers are taken from the original text, so they stay right after each inlining
        return source.replace(include, (_line, name: string, offset: number) => {
            if (seen.has(name)) return "";
            seen.add(name);
            const lineNumber = source.slice(0, offset).split("\n").length;
            return `#line 1 "${name}"\n${byName.get(name)!}\n#line ${lineNumber + 1} "${file}"`;
        });
    };
    const first = inline(solution.source, basename(solution.path));
    const second = inline(grader.source, basename(grader.path));
    return `#line 1 "${basename(solution.path)}"\n${first}\n#line 1 "${basename(grader.path)}"\n${second}\n`;
};
