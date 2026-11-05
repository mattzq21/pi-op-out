import { For, Index, Show } from "solid-js";
import { FileText, X } from "lucide-solid";
import type { ComposerUpload, PendingMessage, PendingMessageAction } from "../types";
import { attachFiles, splitAttachedFiles, type AttachedFile } from "../lib/composerPrompt";
import { PendingImagePreview, type PendingImageLoader } from "./PendingImages";
import { ZoomableImage } from "./ZoomableImage";

export interface PendingEdit { id: string; prompt: string; files: AttachedFile[]; keep: number[]; added: ComposerUpload[] }

export function startPendingEdit(message: PendingMessage): PendingEdit {
  const { prompt, files } = splitAttachedFiles(message.message);

  return { id: message.id, prompt, files, keep: (message.images ?? []).map((_image, index) => index), added: [] };
}

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
}

export function PendingMessageAttachments(props: Props) {
  return (
    <Show when={props.edit.keep.length + props.edit.files.length + props.edit.added.length > 0}><div class="attachments" aria-label="Attachments of the edited message">
      <Index each={props.edit.keep}>{index => <span class="attachment-image">
        <PendingImagePreview message={props.message} index={index()} load={props.load} />
        <button type="button" disabled={props.saving} aria-label={`Remove ${props.message.images?.[index()]?.name ?? "image"}`} onClick={() => { const removed = index(); props.onChange(edit => ({ ...edit, keep: edit.keep.filter(kept => kept !== removed) })); }}><X size={11} /></button>
      </span>}</Index>
      <For each={props.edit.files}>{file => <span>
        <FileText size={12} /><b>{file.name}</b>
        <button type="button" disabled={props.saving} aria-label={`Remove ${file.name}`} onClick={() => props.onChange(edit => ({ ...edit, files: edit.files.filter(item => item !== file) }))}><X size={11} /></button>
      </span>}</For>
      <For each={props.edit.added}>{upload => <span classList={{ "attachment-image": Boolean(upload.image) }}>
        <Show when={upload.image} fallback={<><FileText size={12} /><b>{upload.name}</b></>}>{image => <ZoomableImage src={`data:${image().mimeType};base64,${image().data}`} alt={upload.name} />}</Show>
        <button type="button" disabled={props.saving} aria-label={`Remove ${upload.name}`} onClick={() => props.onChange(edit => ({ ...edit, added: edit.added.filter(item => item.id !== upload.id) }))}><X size={11} /></button>
      </span>}</For>
    </div></Show>
  );
}
