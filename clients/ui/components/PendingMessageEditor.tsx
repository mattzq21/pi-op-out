import { For, Index, Show } from "solid-js";
import { FileText, Paperclip, X } from "lucide-solid";
import type { ComposerUpload, PendingMessage, PendingMessageAction } from "../types";
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
  addFiles: (files: File[]) => Promise<void>;
}

export function PendingMessageAttachments(props: Props) {
  let input: HTMLInputElement | undefined;
  const add = (files: FileList | null) => { if (files?.length) void props.addFiles([...files]); };
  return (
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
  );
}
