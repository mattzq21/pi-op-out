import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, CircleStop, FileText, ImagePlus, Paperclip, TerminalSquare, X } from "lucide-react";
import type { AgentProfile, ContextUsage, ImageAttachment, Model, SequenceProfile, SlashCommand } from "../types";
import { IconButton } from "./IconButton";

type Upload = { id: string; name: string; kind: "image" | "text"; image?: ImageAttachment; text?: string };
interface Props {
  streaming: boolean;
  queued: number;
  commands: SlashCommand[];
  agents: AgentProfile[];
  sequences: SequenceProfile[];
  activeAgent?: string;
  models: Model[];
  model: Model | null;
  thinkingLevel: string;
  thinkingLevels: string[];
  sessionCache?: { rate: number; low: boolean; cachedTokens: number; promptTokens: number };
  contextUsage?: ContextUsage;
  draft?: string;
  onDraftChange?: (value: string) => void;
  restoredDraft?: { id: string; value: string };
  onSend: (message: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void;
  onAbort: () => void;
  onOpenTerminal?: () => void;
  onAgent: (name: string) => void;
  onModel: (model: Model) => void;
  onThinking: (level: string) => void;
}

const TEXT_LIMIT = 200_000;
const COMPOSER_MAX_HEIGHT = 130;
const skillName = (command: SlashCommand) => command.source === "skill" ? command.name.replace(/^skill:/, "") : undefined;
const skillReference = (value: string) => value.match(/(?:^|[\s([{])\$([a-zA-Z0-9_-]*)$/)?.[1]?.toLowerCase();
function expandSkillReference(value: string, commands: SlashCommand[]) {
  if (value.startsWith("/")) return value;
  const skills = new Map(commands.flatMap((command) => { const name = skillName(command); return name ? [[name.toLowerCase(), name] as const] : []; }));
  const reference = /(^|[^a-zA-Z0-9_$])\$([a-zA-Z0-9][a-zA-Z0-9_-]*)\b/g;
  for (const match of value.matchAll(reference)) {
    const name = skills.get(match[2].toLowerCase()); if (!name || match.index === undefined) continue;
    const tokenStart = match.index + match[1].length; const tokenEnd = tokenStart + match[0].length - match[1].length;
    const before = value.slice(0, tokenStart).replace(/\s+$/, " "); const after = value.slice(tokenEnd).replace(/^\s+/, "");
    const message = `${before}${after}`.trim();
    return `/skill:${name}${message ? ` ${message}` : ""}`;
  }
  return value;
}
const readFile = (file: File, mode: "text" | "dataUrl") => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
  if (mode === "dataUrl") reader.readAsDataURL(file); else reader.readAsText(file);
});

export function Composer({ streaming, queued, commands, agents, sequences, activeAgent, models, model, thinkingLevel, thinkingLevels, sessionCache, contextUsage, draft, onDraftChange, restoredDraft, onSend, onAbort, onOpenTerminal, onAgent, onModel, onThinking }: Props) {
  const [localValue, setLocalValue] = useState("");
  const value = draft ?? localValue;
  const setValue = (next: string) => { if (onDraftChange) onDraftChange(next); else setLocalValue(next); };
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [behavior, setBehavior] = useState<"steer" | "followUp">("steer");
  const [uploadError, setUploadError] = useState<string>();
  const [selectedMatch, setSelectedMatch] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const restoredDraftId = useRef<string | undefined>(undefined);
  const setValueRef = useRef(setValue); setValueRef.current = setValue;
  const commandQuery = value.match(/^\/([^\s]*)$/)?.[1]?.toLowerCase();
  const skillQuery = commandQuery === undefined ? skillReference(value) : undefined;
  const matches = useMemo(() => paletteDismissed ? [] : commandQuery !== undefined
    ? commands.filter((command) => command.name.toLowerCase().includes(commandQuery)).slice(0, 7)
    : skillQuery !== undefined
      ? commands.filter((command) => skillName(command)?.toLowerCase().includes(skillQuery)).slice(0, 7)
      : [], [commandQuery, skillQuery, commands, paletteDismissed]);
  useEffect(() => setSelectedMatch(0), [commandQuery, skillQuery, matches.length]);
  useEffect(() => setPaletteDismissed(false), [value]);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => { if (!composerRef.current?.contains(event.target as Node)) setPaletteDismissed(true); };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, []);

  const resizeEditor = () => {
    const editor = ref.current; if (!editor) return;
    editor.style.height = "auto";
    const contentHeight = Math.max(editor.scrollHeight, 31);
    editor.style.height = `${Math.min(contentHeight, COMPOSER_MAX_HEIGHT)}px`;
    editor.style.overflowY = contentHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  };
  useLayoutEffect(resizeEditor, [value]);

  useEffect(() => {
    const setEditor = (event: Event) => { setValueRef.current((event as CustomEvent<string>).detail); ref.current?.focus(); };
    const focusComposer = () => ref.current?.focus();
    const resize = () => resizeEditor();
    window.addEventListener("pi:set-editor-text", setEditor); window.addEventListener("pi:focus-composer", focusComposer);
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("pi:set-editor-text", setEditor); window.removeEventListener("pi:focus-composer", focusComposer); window.removeEventListener("resize", resize); };
  }, []);
  useEffect(() => { if (restoredDraft && restoredDraft.id !== restoredDraftId.current) { restoredDraftId.current = restoredDraft.id; setValue(restoredDraft.value); } }, [restoredDraft]);

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    setUploadError(undefined);
    const next: Upload[] = [];
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        const url = await readFile(file, "dataUrl");
        next.push({ id: `${file.name}-${file.lastModified}`, name: file.name, kind: "image", image: { type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: file.type || "image/png", name: file.name } });
      } else {
        if (file.size > TEXT_LIMIT) { setUploadError(`${file.name} is larger than 200 KB`); continue; }
        next.push({ id: `${file.name}-${file.lastModified}`, name: file.name, kind: "text", text: await readFile(file, "text") });
      }
    }
    setUploads((current) => [...current, ...next].slice(0, 12));
  };
  const submit = () => {
    const textFiles = uploads.filter((upload) => upload.kind === "text");
    const message = [expandSkillReference(value.trim(), commands), ...textFiles.map((file) => `<file name="${file.name.replaceAll('"', "&quot;")}">\n${file.text}\n</file>`)].filter(Boolean).join("\n\n");
    const images = uploads.flatMap((upload) => upload.image ? [upload.image] : []);
    if (!message && !images.length) return;
    onSend(message || "Describe the attached image.", streaming ? behavior : undefined, images);
    setValue(""); setUploads([]); setUploadError(undefined);
  };
  const chooseCommand = (command: SlashCommand) => {
    const name = skillName(command);
    if (skillQuery !== undefined && name) setValue(value.replace(/\$[a-zA-Z0-9_-]*$/, `$${name} `));
    else setValue(`/${command.name} `);
    ref.current?.focus();
  };

  return <div className="composer-wrap">
    {streaming && <div className="stream-banner"><span className="pulse" />Pi is working {queued > 0 && `· ${queued} queued`}<label>Send as <select aria-label="Streaming message behavior" value={behavior} onChange={(event) => setBehavior(event.target.value as typeof behavior)}><option value="steer">Steer now</option><option value="followUp">Follow up</option></select></label><button onClick={onAbort}>Stop</button></div>}
    <div ref={composerRef} className="composer">
      {matches.length > 0 && <div className="command-palette" role="listbox" aria-label={skillQuery === undefined ? "Pi commands" : "Pi skills"}>{matches.map((command, index) => <button role="option" aria-selected={index === selectedMatch} key={`${command.source}:${command.name}`} type="button" onMouseEnter={() => setSelectedMatch(index)} onClick={() => chooseCommand(command)}><span><strong>{skillQuery !== undefined ? `$${skillName(command)}` : `/${command.name}`}</strong><small>{command.description || `${command.source} command`}</small></span><em>{command.source}</em></button>)}</div>}
      {uploads.length > 0 && <div className="attachments">{uploads.map((upload) => <span key={upload.id}>{upload.kind === "image" ? <ImagePlus size={12} /> : <FileText size={12} />}<b>{upload.name}</b><button aria-label={`Remove ${upload.name}`} onClick={() => setUploads((current) => current.filter((item) => item.id !== upload.id))}><X size={11} /></button></span>)}</div>}
      {uploadError && <div className="upload-error">{uploadError}</div>}
      <textarea ref={ref} aria-label="Message Pi" placeholder={streaming ? (behavior === "steer" ? "Steer Pi while it works…" : "Queue a follow-up…") : "Ask Pi to build, explain, or change anything…"} value={value} rows={1} onChange={(event) => { setPaletteDismissed(false); setValue(event.target.value); }} onKeyDown={(event) => { if (event.key === "Escape" && matches.length) { event.preventDefault(); setPaletteDismissed(true); } else if (matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setSelectedMatch((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length); } else if (event.key === "Tab" && !event.shiftKey && matches[selectedMatch]) { event.preventDefault(); chooseCommand(matches[selectedMatch]); } else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} />
      <input ref={fileRef} className="hidden-input" type="file" multiple onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
      <div className="composer-bar"><div className="composer-tools"><IconButton label="Attach files" onClick={() => fileRef.current?.click()}><Paperclip size={17} /></IconButton>{onOpenTerminal && <IconButton label="Open terminal" onClick={onOpenTerminal}><TerminalSquare size={17} /></IconButton>}{contextUsage && <ContextWheel usage={contextUsage} />}{sessionCache && <span className={`session-cache-hit${sessionCache.low ? " low" : ""}`} title={`${sessionCache.cachedTokens.toLocaleString()} of ${sessionCache.promptTokens.toLocaleString()} session prompt tokens read from cache`}>Cache {sessionCache.rate}%</span>}</div>
        <div className="composer-actions">
        {activeAgent !== undefined && <label className="select-control agent-select"><select aria-label="Agent" value={activeAgent} disabled={streaming} onChange={(event) => onAgent(event.target.value)}><optgroup label="Agents">{agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}</optgroup>{sequences.length > 0 && <optgroup label="Sequences">{sequences.map((sequence) => <option key={sequence.name} value={sequence.name}>{sequence.name}</option>)}</optgroup>}<optgroup label="Multi-agent"><option value="final-only">final-only</option><option value="own+final">own+final</option></optgroup></select></label>}
        <label className="select-control"><select aria-label="Model" value={model ? `${model.provider}/${model.id}` : ""} onChange={(event) => { const next = models.find((item) => `${item.provider}/${item.id}` === event.target.value); if (next) onModel(next); }}>{models.map((item) => <option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`}>{item.name || item.id}</option>)}</select></label>
        <label className="select-control thinking"><select aria-label="Thinking level" value={thinkingLevel} onChange={(event) => onThinking(event.target.value)}>{thinkingLevels.map((level) => <option key={level}>{level}</option>)}</select></label>
        <span className="composer-divider" />
        {streaming && <IconButton label="Stop Pi" className="stop-compact" onClick={onAbort}><CircleStop size={17} /></IconButton>}<IconButton label={streaming ? (behavior === "steer" ? "Send steering message" : "Queue follow-up") : "Send message"} className="send" disabled={!value.trim() && uploads.length === 0} onClick={submit}><ArrowUp size={18} /></IconButton></div>
      </div>
    </div>
  </div>;
}

function ContextWheel({ usage }: { usage: ContextUsage }) {
  const rawPercent = usage.percent ?? (usage.tokens === null ? null : usage.tokens / usage.contextWindow * 100);
  const percent = rawPercent === null ? null : Math.max(0, Math.min(100, rawPercent));
  const tooltip = `${percent === null ? "—" : `${Math.round(percent)}%`} of ${usage.contextWindow.toLocaleString()}`;
  const label = percent === null ? `Context usage unavailable; window is ${usage.contextWindow.toLocaleString()} tokens` : `${Math.round(percent)}% of ${usage.contextWindow.toLocaleString()} context tokens used`;
  return <span className="context-wheel" data-tooltip={tooltip} aria-label={label} tabIndex={0}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><circle className="context-wheel-track" cx="10" cy="10" r="7.5" /><circle className="context-wheel-value" cx="10" cy="10" r="7.5" pathLength="100" style={{ strokeDasharray: `${percent ?? 0} 100` }} /></svg>
  </span>;
}
