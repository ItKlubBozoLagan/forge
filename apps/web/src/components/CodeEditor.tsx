import { cpp } from "@codemirror/lang-cpp";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { Extension, RangeSet, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, gutter, GutterMarker } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";

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
    markers,
    onMarkerClick,
    onGutterClick,
    onCursorLine,
    focusLine,
}: {
    value: string;
    onChange?: (value: string) => void;
    /** File path or language id used to pick syntax highlighting. */
    language: string;
    readOnly?: boolean;
    className?: string;
    label: string;
    height?: string;
    /** Lines marked in a comment gutter (e.g. lines with open review threads). */
    markers?: LineMarker[];
    /** A click on a marked line in the comment gutter. */
    onMarkerClick?: (line: number) => void;
    /** A click on an unmarked line in the comment gutter; shows the gutter when set. */
    onGutterClick?: (line: number) => void;
    /** The 1-based line of the cursor whenever the selection moves. */
    onCursorLine?: (line: number) => void;
    /** Scrolls to this 1-based line, puts the cursor there and highlights it. */
    focusLine?: number;
}) => {
    const dark = useDarkMode();
    const [view, setView] = useState<EditorView>();
    // callbacks live in a ref so a new function identity does not reconfigure the editor
    const callbacks = useRef({ onMarkerClick, onGutterClick, onCursorLine });
    callbacks.current = { onMarkerClick, onGutterClick, onCursorLine };
    const commentGutter = !!markers || !!onGutterClick;
    const markerKey = (markers ?? []).map((marker) => `${marker.line}:${marker.count}`).join(",");

    const extensions = useMemo(
        () => {
            const list: Extension[] = [
                ...languageExtension(language),
                EditorView.contentAttributes.of({ "aria-label": label }),
                EditorView.updateListener.of((update) => {
                    if (!update.selectionSet && !update.docChanged) return;
                    const head = update.state.selection.main.head;
                    callbacks.current.onCursorLine?.(update.state.doc.lineAt(head).number);
                }),
                editorTheme,
            ];
            if (commentGutter) list.push(commentGutterExtension(markers ?? [], callbacks));
            if (focusLine) list.push(focusLineExtension(focusLine));
            return list;
        },
        // markerKey stands for the marker list
        [language, label, commentGutter, markerKey, focusLine],
    );

    useEffect(() => {
        if (!view || !focusLine) return;
        const doc = view.state.doc;
        const line = doc.line(Math.min(Math.max(1, focusLine), doc.lines));
        view.dispatch({
            selection: { anchor: line.from },
            effects: EditorView.scrollIntoView(line.from, { y: "center" }),
        });
    }, [view, focusLine]);

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
                onCreateEditor={(created) => setView(created)}
            />
        </div>
    );
};

export type LineMarker = { line: number; count: number; label: string };

class CommentMarker extends GutterMarker {
    constructor(readonly marker: LineMarker) {
        super();
    }
    eq(other: GutterMarker) {
        return (
            other instanceof CommentMarker &&
            other.marker.line === this.marker.line &&
            other.marker.count === this.marker.count
        );
    }
    toDOM() {
        const element = document.createElement("span");
        element.className = "cm-comment-marker";
        element.textContent = String(this.marker.count);
        element.title = this.marker.label;
        element.setAttribute("data-testid", `comment-marker-${this.marker.line}`);
        return element;
    }
}

class SpacerMarker extends GutterMarker {
    toDOM() {
        const element = document.createElement("span");
        element.className = "cm-comment-marker";
        element.textContent = "0";
        return element;
    }
}

const commentGutterExtension = (
    markers: LineMarker[],
    callbacks: {
        current: {
            onMarkerClick?: (line: number) => void;
            onGutterClick?: (line: number) => void;
        };
    },
): Extension => {
    const byLine = new Map(markers.map((marker) => [marker.line, marker]));
    return gutter({
        class: "cm-comment-gutter",
        markers: (view) => {
            const builder = new RangeSetBuilder<GutterMarker>();
            const doc = view.state.doc;
            for (const marker of [...byLine.values()].sort((a, b) => a.line - b.line)) {
                if (marker.line < 1 || marker.line > doc.lines) continue;
                const line = doc.line(marker.line);
                builder.add(line.from, line.from, new CommentMarker(marker));
            }
            return builder.finish() as RangeSet<GutterMarker>;
        },
        initialSpacer: () => new SpacerMarker(),
        renderEmptyElements: true,
        domEventHandlers: {
            mousedown: (view, block) => {
                const line = view.state.doc.lineAt(block.from).number;
                if (byLine.has(line)) callbacks.current.onMarkerClick?.(line);
                else callbacks.current.onGutterClick?.(line);
                return true;
            },
        },
    });
};

const focusLineExtension = (lineNumber: number): Extension =>
    EditorView.decorations.compute([], (state) => {
        if (lineNumber < 1 || lineNumber > state.doc.lines) return Decoration.none;
        const line = state.doc.line(lineNumber);
        return Decoration.set([Decoration.line({ class: "cm-focus-line" }).range(line.from)]);
    });

const editorTheme = EditorView.theme({
    ".cm-comment-gutter": { minWidth: "20px", cursor: "pointer" },
    ".cm-comment-gutter .cm-gutterElement": { padding: "0 3px", textAlign: "center" },
    ".cm-comment-gutter .cm-gutterElement:hover::after": {
        content: '"+"',
        color: "var(--accent)",
        fontWeight: "600",
    },
    ".cm-comment-gutter .cm-gutterElement:has(.cm-comment-marker):hover::after": {
        content: "none",
    },
    ".cm-comment-marker": {
        display: "inline-block",
        minWidth: "14px",
        height: "14px",
        lineHeight: "14px",
        borderRadius: "7px",
        fontSize: "10px",
        fontWeight: "600",
        background: "var(--accent)",
        color: "var(--accent-fg)",
        textAlign: "center",
    },
    ".cm-focus-line": { backgroundColor: "var(--warning-soft)" },
});
