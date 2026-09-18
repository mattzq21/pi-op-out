import { isMobile } from "../lib/platform";
import { HookWheel } from "./HookWheel";
import type { HookCounts } from "../lib/hookStats";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readDroppedFile } from "../lib/nativeTransport";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type SetStateAction } from "react";
import { ChevronUp, ChevronDown, CornerDownRight, MoveVertical, Trash2, ArrowUp, CircleStop, CircleX, FileText, ImagePlus, Pause, Play, TerminalSquare, X, Zap } from "lucide-react";
import type { AgentProfile, ComposerUpload, ContextUsage, ImageAttachment, Model, PromptDictionary, SlashCommand } from "../types";
import { applyDictionary, dictionaryMatches } from "../lib/dictionaries";
import { usePendingMessageDrag } from "../lib/usePendingMessageDrag";
import { IconButton } from "./IconButton";

interface Props {
  voiceControls?: ReactNode;
  streaming: boolean;
  paused?: boolean;
  pausing?: boolean;
  queued: number;
  commands: SlashCommand[];
  agents: AgentProfile[];
  activeAgent?: string;
  agentLocked?: boolean;
  dictionaries?: PromptDictionary[];
  models: Model[];
  model: Model | null;
  fastModeStatus?: string;
  thinkingLevel: string;
  thinkingLevels: string[];
  sessionHooks?: HookCounts;
  sessionCache?: { rate: number; low: boolean; cachedTokens: number; promptTokens: number };
  contextUsage?: ContextUsage;
  controlsDisabled?: boolean;
  draft?: string;
  onDraftChange?: (value: string) => void;
  uploads?: ComposerUpload[];
  onUploadsChange?: (uploads: SetStateAction<ComposerUpload[]>) => void;
  restoredDraft?: { id: string; value: string };
  focusRequest?: number;
  pendingMessages?: import("../types").PendingMessage[];
  onChangePending?: (id: string, behavior: import("../types").PendingMessageAction) => Promise<void>;
  onSend: (message: string, behavior?: "steer" | "followUp", images?: ImageAttachment[]) => void | boolean | Promise<void | boolean>;
  onAbort: () => void | Promise<void>;
  onPause: () => void | Promise<void>;
  onResume: () => void | Promise<void>;
  onOpenTerminal?: () => void;
  onAgent: (name: string) => void;
  onModel: (model: Model) => void;
  onToggleFastMode: () => void | Promise<void>;
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

export function Composer({ voiceControls, streaming, paused = false, pausing = false, queued, pendingMessages = [], onChangePending, commands, agents, activeAgent, agentLocked = false, dictionaries = [], models, model, fastModeStatus, thinkingLevel, thinkingLevels, sessionHooks, sessionCache, contextUsage, controlsDisabled = false, draft, onDraftChange, uploads: controlledUploads, onUploadsChange, restoredDraft, focusRequest, onSend, onAbort, onPause, onResume, onOpenTerminal, onAgent, onModel, onToggleFastMode, onThinking }: Props) {
  const [localValue, setLocalValue] = useState("");
  const value = draft ?? localValue;
  const fastModeEnabled = fastModeStatus === "Fast mode on";
  const fastModeSupported = fastModeEnabled || fastModeStatus === "Fast mode off";
  const [togglingFastMode, setTogglingFastMode] = useState(false);
  const togglingFastModeRef = useRef(false);
  const setValue = (next: string) => { if (onDraftChange) onDraftChange(next); else setLocalValue(next); };
  const [localUploads, setLocalUploads] = useState<ComposerUpload[]>([]);
  const uploads = controlledUploads ?? localUploads;
  const updateUploads = (update: ComposerUpload[] | ((current: ComposerUpload[]) => ComposerUpload[])) => {
    if (onUploadsChange) onUploadsChange(update); else setLocalUploads(update);
  };
  const [uploadError, setUploadError] = useState<string>();
  const [imageInputError, setImageInputError] = useState(false);
  const supportsImages = Boolean((model?.input ?? models.find((item) => item.provider === model?.provider && item.id === model?.id)?.input)?.includes("image"));
  const supportsImagesRef = useRef(supportsImages);
  useLayoutEffect(() => { supportsImagesRef.current = supportsImages; }, [supportsImages]);
  useEffect(() => { if (supportsImages) setImageInputError(false); }, [supportsImages]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [controlAction, setControlAction] = useState<"pause" | "resume">();
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [controlError, setControlError] = useState<string>();
  const toggleFastMode = async () => {
    if (togglingFastModeRef.current || controlsDisabled) return;
    togglingFastModeRef.current = true; setTogglingFastMode(true); setControlError(undefined);
    try { await onToggleFastMode(); }
    catch (reason) { setControlError(`Could not toggle Fast mode: ${reason instanceof Error ? reason.message : String(reason)}`); }
    finally { togglingFastModeRef.current = false; setTogglingFastMode(false); }
  };
  const controlActionRef = useRef(false);
  const controlPending = Boolean(controlAction) || pausing || stopping;
  const inputDisabled = controlsDisabled || controlPending;
  const stopDisabled = controlsDisabled || stopping || controlAction === "resume";
  const [selectedMatch, setSelectedMatch] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [editorScrollTop, setEditorScrollTop] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const selectedCommandRef = useRef<HTMLButtonElement>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const dragDepth = useRef(0);
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
  useLayoutEffect(() => {
    selectedCommandRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedMatch, matches]);
  useEffect(() => setPaletteDismissed(false), [value]);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => { if (!composerRef.current?.contains(event.target as Node)) setPaletteDismissed(true); };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, []);

  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files") || (isTauri() && event.dataTransfer?.types.includes("text/uri-list"))) event.preventDefault();
    };
    const clearDrag = () => { dragDepth.current = 0; setDraggingFiles(false); };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    window.addEventListener("drop", clearDrag);
    window.addEventListener("dragend", clearDrag);
    window.addEventListener("blur", clearDrag);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
      window.removeEventListener("drop", clearDrag);
      window.removeEventListener("dragend", clearDrag);
      window.removeEventListener("blur", clearDrag);
    };
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
  useEffect(() => { if (restoredDraft && restoredDraft.id !== restoredDraftId.current) { restoredDraftId.current = restoredDraft.id; if (!value) setValue(restoredDraft.value); } }, [restoredDraft]);

  const addFiles = async (files: FileList | File[] | null, initialErrors: string[] = []) => {
    if (!files) return;
    setUploadError(undefined);
    const next: ComposerUpload[] = [];
    const errors = [...initialErrors];
    let totalBytes = uploads.reduce((total, upload) => total + upload.byteSize, 0);
    for (const file of Array.from(files)) {
      if ((file.type.toLowerCase().startsWith("image/") || /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?)$/i.test(file.name)) && !supportsImagesRef.current) { setImageInputError(true); continue; }
      if (uploads.length + next.length >= UPLOAD_COUNT_LIMIT) { errors.push(`Only ${UPLOAD_COUNT_LIMIT} attachments are allowed`); break; }
      if (file.size + totalBytes > TOTAL_UPLOAD_LIMIT) { errors.push(`${file.name} exceeds the 24 MB attachment limit`); continue; }
      if (file.type.startsWith("image/")) {
        if (!SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) { errors.push(`${file.name} uses an unsupported image format`); continue; }
        if (file.size > IMAGE_LIMIT) { errors.push(`${file.name} is larger than 10 MB`); continue; }
        const url = await readFile(file, "dataUrl");
        try { const image = new Image(); image.src = url; await image.decode(); }
        catch { errors.push(`${file.name} is not a valid image`); continue; }
        next.push({ id: crypto.randomUUID(), name: file.name, kind: "image", byteSize: file.size, image: { type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: file.type || "image/png", name: file.name } });
      } else {
        if (!(file.type.startsWith("text/") || TEXT_MIME_TYPES.has(file.type.toLowerCase()) || TEXT_EXTENSIONS.test(file.name))) { errors.push(`${file.name} is not a supported text file`); continue; }
        if (file.size > TEXT_LIMIT) { errors.push(`${file.name} is larger than 200 KB`); continue; }
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
        catch { errors.push(`${file.name} does not contain valid UTF-8 text`); continue; }
        if (text.includes("\0")) { errors.push(`${file.name} does not contain valid text`); continue; }
        next.push({ id: crypto.randomUUID(), name: file.name, kind: "text", byteSize: file.size, text });
      }
      totalBytes += file.size;
    }
    updateUploads((current) => {
      const accepted: ComposerUpload[] = [];
      let currentBytes = current.reduce((total, upload) => total + upload.byteSize, 0);
      for (const upload of next) {
        if (upload.kind === "image" && !supportsImagesRef.current) { setImageInputError(true); continue; }
        if (current.length + accepted.length >= UPLOAD_COUNT_LIMIT) { errors.push(`Only ${UPLOAD_COUNT_LIMIT} attachments are allowed`); break; }
        if (currentBytes + upload.byteSize > TOTAL_UPLOAD_LIMIT) { errors.push(`${upload.name} exceeds the 24 MB attachment limit`); continue; }
        accepted.push(upload); currentBytes += upload.byteSize;
      }
      if (errors.length) setUploadError([...new Set(errors)].join(". "));
      return [...current, ...accepted];
    });
  };
  const addPaths = async (paths: string[], cancelled = () => false) => {
    const files: File[] = [];
    const errors = paths.length > UPLOAD_COUNT_LIMIT ? [`Only ${UPLOAD_COUNT_LIMIT} attachments are allowed; extra files were skipped`] : [];
    for (const path of paths.slice(0, UPLOAD_COUNT_LIMIT)) {
      if (cancelled()) return;
      try { files.push(await readDroppedFile(path)); }
      catch (reason) { errors.push(reason instanceof Error ? reason.message : String(reason)); }
    }
    if (!cancelled()) await addFiles(files, errors);
  };
  const nativeDropRef = useRef({ inputDisabled, addPaths });
  useLayoutEffect(() => { nativeDropRef.current = { inputDisabled, addPaths }; });
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed) return;
      if (payload.type === "leave") { setDraggingFiles(false); return; }
      const bounds = composerRef.current?.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio;
      const y = payload.position.y / window.devicePixelRatio;
      const inside = Boolean(bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom);
      const enabled = inside && !nativeDropRef.current.inputDisabled;
      setDraggingFiles(payload.type !== "drop" && enabled);
      if (payload.type !== "drop" || !enabled) return;
      void nativeDropRef.current.addPaths(payload.paths, () => disposed).catch((reason) => { if (!disposed) setUploadError(String(reason)); });
      ref.current?.focus();
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; })
      .catch((reason) => { if (!disposed) setUploadError(`Could not enable file drops: ${String(reason)}`); });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const [expandedPending, setExpandedPending] = useState<string>();
  const [changingPending, setChangingPending] = useState(false);
  const changePending = (id: string, action: import("../types").PendingMessageAction) => {
    if (!onChangePending) return;
    setChangingPending(true); setControlError(undefined);
    void onChangePending(id, action).catch((reason) => setControlError(reason instanceof Error ? reason.message : String(reason))).finally(() => setChangingPending(false));
  };
  const { drop: pendingDrop, begin: beginPendingDrag } = usePendingMessageDrag(pendingMessages, controlsDisabled || changingPending || pausing || !onChangePending, changePending);
  const submit = async (behavior: "steer" | "followUp" = "followUp") => {
    if (controlsDisabled || pausing || controlActionRef.current || stoppingRef.current) return;
    const textFiles = uploads.filter((upload) => upload.kind === "text");
    const message = [expandSkillReference(applyDictionary(value.trim(), dictionaries), commands), ...textFiles.map((file) => `<file name="${escapeAttribute(file.name)}">\n${file.text}\n</file>`)].filter(Boolean).join("\n\n");
    const images = uploads.flatMap((upload) => upload.image ? [upload.image] : []);
    if (images.length && !supportsImagesRef.current) { setImageInputError(true); return; }
    if (!message && !images.length) return;
    if (sendingRef.current) return;
    sendingRef.current = true; setSending(true); setUploadError(undefined);
    const submittedValue = value; const submittedUploads = uploads;
    setValue(""); updateUploads([]);
    try {
      const accepted = await onSend(message || "Describe the attached image.", streaming ? behavior : undefined, images);
      if (accepted === false) throw new Error("Message was not submitted");
    } catch (reason) {
      const newerDraft = ref.current?.value || "";
      setValue(newerDraft && newerDraft !== submittedValue ? `${submittedValue}\n\n${newerDraft}` : submittedValue);
      updateUploads((current) => [...submittedUploads.filter((item) => !current.some((other) => other.id === item.id)), ...current]);
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
    {imageInputError && <div className="image-input-toast" role="alert"><CircleX size={14} aria-hidden="true" /><span>This model does not support image inputs. Try a different model</span><button type="button" aria-label="Dismiss image input error" onClick={() => setImageInputError(false)}><X size={14} /></button></div>}
    {(streaming || paused || pausing) && <div className={`stream-banner${paused ? " paused" : ""}`}>
      <span className="stream-status" role="status">{paused ? <Pause size={11} /> : <span className="pulse" />}{stopping ? "Stopping…" : controlAction === "resume" ? "Resuming…" : pausing || controlAction === "pause" ? "Pausing…" : paused ? "Paused · Completed turns saved" : "piop is working"}{queued > 0 && ` · ${queued} queued`}</span>
    </div>}
    {pendingMessages.length > 0 && <div className="pending-messages" aria-label="Pending messages">{pendingMessages.map((message) => {
      const change = (action: import("../types").PendingMessageAction) => changePending(message.id, action);
      const disabled = controlsDisabled || changingPending || pausing;
      const peers = pendingMessages.filter((item) => !item.retry && item.behavior === message.behavior);
      const position = peers.findIndex((item) => item.id === message.id);
      return <div data-pending-id={message.id} className={`pending-message${expandedPending === message.id ? " expanded" : ""}${pendingDrop?.id === message.id ? " dragging" : ""}${pendingDrop?.targetId === message.id ? ` drop-${pendingDrop.edge}` : ""}`} key={message.id}>
        <button type="button" className="pending-icon-button pending-drag-handle" disabled={disabled || message.retry || !onChangePending || peers.length < 2} aria-label={`Drag to reorder queued message: ${message.message}`} title="Drag to reorder · Arrow keys to move" onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); change(event.key === "ArrowUp" ? "moveUp" : "moveDown"); }
        }} onPointerDown={(event) => beginPendingDrag(event, message.id)}><MoveVertical size={16} /></button>
        <span className="pending-message-text" title={message.message} onDoubleClick={() => setExpandedPending((current) => current === message.id ? undefined : message.id)}>{message.retry && <small>Not sent · </small>}{message.message}</span>
        {onChangePending && <div className="pending-message-actions">
          <div className="pending-order-actions">
            <button type="button" className="pending-icon-button" disabled={disabled || position <= 0} aria-label={`Move queued message up: ${message.message}`} title="Move earlier in this delivery queue" onClick={() => change("moveUp")}><ChevronUp size={13} /></button>
            <button type="button" className="pending-icon-button" disabled={disabled || position < 0 || position >= peers.length - 1} aria-label={`Move queued message down: ${message.message}`} title="Move later in this delivery queue" onClick={() => change("moveDown")}><ChevronDown size={13} /></button>
          </div>
          <button type="button" disabled={disabled} title={message.behavior === "steer" ? "Queue after the current response" : "Steer at the next turn"} onClick={() => change(message.retry ? message.behavior : message.behavior === "steer" ? "followUp" : "steer")}><CornerDownRight size={13} />{message.retry ? "Retry" : message.behavior === "steer" ? "Queue" : "Steer"}</button>
          <button type="button" className="pending-icon-button" disabled={disabled} aria-label={`Remove queued message: ${message.message}`} title="Remove message" onClick={() => change("remove")}><Trash2 size={13} /></button>
        </div>}
      </div>;
    })}</div>}
    <div ref={composerRef} className={`composer${draggingFiles && !inputDisabled ? " dragging-files" : ""}`}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (!files.length) return;
        event.preventDefault();
        if (inputDisabled) return;
        void addFiles(files).catch((reason) => setUploadError(reason instanceof Error ? reason.message : String(reason)));
      }}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files") && !(isTauri() && event.dataTransfer.types.includes("text/uri-list"))) return;
        event.preventDefault(); dragDepth.current += 1; setDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files") && !(isTauri() && event.dataTransfer.types.includes("text/uri-list"))) return;
        event.preventDefault(); event.dataTransfer.dropEffect = inputDisabled ? "none" : "copy";
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDraggingFiles(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files") && !(isTauri() && event.dataTransfer.types.includes("text/uri-list"))) return;
        event.preventDefault(); dragDepth.current = 0; setDraggingFiles(false);
        if (inputDisabled) return;
        const files = Array.from(event.dataTransfer.files);
        const paths = event.dataTransfer.getData("text/uri-list").split(/\r?\n/).flatMap((line) => {
          try {
            const url = new URL(line);
            return url.protocol === "file:" && (!url.hostname || url.hostname === "localhost") ? [decodeURIComponent(url.pathname)] : [];
          } catch { return []; }
        });
        void (async () => {
          if (files.length) await addFiles(files);
          else await nativeDropRef.current.addPaths(paths);
        })().catch((reason) => setUploadError(reason instanceof Error ? reason.message : String(reason)));
        ref.current?.focus();
      }}>
      {draggingFiles && !inputDisabled && <div className="composer-drop-hint" role="status">Drop files to attach</div>}
      {matches.length > 0 && <div className="command-palette" role="listbox" aria-label={skillQuery === undefined ? "piop commands" : "piop skills"}>{matches.map((command, index) => <button ref={index === selectedMatch ? selectedCommandRef : undefined} role="option" aria-selected={index === selectedMatch} key={`${command.source}:${command.name}`} type="button" onClick={() => chooseCommand(command)}><span><strong>{skillQuery !== undefined ? `$${skillName(command)}` : `/${command.name}`}</strong>{command.description && <small>{command.description}</small>}</span></button>)}</div>}
      {uploads.length > 0 && <div className="attachments">{uploads.map((upload) => <span key={upload.id}>{upload.kind === "image" ? <ImagePlus size={12} /> : <FileText size={12} />}<b>{upload.name}</b><button aria-label={`Remove ${upload.name}`} onClick={() => { updateUploads((current) => current.filter((item) => item.id !== upload.id)); setUploadError(undefined); }}><X size={11} /></button></span>)}</div>}
      {uploadError && <div className="upload-error" role="alert">{uploadError}</div>}
      {controlError && <div className="upload-error" role="alert">{controlError}</div>}
      <div className={`composer-editor${dictionaryHighlights.length ? " has-dictionary-matches" : ""}`}>
        {dictionaryHighlights.length > 0 && <div className="composer-highlight-viewport" aria-hidden="true"><div className="composer-highlight-layer" style={{ transform: `translateY(-${editorScrollTop}px)` }}>{dictionaryHighlights.map((match, index) => <span key={`${match.start}-${match.end}`}><span>{value.slice(index ? dictionaryHighlights[index - 1].end : 0, match.start)}</span><mark onPointerDown={(event) => { event.preventDefault(); ref.current?.focus(); ref.current?.setSelectionRange(match.start, match.end); }}>{value.slice(match.start, match.end)}</mark></span>)}<span>{value.slice(dictionaryHighlights.at(-1)?.end ?? 0)}</span></div></div>}
        <textarea ref={ref} aria-label="Message piop" disabled={controlsDisabled} placeholder={controlsDisabled ? "Connecting to piop…" : paused ? "Send a message to continue piop…" : streaming ? "Queue a follow-up…" : "Ask piop to build, explain, or change anything…"} value={value} rows={1} onScroll={(event) => setEditorScrollTop(event.currentTarget.scrollTop)} onChange={(event) => { setPaletteDismissed(false); setValue(event.target.value); }} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Escape" && matches.length) { event.preventDefault(); event.stopPropagation(); setPaletteDismissed(true); } else if (matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setSelectedMatch((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length); } else if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey && !event.ctrlKey && matches[selectedMatch]) { event.preventDefault(); chooseCommand(matches[selectedMatch]); } else if (event.key === "Enter" && !event.shiftKey && (!isMobile || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); void submit(event.ctrlKey ? "steer" : "followUp"); } }} />
      </div>
      <div className="composer-bar"><div className="composer-tools">{voiceControls}{onOpenTerminal && <IconButton title="" label="Open terminal" disabled={controlsDisabled} onClick={onOpenTerminal}><TerminalSquare size={17} /></IconButton>}{contextUsage && <ContextWheel usage={contextUsage} />}<HookWheel counts={sessionHooks} label="Other session hooks" />{sessionCache && <span className={`session-cache-hit${sessionCache.low ? " low" : ""}`}>Cache {sessionCache.rate}%</span>}</div>
        <div className="composer-actions">{isMobile && streaming && <button className="mobile-steer" disabled={controlsDisabled || !value.trim()} onClick={() => void submit("steer")}>Steer</button>}
        <ContainedPicker label="Agent" value={activeAgent ?? "default"} disabled={agentLocked || streaming || inputDisabled} menuWidth={120} centered options={[...(agents.length ? agents : [{ name: "default" }]).map((agent) => ({ value: agent.name, label: agent.name, detail: "Agent" }))]} onChange={onAgent} />
        {fastModeSupported && <button type="button" className={`fast-mode-indicator${fastModeEnabled ? " active" : ""}`} aria-label="Fast mode" aria-description={fastModeStatus} aria-pressed={fastModeEnabled} aria-busy={togglingFastMode} disabled={inputDisabled || togglingFastMode} onClick={() => void toggleFastMode()}><Zap size={14} strokeWidth={1.5} fill={fastModeEnabled ? "currentColor" : "none"} aria-hidden="true" /></button>}
        <ContainedPicker label="Model" selectedLabel={model ? displayModelName(model) : undefined} value={model ? `${model.provider}/${model.id}` : ""} disabled={streaming || inputDisabled} options={models.map((item) => ({ value: `${item.provider}/${item.id}`, label: displayModelName(item), detail: item.provider }))} onChange={(value) => { const next = models.find((item) => `${item.provider}/${item.id}` === value); if (next) onModel(next); }} />
        <ContainedPicker label="Thinking level" value={thinkingLevel} disabled={streaming || inputDisabled} menuWidth={120} centered compact options={thinkingLevels.map((level) => ({ value: level, label: level.charAt(0).toUpperCase() + level.slice(1) }))} onChange={onThinking} />
        <span className="composer-divider" />
        {(streaming || paused || pausing) && <IconButton title="" label="Stop piop" className="stop-compact" disabled={stopDisabled} onClick={() => void control("abort")}><CircleStop size={17} /></IconButton>}
        {(streaming || paused || pausing)
          ? <IconButton title="" label={paused ? "Resume piop" : "Pause piop"} className="send" disabled={inputDisabled} onClick={() => void control(paused ? "resume" : "pause")}>{paused ? <Play size={17} /> : <Pause size={17} />}</IconButton>
          : <IconButton title="" label="Send message" className="send" disabled={inputDisabled || sending || (!value.trim() && uploads.length === 0)} onClick={() => void submit()}><ArrowUp size={18} /></IconButton>}
        </div>
      </div>
    </div>
  </div>;
}

