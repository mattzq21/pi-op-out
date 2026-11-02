import { createSignal, For, Show, onMount } from "solid-js";
import { FileText, X } from "lucide-solid";
import type { ChatMessage } from "../types";
import { sentSkillPrompt, splitAttachedFiles, type AttachedFile } from "../lib/composerPrompt";
import { isMobile } from "../lib/platform";
import { ZoomableImage } from "./ZoomableImage";

export interface SentEdit { prompt: string; files: AttachedFile[]; keep: number[] }

export type EditSentMessage = (message: ChatMessage, edit: SentEdit) => Promise<void>;

const shownImage = (part: { data?: string; mimeType?: string }) => Boolean(part.data && /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType ?? ""));

export function SentMessageEditor(props: { message: ChatMessage; text: string; onSave?: EditSentMessage; onClose: () => void }) {
  const initial = splitAttachedFiles(sentSkillPrompt(props.text)?.text ?? props.text);
  const images = (Array.isArray(props.message.content) ? props.message.content.flatMap(part => part.type === "image" ? [part] : []) : []).map((part, index) => ({ part, index }));
  const [prompt, setPrompt] = createSignal(initial.prompt);
  const [files, setFiles] = createSignal(initial.files);
  const [keep, setKeep] = createSignal(images.map(image => image.index));
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const empty = () => !prompt().trim() && files().length === 0 && keep().length === 0;
  let field: HTMLTextAreaElement | undefined;

  const fit = () => { if (!field) return; field.style.height = "auto"; field.style.height = `${field.scrollHeight}px`; };

  onMount(() => { fit(); field?.focus(); field?.setSelectionRange(field.value.length, field.value.length); });

  const cancel = () => { if (!saving()) props.onClose(); };

  const save = async () => {
    if (saving() || empty()) return;
    setSaving(true); setError(undefined);

    try {
      if (!props.onSave) throw new Error("This message can no longer be edited");
      await props.onSave(props.message, { prompt: prompt(), files: files(), keep: keep() });
      props.onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;

    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); return; }

    if (event.key === "Enter" && !event.shiftKey && (!isMobile || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); void save(); }
  };

  return <div class="sent-message-edit">
    <div class="sent-message-editor">
      <Show when={keep().length + files().length > 0}><div class="attachments" aria-label="Attachments of the edited message">
        <For each={images.filter(image => keep().includes(image.index))}>{image => <span classList={{ "attachment-image": shownImage(image.part) }}>
          <Show when={shownImage(image.part)} fallback={<b>{image.part.name ?? "Image"}</b>}><ZoomableImage src={`data:${image.part.mimeType};base64,${image.part.data}`} alt="Sent attachment" /></Show>
          <button type="button" disabled={saving()} aria-label={`Remove ${image.part.name ?? "image"}`} onClick={() => setKeep(current => current.filter(index => index !== image.index))}><X size={11} /></button>
        </span>}</For>
        <For each={files()}>{file => <span>
          <FileText size={12} /><b>{file.name}</b>
          <button type="button" disabled={saving()} aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter(item => item !== file))}><X size={11} /></button>
        </span>}</For>
      </div></Show>
      <textarea ref={element => { field = element; }} aria-label="Edited message" rows={1} value={prompt()} readOnly={saving()} onInput={event => { setPrompt(event.currentTarget.value); fit(); }} onKeyDown={onKeyDown} />
      <Show when={error()}>{reason => <div class="message-failure" role="alert">{reason()}</div>}</Show>
    </div>
    <div class="sent-message-editor-actions">
      <button type="button" disabled={saving()} onClick={cancel}>Cancel</button>
      <button type="button" class="primary" disabled={saving() || empty()} onClick={() => void save()}>{saving() ? "Sending…" : "Send"}</button>
    </div>
  </div>;
}
