import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type SetStateAction } from "react";
import { ArrowUp, CircleStop, FileText, ImagePlus, Paperclip, Pause, Play, TerminalSquare, X } from "lucide-react";
import type { AgentProfile, ComposerUpload, ContextUsage, ImageAttachment, Model, PromptDictionary, SequenceProfile, SlashCommand } from "../types";
import { applyDictionary, dictionaryMatches } from "../lib/dictionaries";
import { IconButton } from "./IconButton";

interface Props {
  streaming: boolean;
  paused?: boolean;
  pausing?: boolean;
  queued: number;
  commands: SlashCommand[];
  agents: AgentProfile[];
  sequences: SequenceProfile[];
  activeAgent?: string;
  dictionaries?: PromptDictionary[];
  models: Model[];
  model: Model | null;
  thinkingLevel: string;
  thinkingLevels: string[];
  sessionCache?: { rate: number; low: boolean; cachedTokens: number; promptTokens: number };
  contextUsage?: ContextUsage;
  controlsDisabled?: boolean;
  draft?: string;
  onDraftChange?: (value: string) => void;
  uploads?: ComposerUpload[];
  onUploadsChange?: (uploads: SetStateAction<ComposerUpload[]>) => void;
  restoredDraft?: { id: string; value: string };
  focusRequest?: number;
  onSend: (message: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void | boolean | Promise<void | boolean>;
  onAbort: () => void | Promise<void>;
  onPause: () => void | Promise<void>;
  onResume: () => void | Promise<void>;
  onOpenTerminal?: () => void;
  onAgent: (name: string) => void;
  onModel: (model: Model) => void;
  onThinking: (level: string) => void;
}

const TEXT_LIMIT = 200_000;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const TOTAL_UPLOAD_LIMIT = 24 * 1024 * 1024;
const UPLOAD_COUNT_LIMIT = 12;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_MIME_TYPES = new Set(["application/json", "application/xml", "application/javascript", "application/typescript", "application/x-sh", "application/x-yaml", "application/toml"]);
const TEXT_EXTENSIONS = /\.(?:txt|md|mdx|json|jsonl|ya?ml|toml|xml|csv|tsv|js|jsx|ts|tsx|css|scss|html?|py|rs|go|java|kt|kts|c|cc|cpp|cxx|h|hpp|sh|bash|zsh|fish|sql|graphql|gql|ini|conf|env|log)$/i;
const COMPOSER_MAX_HEIGHT = 130;
const DICTIONARY_HIGHLIGHT_LIMIT = 1_000;
const displayModelName = (model: Model) => (model.name || model.id).replace(/^gpt-/i, "");
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
const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);

