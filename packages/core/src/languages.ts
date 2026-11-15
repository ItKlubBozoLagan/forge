export const LANGUAGES = ["c", "cpp", "python", "java", "go", "rust", "ocaml"] as const;
export type Language = (typeof LANGUAGES)[number];

const BY_EXTENSION: Record<string, Language> = {
    c: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    py: "python",
    java: "java",
    go: "go",
    rs: "rust",
    ml: "ocaml",
};

export const languageOf = (path: string): Language | undefined => {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return undefined;
    return BY_EXTENSION[path.slice(dot + 1).toLowerCase()];
};
