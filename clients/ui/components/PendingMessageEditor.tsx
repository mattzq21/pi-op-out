import { For, Index, Show } from "solid-js";
import { FileText, Paperclip, X } from "lucide-solid";
import type { ComposerUpload, PendingMessage, PendingMessageAction } from "../types";
import type { StateUpdate } from "../lib/solid";
import { attachFiles, splitAttachedFiles, type AttachedFile } from "../lib/composerPrompt";
import { PendingImage, type PendingImageLoader } from "./PendingImages";

/** A queued message being edited: its prompt, its text files, the indexes of the images it keeps, and the files added in the editor. */
export interface PendingEdit { id: string; prompt: string; files: AttachedFile[]; keep: number[]; added: ComposerUpload[] }

/** Starts an edit with the message as it is: its text files come out of the message, so they show as attachments. */
export function startPendingEdit(message: PendingMessage): PendingEdit {
  const { prompt, files } = splitAttachedFiles(message.message);

  return { id: message.id, prompt, files, keep: (message.images ?? []).map((_image, index) => index), added: [] };
}

/** The edit action for the daemon: the message with its text files, and the images to keep and to add. */
export function pendingEditAction(edit: PendingEdit): Extract<PendingMessageAction, { type: "edit" }> {
  const addedFiles = edit.added.flatMap(upload => upload.kind === "text" ? [{ name: upload.name, text: upload.text ?? "" }] : []);
  const addedImages = edit.added.flatMap(upload => upload.image ? [upload.image] : []);

  return { type: "edit", message: attachFiles(edit.prompt, [...edit.files, ...addedFiles]), images: { keep: edit.keep, add: addedImages } };
}

interface Props {
  message: PendingMessage;
  edit: PendingEdit;
  saving: boolean;
  load?: PendingImageLoader;
  onChange: (update: (edit: PendingEdit) => PendingEdit) => void;
  /** Reads files into uploads with the composer's limits, and writes them with commit. */
  addFiles: (files: File[], commit: (update: StateUpdate<ComposerUpload[]>) => void) => Promise<void>;
  onSave: () => void;
  onCancel: () => void;
}

/** Edits the text, images and text files of a queued message. Files can be attached with the button or pasted into the text. */
export function PendingMessageEditor(props: Props) {
  let input: HTMLInputElement | undefined;
  const commit = (update: StateUpdate<ComposerUpload[]>) => props.onChange(edit => ({ ...edit, added: typeof update === "function" ? update(edit.added) : update }));
  const add = (files: FileList | null) => { if (files?.length) void props.addFiles([...files], commit); };
  const label = () => props.edit.prompt.split("\n", 1)[0] || "attachments";

  return <div class="pending-editor">
    <textarea class="pending-edit" aria-label={`Edit queued message: ${label()}`} rows={Math.min(6, Math.max(1, props.edit.prompt.split("\n").length))} value={props.edit.prompt} disabled={props.saving}
      ref={element => queueMicrotask(() => { if (element.isConnected) { element.focus(); element.setSelectionRange(element.value.length, element.value.length); } })}
      onInput={event => { const prompt = event.currentTarget.value; props.onChange(edit => ({ ...edit, prompt })); }}
      onPaste={event => { const files = event.clipboardData?.files; if (files?.length) { event.preventDefault(); add(files); } }}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); props.onSave(); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onCancel(); }
      }} />
    <div class="pending-edit-attachments" aria-label="Attachments of the edited message">
      <Index each={props.edit.keep}>{index => <span class="pending-edit-attachment">
        <PendingImage message={props.message} index={index()} load={props.load} />
        <button type="button" class="pending-icon-button" disabled={props.saving} aria-label={`Remove ${props.message.images?.[index()]?.name ?? "image"}`} onClick={() => props.onChange(edit => ({ ...edit, keep: edit.keep.filter(kept => kept !== index()) }))}><X size={11} /></button>
      </span>}</Index>
      <For each={props.edit.files}>{file => <span class="pending-edit-attachment">
        <FileText size={12} /><b>{file.name}</b>
        <button type="button" class="pending-icon-button" disabled={props.saving} aria-label={`Remove ${file.name}`} onClick={() => props.onChange(edit => ({ ...edit, files: edit.files.filter(item => item !== file) }))}><X size={11} /></button>
      </span>}</For>
      <For each={props.edit.added}>{upload => <span class="pending-edit-attachment">
        <Show when={upload.image} fallback={<FileText size={12} />}>{image => <img class="pending-image" src={`data:${image().mimeType};base64,${image().data}`} alt={upload.name} />}</Show><b>{upload.name}</b>
        <button type="button" class="pending-icon-button" disabled={props.saving} aria-label={`Remove ${upload.name}`} onClick={() => props.onChange(edit => ({ ...edit, added: edit.added.filter(item => item.id !== upload.id) }))}><X size={11} /></button>
      </span>}</For>
      <button type="button" class="pending-icon-button" disabled={props.saving} aria-label="Attach files to the edited message" data-tooltip="Attach files" onClick={() => input?.click()}><Paperclip size={13} /></button>
      <input ref={element => { input = element; }} type="file" multiple hidden onChange={event => { add(event.currentTarget.files); event.currentTarget.value = ""; }} />
    </div>
  </div>;
}