export function Composer({ streaming, paused = false, pausing = false, queued, commands, agents, sequences, activeAgent, dictionaries = [], models, model, thinkingLevel, thinkingLevels, sessionCache, contextUsage, controlsDisabled = false, draft, onDraftChange, uploads: controlledUploads, onUploadsChange, restoredDraft, focusRequest, onSend, onAbort, onPause, onResume, onOpenTerminal, onAgent, onModel, onThinking }: Props) {
  const [localValue, setLocalValue] = useState("");
  const value = draft ?? localValue;
  const setValue = (next: string) => { if (onDraftChange) onDraftChange(next); else setLocalValue(next); };
  const [localUploads, setLocalUploads] = useState<ComposerUpload[]>([]);
  const uploads = controlledUploads ?? localUploads;
  const updateUploads = (update: ComposerUpload[] | ((current: ComposerUpload[]) => ComposerUpload[])) => {
    if (onUploadsChange) onUploadsChange(update); else setLocalUploads(update);
  };
  const [uploadError, setUploadError] = useState<string>();
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [controlAction, setControlAction] = useState<"pause" | "resume">();
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [controlError, setControlError] = useState<string>();
  const controlActionRef = useRef(false);
  const controlPending = Boolean(controlAction) || pausing || stopping;
  const inputDisabled = controlsDisabled || controlPending;
  const stopDisabled = controlsDisabled || stopping || controlAction === "resume";
  const [selectedMatch, setSelectedMatch] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [editorScrollTop, setEditorScrollTop] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const restoredDraftId = useRef<string | undefined>(undefined);
  const commandQuery = value.match(/^\/([^\s]*)$/)?.[1]?.toLowerCase();
  const skillQuery = commandQuery === undefined ? skillReference(value) : undefined;
  const dictionaryHighlights = useMemo(() => dictionaryMatches(value, dictionaries, DICTIONARY_HIGHLIGHT_LIMIT), [value, dictionaries]);
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
    const resize = () => resizeEditor();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { if (focusRequest) ref.current?.focus(); }, [focusRequest]);
  useEffect(() => { if (restoredDraft && restoredDraft.id !== restoredDraftId.current) { restoredDraftId.current = restoredDraft.id; setValue(restoredDraft.value); } }, [restoredDraft]);

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    setUploadError(undefined);
    const next: ComposerUpload[] = [];
    const errors: string[] = [];
    let totalBytes = uploads.reduce((total, upload) => total + upload.byteSize, 0);
    for (const file of Array.from(files)) {
      if (uploads.length + next.length >= UPLOAD_COUNT_LIMIT) { errors.push(`Only ${UPLOAD_COUNT_LIMIT} attachments are allowed`); break; }
      if (file.size + totalBytes > TOTAL_UPLOAD_LIMIT) { errors.push(`${file.name} exceeds the 24 MB attachment limit`); continue; }
      if (file.type.startsWith("image/")) {
        if (!SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) { errors.push(`${file.name} uses an unsupported image format`); continue; }
        if (file.size > IMAGE_LIMIT) { errors.push(`${file.name} is larger than 10 MB`); continue; }
        const url = await readFile(file, "dataUrl");
        next.push({ id: crypto.randomUUID(), name: file.name, kind: "image", byteSize: file.size, image: { type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: file.type || "image/png", name: file.name } });
      } else {
        if (!(file.type.startsWith("text/") || TEXT_MIME_TYPES.has(file.type.toLowerCase()) || TEXT_EXTENSIONS.test(file.name))) { errors.push(`${file.name} is not a supported text file`); continue; }
        if (file.size > TEXT_LIMIT) { errors.push(`${file.name} is larger than 200 KB`); continue; }
        const text = await readFile(file, "text");
        if (text.includes("\0") || text.includes("�")) { errors.push(`${file.name} does not contain valid text`); continue; }
        next.push({ id: crypto.randomUUID(), name: file.name, kind: "text", byteSize: file.size, text });
      }
      totalBytes += file.size;
    }
    updateUploads((current) => {
      const accepted: ComposerUpload[] = [];
      let currentBytes = current.reduce((total, upload) => total + upload.byteSize, 0);
      for (const upload of next) {
        if (current.length + accepted.length >= UPLOAD_COUNT_LIMIT) { errors.push(`Only ${UPLOAD_COUNT_LIMIT} attachments are allowed`); break; }
        if (currentBytes + upload.byteSize > TOTAL_UPLOAD_LIMIT) { errors.push(`${upload.name} exceeds the 24 MB attachment limit`); continue; }
        accepted.push(upload); currentBytes += upload.byteSize;
      }
      if (errors.length) setUploadError([...new Set(errors)].join(". "));
      return [...current, ...accepted];
    });
  };
  const submit = async (behavior: "steer" | "followUp" = "followUp") => {
    if (controlsDisabled || pausing || controlActionRef.current || stoppingRef.current) return;
    const textFiles = uploads.filter((upload) => upload.kind === "text");
    const message = [expandSkillReference(applyDictionary(value.trim(), dictionaries), commands), ...textFiles.map((file) => `<file name="${escapeAttribute(file.name)}">\n${file.text}\n</file>`)].filter(Boolean).join("\n\n");
    const images = uploads.flatMap((upload) => upload.image ? [upload.image] : []);
    if (!message && !images.length) return;
    if (sendingRef.current) return;
    sendingRef.current = true; setSending(true); setUploadError(undefined);
    try {
      const accepted = await onSend(message || "Describe the attached image.", streaming ? behavior : undefined, images);
      if (accepted === false) return;
      setValue(""); updateUploads([]);
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : String(reason));
    } finally { sendingRef.current = false; setSending(false); }
  };
  const control = async (action: "pause" | "resume" | "abort") => {
    if (action === "abort") {
      if (controlsDisabled || stoppingRef.current || controlAction === "resume") return;
      stoppingRef.current = true; setStopping(true); setControlError(undefined);
      try { await onAbort(); }
      catch (reason) { setControlError(reason instanceof Error ? reason.message : String(reason)); }
      finally { stoppingRef.current = false; setStopping(false); }
      return;
    }
    if (controlsDisabled || pausing || controlActionRef.current || stoppingRef.current) return;
    controlActionRef.current = true; setControlAction(action); setControlError(undefined);
    try { await (action === "pause" ? onPause() : onResume()); }
    catch (reason) { setControlError(reason instanceof Error ? reason.message : String(reason)); }
    finally { controlActionRef.current = false; setControlAction(undefined); }
  };
  const chooseCommand = (command: SlashCommand) => {
    const name = skillName(command);
    if (skillQuery !== undefined && name) setValue(value.replace(/\$[a-zA-Z0-9_-]*$/, `$${name} `));
    else setValue(`/${command.name} `);
    ref.current?.focus();
  };

  return <div className="composer-wrap">
    {(streaming || paused || pausing) && <div className={`stream-banner${paused ? " paused" : ""}`}>
      <span className="stream-status" role="status">{paused ? <Pause size={11} /> : <span className="pulse" />}{stopping ? "Stopping…" : controlAction === "resume" ? "Resuming…" : pausing || controlAction === "pause" ? "Pausing…" : paused ? "Paused · Completed turns saved" : "Pi is working"}{queued > 0 && ` · ${queued} queued`}</span>
    </div>}
    <div ref={composerRef} className="composer">
      {matches.length > 0 && <div className="command-palette" role="listbox" aria-label={skillQuery === undefined ? "Pi commands" : "Pi skills"}>{matches.map((command, index) => <button role="option" aria-selected={index === selectedMatch} key={`${command.source}:${command.name}`} type="button" onMouseEnter={() => setSelectedMatch(index)} onClick={() => chooseCommand(command)}><span><strong>{skillQuery !== undefined ? `$${skillName(command)}` : `/${command.name}`}</strong><small>{command.description || `${command.source} command`}</small></span><em>{command.source}</em></button>)}</div>}
      {uploads.length > 0 && <div className="attachments">{uploads.map((upload) => <span key={upload.id}>{upload.kind === "image" ? <ImagePlus size={12} /> : <FileText size={12} />}<b>{upload.name}</b><button aria-label={`Remove ${upload.name}`} onClick={() => { updateUploads((current) => current.filter((item) => item.id !== upload.id)); setUploadError(undefined); }}><X size={11} /></button></span>)}</div>}
      {uploadError && <div className="upload-error" role="alert">{uploadError}</div>}
      {controlError && <div className="upload-error" role="alert">{controlError}</div>}
      <div className={`composer-editor${dictionaryHighlights.length ? " has-dictionary-matches" : ""}`}>
        {dictionaryHighlights.length > 0 && <div className="composer-highlight-viewport" aria-hidden="true"><div className="composer-highlight-layer" style={{ transform: `translateY(-${editorScrollTop}px)` }}>{dictionaryHighlights.map((match, index) => <span key={`${match.start}-${match.end}`}><span>{value.slice(index ? dictionaryHighlights[index - 1].end : 0, match.start)}</span><mark title={match.replacement} onPointerDown={(event) => { event.preventDefault(); ref.current?.focus(); ref.current?.setSelectionRange(match.start, match.end); }}>{value.slice(match.start, match.end)}</mark></span>)}<span>{value.slice(dictionaryHighlights.at(-1)?.end ?? 0)}</span></div></div>}
        <textarea ref={ref} aria-label="Message Pi" disabled={controlsDisabled} placeholder={controlsDisabled ? "Connecting to Pi…" : paused ? "Send a message to continue Pi…" : streaming ? "Queue a follow-up…" : "Ask Pi to build, explain, or change anything…"} value={value} rows={1} onScroll={(event) => setEditorScrollTop(event.currentTarget.scrollTop)} onChange={(event) => { setPaletteDismissed(false); setValue(event.target.value); }} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Escape" && matches.length) { event.preventDefault(); event.stopPropagation(); setPaletteDismissed(true); } else if (matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setSelectedMatch((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length); } else if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey && !event.ctrlKey && matches[selectedMatch]) { event.preventDefault(); chooseCommand(matches[selectedMatch]); } else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void submit(event.ctrlKey ? "steer" : "followUp"); } }} />
      </div>
      <input ref={fileRef} className="hidden-input" type="file" multiple accept="text/*,.md,.mdx,.json,.jsonl,.yaml,.yml,.toml,.xml,.csv,.tsv,.js,.jsx,.ts,.tsx,.css,.scss,.html,.py,.rs,.go,.java,.kt,.c,.cc,.cpp,.h,.hpp,.sh,.sql,.graphql,.ini,.conf,.env,.log,image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void addFiles(files); }} />
      <div className="composer-bar"><div className="composer-tools"><IconButton label="Attach files" disabled={controlsDisabled} onClick={() => fileRef.current?.click()}><Paperclip size={17} /></IconButton>{onOpenTerminal && <IconButton label="Open terminal" disabled={controlsDisabled} onClick={onOpenTerminal}><TerminalSquare size={17} /></IconButton>}{contextUsage && <ContextWheel usage={contextUsage} />}{sessionCache && <span className={`session-cache-hit${sessionCache.low ? " low" : ""}`} title={`${sessionCache.cachedTokens.toLocaleString()} of ${sessionCache.promptTokens.toLocaleString()} session prompt tokens read from cache`}>Cache {sessionCache.rate}%</span>}</div>
        <div className="composer-actions">
        <ContainedPicker label="Agent" value={activeAgent ?? "default"} disabled={streaming || inputDisabled} menuWidth={120} centered options={[...(agents.length ? agents : [{ name: "default" }]).map((agent) => ({ value: agent.name, label: agent.name, detail: "Agent" })), ...sequences.map((sequence) => ({ value: sequence.name, label: sequence.name, detail: "Sequence" })), { value: "final-only", label: "final-only", detail: "Multi-agent" }, { value: "own+final", label: "own+final", detail: "Multi-agent" }]} onChange={onAgent} />
        <ContainedPicker label="Model" value={model ? `${model.provider}/${model.id}` : ""} disabled={streaming || inputDisabled} options={models.map((item) => ({ value: `${item.provider}/${item.id}`, label: displayModelName(item), detail: item.provider }))} onChange={(value) => { const next = models.find((item) => `${item.provider}/${item.id}` === value); if (next) onModel(next); }} />
        <ContainedPicker label="Thinking level" value={thinkingLevel} disabled={streaming || inputDisabled} menuWidth={120} centered compact options={thinkingLevels.map((level) => ({ value: level, label: level }))} onChange={onThinking} />
        <span className="composer-divider" />
        {(streaming || paused || pausing) && <><IconButton label={paused ? "Resume Pi" : "Pause Pi"} disabled={inputDisabled} onClick={() => void control(paused ? "resume" : "pause")}>{paused ? <Play size={17} /> : <Pause size={17} />}</IconButton><IconButton label="Stop Pi" className="stop-compact" disabled={stopDisabled} onClick={() => void control("abort")}><CircleStop size={17} /></IconButton></>}<IconButton label={streaming ? "Queue follow-up" : "Send message"} title={streaming ? "Queue follow-up (Enter) · Steer (Ctrl+Enter)" : "Send message (Enter)"} className="send" disabled={inputDisabled || sending || (!value.trim() && uploads.length === 0)} onClick={() => void submit()}><ArrowUp size={18} /></IconButton></div>
      </div>
    </div>
  </div>;
}

