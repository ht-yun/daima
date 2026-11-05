import { useEffect, useRef } from "react";
import { EditorState, StateEffect, StateField, Compartment } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { EditorView, Decoration, keymap } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { java } from "@codemirror/lang-java";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Issue, Language } from "../types";

const setIssues = StateEffect.define<Issue[]>();

const issueField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setIssues)) {
        const doc = tr.state.doc;
        const ranges: Range<Decoration>[] = [];
        for (const it of e.value) {
          if (it.line < 1 || it.line > doc.lines) continue;
          ranges.push(Decoration.line({ class: "cm-issue cm-issue-" + it.severity }).range(doc.line(it.line).from));
        }
        next = Decoration.set(ranges, true);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--code-kw)" },
  { tag: tags.string, color: "var(--code-str)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--code-fn)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--code-num)" },
  { tag: tags.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [tags.className, tags.typeName, tags.namespace], color: "var(--code-type)" },
  { tag: [tags.propertyName, tags.variableName], color: "var(--code-var)" },
  { tag: tags.operator, color: "var(--code-op)" },
]);

function langExt(lang: Language) {
  if (lang === "python") return python();
  if (lang === "javascript") return javascript();
  return java();
}

const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", height: "100%", color: "var(--text)" },
  ".cm-scroller": { fontFamily: '"JetBrains Mono","Cascadia Code",Consolas,monospace', fontSize: "12.5px", lineHeight: "1.62" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--dim)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 8px", minWidth: "34px" },
  ".cm-content": { padding: "8px 0" },
  ".cm-activeLine": { backgroundColor: "rgba(109,106,240,.06)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-selectionBackground": { backgroundColor: "rgba(109,106,240,.22) !important" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
});

interface Props {
  value: string;
  language: Language;
  issues: Issue[];
  onChange: (v: string) => void;
  onRun: () => void;
  jump: { line: number; n: number } | null;
}

export default function CodeEditor({ value, language, issues, onChange, onRun, jump }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const comp = useRef(new Compartment());
  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          theme,
          syntaxHighlighting(highlight),
          issueField,
          comp.current.of(langExt(language)),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                onRunRef.current();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
      parent: host.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: comp.current.reconfigure(langExt(language)) });
  }, [language]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setIssues.of(issues) });
  }, [issues]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jump) return;
    const line = Math.min(Math.max(jump.line, 1), view.state.doc.lines);
    const info = view.state.doc.line(line);
    view.dispatch({
      selection: { anchor: info.from, head: Math.min(info.to, info.from + 1) },
      effects: EditorView.scrollIntoView(info.from, { y: "center" }),
    });
    view.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump ? jump.n : 0]);

  return <div className="editor-host" ref={host} />;
}
