import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { createEffect, onCleanup, onMount } from "solid-js";
import type { FileReference } from "../lib/projectFiles";
import "./code-editor.css";

interface Props {
  value: string;
  filename: string;
  disabled?: boolean;
  location?: FileReference;
  onChange: (value: string) => void;
  onSave: () => void;
}

const externalChange = Annotation.define<boolean>();
const highlighting = HighlightStyle.define(defaultHighlightStyle.specs.map((style) => ({
  ...style,
  color: style.color ? `color-mix(in srgb, ${style.color} 45%, var(--ink))` : undefined,
})));

function selectLocation(view: EditorView, location: FileReference) {
  const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, location.line || 1)));
  const anchor = line.from + Math.min(line.length, Math.max(0, (location.column || 1) - 1));
  view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
  view.focus();
}

export function CodeEditor(props: Props) {
  let container!: HTMLDivElement;
  let view: EditorView | undefined;
  const language = new Compartment();
  const editing = new Compartment();

  onMount(() => {
    view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(), drawSelection(), lineNumbers(), bracketMatching(), indentOnInput(),
          syntaxHighlighting(highlighting), language.of([]), editing.of([]),
          EditorState.lineSeparator.of(props.value.includes("\r\n") ? "\r\n" : "\n"),
          EditorView.contentAttributes.of({ "aria-label": `Edit ${props.filename}`, "aria-multiline": "true", spellcheck: "false" }),
          Prec.highest(keymap.of([{ key: "Mod-s", run: () => { props.onSave(); return true; }, preventDefault: true, stopPropagation: true }])),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalChange))) props.onChange(update.state.sliceDoc());
          }),
        ],
      }),
    });
    createEffect(() => {
      view?.dispatch({ effects: editing.reconfigure([EditorState.readOnly.of(Boolean(props.disabled)), EditorView.editable.of(!props.disabled)]) });
    });
    createEffect(() => {
      const value = props.value;
      if (!view || value === view.state.sliceDoc()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: [externalChange.of(true), Transaction.addToHistory.of(false)] });
    });
    createEffect(() => {
      const description = LanguageDescription.matchFilename(languages, props.filename);
      let cancelled = false;
      view?.dispatch({ effects: language.reconfigure([]) });
      if (description) void description.load().then(extension => {
        if (!cancelled) view?.dispatch({ effects: language.reconfigure(extension) });
      }).catch(() => undefined);
      onCleanup(() => { cancelled = true; });
    });
    createEffect(() => { if (view && props.location) selectLocation(view, props.location); });
  });
  onCleanup(() => { view?.destroy(); view = undefined; });
  return <div ref={container} class="code-editor" />;
}
