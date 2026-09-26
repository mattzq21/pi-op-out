import { createEffect, on } from "solid-js";
import type { FileReference } from "../lib/projectFiles";

interface Props {
  value: string;
  filename: string;
  disabled?: boolean;
  location?: FileReference;
  onChange: (value: string) => void;
  onSave: () => void;
}

export function CodeEditor(props: Props) {
  let editor!: HTMLTextAreaElement;
  const newline = props.value.includes("\r\n") ? "\r\n" : "\n";
  createEffect(on(() => props.location, location => {
    if (!location) return;
    const lines = editor.value.split("\n");
    const line = Math.max(0, Math.min(lines.length - 1, (location.line || 1) - 1));
    const offset = lines.slice(0, line).reduce((length, text) => length + text.length + 1, 0)
      + Math.min(lines[line].length, Math.max(0, (location.column || 1) - 1));
    editor.focus();
    editor.setSelectionRange(offset, offset);
    editor.scrollTop = Math.max(0, line * parseFloat(getComputedStyle(editor).lineHeight) - editor.clientHeight / 2);
  }));
  return <textarea ref={editor} class="file-text-editor" aria-label={`Edit ${props.filename}`} spellcheck={false} wrap="off" value={props.value} readOnly={props.disabled}
    onInput={event => props.onChange(event.currentTarget.value.replace(/\r?\n/g, newline))}
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); event.stopPropagation();
        if (!props.disabled) props.onSave();
      }
    }} />;
}