type PickerOption = { value: string; label: string; detail?: string; disabled?: boolean };

function ContainedPicker({ label, selectedLabel, value, options, disabled, menuWidth = 200, centered = false, compact = false, onChange }: { label: string; selectedLabel?: string; value: string; options: PickerOption[]; disabled?: boolean; menuWidth?: number; centered?: boolean; compact?: boolean; onChange: (value: string) => void }) {
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
    <button ref={trigger} type="button" className="select-control composer-picker-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={Boolean(menuStyle)} data-value={value} data-options={options.map((option) => option.value).join(" ")} disabled={disabled} onClick={toggle}>{selectedOption?.label || selectedLabel || label}</button>
    {menuStyle && <div className={`composer-picker-menu${centered ? " centered" : ""}${compact ? " compact" : ""}`} role="listbox" aria-label={`${label} options`} style={menuStyle}>{options.length === 0 && <div className="empty-small">No options available</div>}{options.map((option, index) => <button ref={(element) => { optionRefs.current[index] = element; }} key={`${option.detail ?? label}:${option.value}`} type="button" role="option" aria-selected={option.value === value} tabIndex={index === activeIndex ? 0 : -1} data-value={option.value} disabled={disabled || option.disabled} onFocus={() => setActiveIndex(index)} onClick={() => { if (disabled || optionChosenRef.current) return; optionChosenRef.current = true; onChange(option.value); close(); trigger.current?.focus(); }}><span>{option.label}</span>{option.detail && <small>{option.detail}</small>}</button>)}</div>}
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
