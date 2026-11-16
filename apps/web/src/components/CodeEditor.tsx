import { cpp } from "@codemirror/lang-cpp";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

import { useDarkMode } from "../lib/hooks";
import { cx } from "../ui/cx";

/** CodeMirror language support picked from a file name or a Forge language id. */
export const languageExtension = (pathOrLanguage: string): Extension[] => {
    const value = pathOrLanguage.toLowerCase();
    const extension = value.includes(".") ? value.slice(value.lastIndexOf(".") + 1) : value;
    switch (extension) {
        case "c":
        case "cpp":
        case "cc":
        case "cxx":
        case "h":
        case "hpp":
        case "java":
        case "go":
        case "rs":
        case "rust":
            return [cpp()];
        case "py":
        case "python":
            return [python()];
        case "yaml":
        case "yml":
            return [yaml()];
        case "md":
        case "markdown":
            return [markdown()];
        default:
            return [];
    }
};

export const CodeEditor = ({
    value,
    onChange,
    language,
    readOnly,
    className,
    label,
    height = "100%",
}: {
    value: string;
    onChange?: (value: string) => void;
    /** File path or language id used to pick syntax highlighting. */
    language: string;
    readOnly?: boolean;
    className?: string;
    label: string;
    height?: string;
}) => {
    const dark = useDarkMode();
    const extensions = useMemo(
        () => [
            ...languageExtension(language),
            EditorView.contentAttributes.of({ "aria-label": label }),
        ],
        [language, label],
    );
    return (
        <div data-testid="editor" className={cx("cm-host overflow-hidden", className)}>
            <CodeMirror
                value={value}
                onChange={onChange}
                extensions={extensions}
                theme={dark ? "dark" : "light"}
                readOnly={readOnly}
                editable={!readOnly}
                height={height}
                basicSetup={{ foldGutter: false, highlightActiveLine: !readOnly }}
            />
        </div>
    );
};
