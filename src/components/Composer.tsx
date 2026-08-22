import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, CircleStop, FileText, ImagePlus, Paperclip, TerminalSquare, X } from "lucide-react";
import type { ImageAttachment, Model, SlashCommand } from "../types";
import { IconButton } from "./IconButton";

type Upload = { id: string; name: string; kind: "image" | "text"; image?: ImageAttachment; text?: string };
interface Props {
  streaming: boolean;
  queued: number;
  commands: SlashCommand[];
  models: Model[];
  model: Model | null;
  thinkingLevel: string;
  thinkingLevels: string[];
  onSend: (message: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void;
  onAbort: () => void;
  onOpenTerminal: () => void;
  onModel: (model: Model) => void;
  onThinking: (level: string) => void;
}

const TEXT_LIMIT = 200_000;
const readFile = (file: File, mode: "text" | "dataUrl") => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
  if (mode === "dataUrl") reader.readAsDataURL(file); else reader.readAsText(file);
});

export function Composer({ streaming, queued, commands, models, model, thinkingLevel, thinkingLevels, onSend, onAbort, onOpenTerminal, onModel, onThinking }: Props) {
  const [value, setValue] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [behavior, setBehavior] = useState<"steer" | "followUp">("steer");
  const [uploadError, setUploadError] = useState<string>();
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const commandQuery = value.match(/^\/([^\s]*)$/)?.[1]?.toLowerCase();
  const matches = useMemo(() => commandQuery === undefined ? [] : commands.filter((command) => command.name.toLowerCase().includes(commandQuery)).slice(0, 7), [commandQuery, commands]);

  useEffect(() => {
    const setEditor = (event: Event) => { setValue((event as CustomEvent<string>).detail); ref.current?.focus(); };
    const focusComposer = () => ref.current?.focus();
    window.addEventListener("pi:set-editor-text", setEditor); window.addEventListener("pi:focus-composer", focusComposer);
    return () => { window.removeEventListener("pi:set-editor-text", setEditor); window.removeEventListener("pi:focus-composer", focusComposer); };
  }, []);

  const addFiles = async (files: FileList | null, imagesOnly = false) => {
    if (!files) return;
    setUploadError(undefined);
    const next: Upload[] = [];
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        const url = await readFile(file, "dataUrl");
        next.push({ id: `${file.name}-${file.lastModified}`, name: file.name, kind: "image", image: { type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: file.type || "image/png", name: file.name } });
      } else if (!imagesOnly) {
        if (file.size > TEXT_LIMIT) { setUploadError(`${file.name} is larger than 200 KB`); continue; }
        next.push({ id: `${file.name}-${file.lastModified}`, name: file.name, kind: "text", text: await readFile(file, "text") });
      }
    }
    setUploads((current) => [...current, ...next].slice(0, 12));
  };
  const submit = () => {
    const textFiles = uploads.filter((upload) => upload.kind === "text");
    const message = [value.trim(), ...textFiles.map((file) => `<file name="${file.name.replaceAll('"', "&quot;")}">\n${file.text}\n</file>`)].filter(Boolean).join("\n\n");
    const images = uploads.flatMap((upload) => upload.image ? [upload.image] : []);
    if (!message && !images.length) return;
    onSend(message || "Describe the attached image.", streaming ? behavior : undefined, images);
    setValue(""); setUploads([]); setUploadError(undefined);
  };
  const chooseCommand = (command: SlashCommand) => { setValue(`/${command.name} `); ref.current?.focus(); };

  return <div className="composer-wrap">
    {streaming && <div className="stream-banner"><span className="pulse" />Pi is working {queued > 0 && `· ${queued} queued`}<label>Send as <select aria-label="Streaming message behavior" value={behavior} onChange={(event) => setBehavior(event.target.value as typeof behavior)}><option value="steer">Steer now</option><option value="followUp">Follow up</option></select></label><button onClick={onAbort}>Stop</button></div>}
    <div className="composer">
      {matches.length > 0 && <div className="command-palette" role="listbox" aria-label="Pi commands">{matches.map((command) => <button role="option" aria-selected="false" key={`${command.source}:${command.name}`} type="button" onClick={() => chooseCommand(command)}><span><strong>/{command.name}</strong><small>{command.description || `${command.source} command`}</small></span><em>{command.source}</em></button>)}</div>}
      {uploads.length > 0 && <div className="attachments">{uploads.map((upload) => <span key={upload.id}>{upload.kind === "image" ? <ImagePlus size={12} /> : <FileText size={12} />}<b>{upload.name}</b><button aria-label={`Remove ${upload.name}`} onClick={() => setUploads((current) => current.filter((item) => item.id !== upload.id))}><X size={11} /></button></span>)}</div>}
      {uploadError && <div className="upload-error">{uploadError}</div>}
      <textarea ref={ref} aria-label="Message Pi" placeholder={streaming ? (behavior === "steer" ? "Steer Pi while it works…" : "Queue a follow-up…") : "Ask Pi to build, explain, or change anything…"} value={value} rows={1} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} />
      <input ref={fileRef} className="hidden-input" type="file" multiple onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
      <input ref={imageRef} className="hidden-input" type="file" accept="image/*" multiple onChange={(event) => { void addFiles(event.target.files, true); event.target.value = ""; }} />
      <div className="composer-bar"><div className="composer-tools"><IconButton label="Attach files" onClick={() => fileRef.current?.click()}><Paperclip size={17} /></IconButton><IconButton label="Attach image" onClick={() => imageRef.current?.click()}><ImagePlus size={17} /></IconButton><IconButton label="Mention context" onClick={() => { setValue((current) => `${current}@`); ref.current?.focus(); }}><AtSign size={17} /></IconButton><IconButton label="Open terminal" onClick={onOpenTerminal}><TerminalSquare size={17} /></IconButton></div>
        <div className="composer-actions">
        <label className="select-control"><select aria-label="Model" value={model ? `${model.provider}/${model.id}` : ""} onChange={(event) => { const next = models.find((item) => `${item.provider}/${item.id}` === event.target.value); if (next) onModel(next); }}>{models.map((item) => <option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`}>{item.name || item.id}</option>)}</select></label>
        <label className="select-control thinking"><select aria-label="Thinking level" value={thinkingLevel} onChange={(event) => onThinking(event.target.value)}>{thinkingLevels.map((level) => <option key={level}>{level}</option>)}</select></label>
        <span className="composer-divider" />
        {streaming && <IconButton label="Stop Pi" className="stop-compact" onClick={onAbort}><CircleStop size={17} /></IconButton>}<IconButton label={streaming ? (behavior === "steer" ? "Send steering message" : "Queue follow-up") : "Send message"} className="send" disabled={!value.trim() && uploads.length === 0} onClick={submit}><ArrowUp size={18} /></IconButton></div>
      </div>
    </div><p className="composer-hint">Enter to send · Shift Enter for new line · Type / for commands · Ctrl+L to focus</p>
  </div>;
}
