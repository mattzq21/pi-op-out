import { createEffect, onCleanup, onMount } from "solid-js";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { liveMarkdown } from "./liveMarkdown";

export function LiveMarkdownEditor(props: { content: string; editable: boolean; visible: boolean; onChange: (value: string) => void; onSave: () => void }) {
  let parent: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let editable = props.editable;
  const permissions = new Compartment();
  const permissionExtensions = () => [EditorState.readOnly.of(!props.editable), EditorView.editable.of(props.editable)];
  const state = () => EditorState.create({ doc: props.content, extensions: [
    markdown(), liveMarkdown, history(), EditorView.lineWrapping,
    permissions.of(permissionExtensions()),
    placeholder("Write a note for this chat…"),
    EditorView.contentAttributes.of({ "aria-label": "Chat note", "aria-multiline": "true", spellcheck: "true" }),
    keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
    EditorView.domEventHandlers({ blur: () => { props.onSave(); } }),
    EditorView.updateListener.of(update => { if (update.docChanged && !update.state.readOnly) props.onChange(update.state.doc.toString()); }),
  ] });

  onMount(() => {
    view = new EditorView({ state: state(), parent });
    onCleanup(() => view?.destroy());
  });

  createEffect(() => {
    const content = props.content;
    const nextEditable = props.editable;

    if (!view) return;

    if (content !== view.state.doc.toString() || editable && !nextEditable) view.setState(state());
    else if (editable !== nextEditable) view.dispatch({ effects: permissions.reconfigure(permissionExtensions()) });
    editable = nextEditable;
  });

  createEffect(() => { if (props.visible) view?.requestMeasure(); });

  return <div ref={parent} class="notes-live-editor" />;
}
