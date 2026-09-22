import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, defaultHighlightStyle, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { Annotation, Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { createEffect, onCleanup, onMount } from "solid-js";
import "./code-editor.css";

export interface CodeEditorHandle {
  focus: () => void;
  readonly value: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  language?: "markdown" | "shell";
  compact?: boolean;
  autofocus?: boolean;
  ref?: (editor: CodeEditorHandle) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onPaste?: (event: ClipboardEvent) => void;
}

const externalChange = Annotation.define<boolean>();
const highlighting = HighlightStyle.define(defaultHighlightStyle.specs.map((style) => ({
  ...style,
  color: style.color ? `color-mix(in srgb, ${style.color} 45%, var(--ink))` : undefined,
})));

function inputConfiguration(props: Props) {
  return [
    EditorState.readOnly.of(Boolean(props.disabled)),
    EditorView.editable.of(!props.disabled),
    EditorView.contentAttributes.of({
      "aria-label": props.label,
      "aria-multiline": "true",
      "aria-disabled": String(Boolean(props.disabled)),
      spellcheck: String(Boolean(props.compact)),
      autocapitalize: props.compact ? "sentences" : "off",
    }),
    placeholder(props.placeholder ?? ""),
  ];
}

export function CodeEditor(props: Props) {
  let container!: HTMLDivElement;
  let view: EditorView | undefined;
  const input = new Compartment();
  const language = new Compartment();

  onMount(() => {
    view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(), drawSelection(), EditorView.lineWrapping,
          syntaxHighlighting(highlighting),
          props.compact ? [] : [lineNumbers(), bracketMatching(), indentOnInput()],
          input.of(inputConfiguration(props)),
          language.of([]),
          Prec.highest(EditorView.domEventHandlers({
            keydown: (event, editor) => {
              if (event.isComposing || editor.composing) return false;
              props.onKeyDown?.(event);
              return event.defaultPrevented;
            },
            paste: (event) => {
              props.onPaste?.(event);
              return event.defaultPrevented;
            },
            drop: (event) => Boolean(event.dataTransfer?.types.includes("Files")),
          })),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalChange))) {
              props.onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    props.ref?.({ focus: () => view?.focus(), get value() { return view?.state.doc.toString() ?? ""; } });
    if (props.autofocus) view.focus();

    createEffect(() => {
      const value = props.value;
      if (!view || value === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
      });
    });
    createEffect(() => { view?.dispatch({ effects: input.reconfigure(inputConfiguration(props)) }); });
    createEffect(() => {
      view?.dispatch({ effects: language.reconfigure(props.language === "shell" ? StreamLanguage.define(shell) : markdown()) });
    });
  });
  onCleanup(() => { view?.destroy(); view = undefined; });

  return <div ref={container} class={`code-editor${props.compact ? " code-editor-compact" : ""}`} />;
}