type PickerOption = { value: string; label: string; detail?: string; disabled?: boolean };

function ContainedPicker({ label, value, options, disabled, menuWidth = 200, centered = false, compact = false, onChange }: { label: string; value: string; options: PickerOption[]; disabled?: boolean; menuWidth?: number; centered?: boolean; compact?: boolean; onChange: (value: string) => void }) {
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const [activeIndex, setActiveIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const optionChosenRef = useRef(false);
  const selectedOption = options.find((option) => option.value === value);
  const close = () => setMenuStyle(undefined);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  const toggle = () => {
    if (menuStyle) return close();
    optionChosenRef.current = false;
    const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
    const width = Math.min(menuWidth, window.innerWidth - 16);
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
    const index = Math.max(0, selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled));
    setActiveIndex(index);
    setMenuStyle({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + 6, width, maxHeight: Math.max(0, rect.top - 14) });
    requestAnimationFrame(() => optionRefs.current[index]?.focus());
  };
  useEffect(() => {
    if (!menuStyle) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", dismiss); window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", dismiss); window.removeEventListener("resize", close); };
  }, [menuStyle]);
  const move = (direction: 1 | -1) => {
    if (!options.some((option) => !option.disabled)) return;
    let next = activeIndex;
    for (let count = 0; count < options.length; count += 1) { next = (next + direction + options.length) % options.length; if (!options[next].disabled) break; }
    setActiveIndex(next); optionRefs.current[next]?.focus();
  };
  return <div ref={root} className="composer-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus(); } else if (menuStyle && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); } }}>
    <button ref={trigger} type="button" className="select-control composer-picker-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={Boolean(menuStyle)} data-value={value} data-options={options.map((option) => option.value).join(" ")} title={selectedOption?.label} disabled={disabled} onClick={toggle}>{selectedOption?.label || label}</button>
    {menuStyle && <div className={`composer-picker-menu${centered ? " centered" : ""}${compact ? " compact" : ""}`} role="listbox" aria-label={`${label} options`} style={menuStyle}>{options.map((option, index) => <button ref={(element) => { optionRefs.current[index] = element; }} key={`${option.detail ?? label}:${option.value}`} type="button" role="option" aria-selected={option.value === value} tabIndex={index === activeIndex ? 0 : -1} data-value={option.value} disabled={disabled || option.disabled} onFocus={() => setActiveIndex(index)} onClick={() => { if (disabled || optionChosenRef.current) return; optionChosenRef.current = true; onChange(option.value); close(); trigger.current?.focus(); }}><span>{option.label}</span>{option.detail && <small>{option.detail}</small>}</button>)}</div>}
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
