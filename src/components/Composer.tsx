import { Key } from "@solid-primitives/keyed";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { createMemo, createSignal, Show, splitProps } from "solid-js";
import { readDroppedFile } from "../lib/nativeTransport";
import { DictationControls } from "./DictationControls";
import { isMobile } from "../lib/platform";
import { accountModelName, providerAccountLabel } from "../lib/providerAccounts";
import { createDependencyEffect, createRef, cssPixels, type CSSProperties, type JSXElement, type KeyboardEvent, type StateUpdate } from "../lib/solid";

import { ArrowUp, ChevronDown, ChevronUp, CircleStop, CircleX, CornerDownRight, FileText, ImagePlus, MoveVertical, Pause, Play, TerminalSquare, Trash2, X, Zap } from "lucide-solid";
import { hasVisibleText } from "../lib/content";
import { usePendingMessageDrag } from "../lib/usePendingMessageDrag";
import type { AgentProfile, ComposerUpload, ContextUsage, ImageAttachment, Model, SlashCommand } from "../types";
import { IconButton } from "./IconButton";

interface Props {
  voiceControls?: JSXElement;
  streaming: boolean;
  paused?: boolean;
  pausing?: boolean;
  queued: number;
  commands: SlashCommand[];
  agents: AgentProfile[];
  activeAgent?: string;
  agentLocked?: boolean;
  agentSaved?: boolean;
  agentUnavailable?: boolean;
  models: Model[];
  model: Model | null;
  fastModeStatus?: string;
  thinkingLevel: string;
  thinkingLevels: string[];
  sessionCache?: { rate: number; low: boolean; cachedTokens: number; promptTokens: number };
  contextUsage?: ContextUsage;
  controlsDisabled?: boolean;
  draft?: string;
  onDraftChange?: (value: string) => void;
  uploads?: ComposerUpload[];
  onUploadsChange?: (uploads: StateUpdate<ComposerUpload[]>) => void;
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
const displayModelName = (model: Model, models: Model[]) => accountModelName(model, models).replace(/^gpt-/i, "");
const skillName = (command: SlashCommand) => command.source === "skill" ? command.name.replace(/^skill:/, "") : undefined;
const skillReference = (value: string) => value.match(/(?:^|[\s([{])\$([a-zA-Z0-9_-]*)$/)?.[1]?.toLowerCase();
function expandSkillReference(value: string, commands: SlashCommand[]) {
  if (value.startsWith("/")) return value;
  const skills = new Map(commands.flatMap((command) => { const name = skillName(command); return name ? [[name.toLowerCase(), name] as const] : []; }));
  const reference = /(^|[^a-zA-Z0-9_$])\$([a-zA-Z0-9][a-zA-Z0-9_-]*)\b/g;
  let primary: string | undefined;
  let rest = value;
  // Expand every known $reference; the first known skill becomes the command prefix.
  for (const match of [...value.matchAll(reference)]) {
    const name = skills.get(match[2].toLowerCase());
    if (!name || match.index === undefined) continue;
    if (!primary) primary = name;
    const token = match[0].slice(match[1].length);
    const at = rest.indexOf(token);
    if (at >= 0) rest = rest.slice(0, at) + rest.slice(at + token.length);
  }
  if (!primary) return value;
  rest = rest.replace(/\s+/g, " ").trim();
  return `/skill:${primary}${rest ? ` ${rest}` : ""}`;
}
const readFile = (file: File, mode: "text" | "dataUrl") => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
  if (mode === "dataUrl") reader.readAsDataURL(file); else reader.readAsText(file);
});
const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);

function composerDefaults({ voiceControls, streaming, paused = false, pausing = false, queued, pendingMessages = [], onChangePending, commands, agents, activeAgent, agentLocked = false, agentSaved = false, agentUnavailable = false, models, model, fastModeStatus, thinkingLevel, thinkingLevels, sessionCache, contextUsage, controlsDisabled = false, draft, onDraftChange, uploads: controlledUploads, onUploadsChange, restoredDraft, focusRequest, onSend, onAbort, onPause, onResume, onOpenTerminal, onAgent, onModel, onToggleFastMode, onThinking }: Props) {
  return { voiceControls, streaming, paused, pausing, queued, pendingMessages, onChangePending, commands, agents, activeAgent, agentLocked, agentSaved, agentUnavailable, models, model, fastModeStatus, thinkingLevel, thinkingLevels, sessionCache, contextUsage, controlsDisabled, draft, onDraftChange, controlledUploads, onUploadsChange, restoredDraft, focusRequest, onSend, onAbort, onPause, onResume, onOpenTerminal, onAgent, onModel, onToggleFastMode, onThinking };
}

function modelSupportsImages(model: Props['model'], models: Model[]) {
  return Boolean((model?.input ?? models.find((item) => item.provider === model?.provider && item.id === model?.id)?.input)?.includes("image"));
}

function composerControlState(controlsDisabled: boolean, action: "pause" | "resume" | undefined, pausing: boolean, stopping: boolean) {
  const controlPending = Boolean(action) || pausing || stopping;
  return { controlPending, inputDisabled: controlsDisabled || controlPending, stopDisabled: controlsDisabled || stopping || action === "resume" };
}

function insideBounds(bounds: DOMRect | undefined, x: number, y: number) {
  return Boolean(bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom);
}

function pendingControlsDisabled(controlsDisabled: boolean, changingPending: boolean, pausing: boolean, onChangePending: Props['onChangePending']) {
  return controlsDisabled || changingPending || pausing || !onChangePending;
}

function pendingMessageClass(id: string, expanded: string | undefined, drop: ReturnType<typeof usePendingMessageDrag>['drop']) {
  return `pending-message${expanded === id ? " expanded" : ""}${drop?.id === id ? " dragging" : ""}${drop?.targetId === id ? ` drop-${drop.edge}` : ""}`;
}

function canPickCommand(event: KeyboardEvent) {
  return (event.key === "Tab" || event.key === "Enter") && !event.shiftKey && !event.ctrlKey;
}

function imageFile(file: File) {
  return file.type.toLowerCase().startsWith("image/") || /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?)$/i.test(file.name);
}

async function imageUpload(file: File, errors: string[]): Promise<ComposerUpload | undefined> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) { errors.push(`${file.name} uses an unsupported image format`); return undefined; }
  if (file.size > IMAGE_LIMIT) { errors.push(`${file.name} is larger than 10 MB`); return undefined; }
  const url = await readFile(file, "dataUrl");
  try { const image = new Image(); image.src = url; await image.decode(); }
  catch { errors.push(`${file.name} is not a valid image`); return undefined; }
  return { id: crypto.randomUUID(), name: file.name, kind: "image", byteSize: file.size, image: { type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: file.type || "image/png", name: file.name } };

}

async function textUpload(file: File, errors: string[]): Promise<ComposerUpload | undefined> {
  if (!(file.type.startsWith("text/") || TEXT_MIME_TYPES.has(file.type.toLowerCase()) || TEXT_EXTENSIONS.test(file.name))) { errors.push(`${file.name} is not a supported text file`); return undefined; }
  if (file.size > TEXT_LIMIT) { errors.push(`${file.name} is larger than 200 KB`); return undefined; }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
  catch { errors.push(`${file.name} does not contain valid UTF-8 text`); return undefined; }
  if (text.includes("\0")) { errors.push(`${file.name} does not contain valid text`); return undefined; }
  return { id: crypto.randomUUID(), name: file.name, kind: "text", byteSize: file.size, text };

}

export function Composer(props: Props) {
  const [visualProps, controlProps] = splitProps(props, ["voiceControls"]);
  const composer = createMemo(() => (composerDefaults(controlProps)));
  const [localValue, setLocalValue] = createSignal("");
  const value = createMemo(() => (composer().draft ?? localValue()));
  const fastModeEnabled = createMemo(() => (composer().fastModeStatus === "Fast mode on"));
  const fastModeSupported = createMemo(() => (fastModeEnabled() || composer().fastModeStatus === "Fast mode off"));
  const [togglingFastMode, setTogglingFastMode] = createSignal(false);
  const togglingFastModeRef = createRef(false);
  const setValue = (next: string) => { if (composer().onDraftChange) (composer().onDraftChange)!(next); else setLocalValue(next); };
  const [localUploads, setLocalUploads] = createSignal<ComposerUpload[]>([]);
  const uploads = createMemo(() => (composer().controlledUploads ?? localUploads()));
  const updateUploads = (update: ComposerUpload[] | ((current: ComposerUpload[]) => ComposerUpload[])) => {
    if (composer().onUploadsChange) (composer().onUploadsChange)!(update); else setLocalUploads(update);
  };
  const [uploadError, setUploadError] = createSignal<string>();
  const [imageInputError, setImageInputError] = createSignal(false);
  const supportsImages = createMemo(() => (modelSupportsImages(composer().model, composer().models)));
  const supportsImagesRef = createRef(supportsImages());
  createDependencyEffect(() => {
    const capturedSupportsImages = supportsImages();
 supportsImagesRef.current = capturedSupportsImages; }, () => [supportsImages()]);
  createDependencyEffect(() => {
    const capturedSupportsImages = supportsImages();
 if (capturedSupportsImages) setImageInputError(false); }, () => [supportsImages()]);
  const [sending, setSending] = createSignal(false);
  const sendingRef = createRef(false);
  const [controlAction, setControlAction] = createSignal<"pause" | "resume">();
  const [stopping, setStopping] = createSignal(false);
  const stoppingRef = createRef(false);
  const [controlError, setControlError] = createSignal<string>();
  const toggleFastMode = async () => { const capturedComposer = { ...composer() };
    if (togglingFastModeRef.current || capturedComposer.controlsDisabled) return;
    togglingFastModeRef.current = true; setTogglingFastMode(true); setControlError(undefined);
    try { await capturedComposer.onToggleFastMode(); }
    catch (reason) { setControlError(`Could not toggle Fast mode: ${reason instanceof Error ? reason.message : String(reason)}`); }
    finally { togglingFastModeRef.current = false; setTogglingFastMode(false); }
  };
  const controlActionRef = createRef(false);
  const controls = createMemo(() => (composerControlState(composer().controlsDisabled, controlAction(), composer().pausing, stopping())));
  const [selectedMatch, setSelectedMatch] = createSignal(0);
  const [paletteDismissed, setPaletteDismissed] = createSignal(false);
  const ref = createRef<HTMLTextAreaElement>(null);
  const composerRef = createRef<HTMLDivElement>(null);
  const selectedCommandRef = createRef<HTMLButtonElement>(null);
  const [draggingFiles, setDraggingFiles] = createSignal(false);
  const dragDepth = createRef(0);
  const restoredDraftId = createRef<string | undefined>(undefined);
  const commandQuery = createMemo(() => (value().match(/^\/([^\s]*)$/)?.[1]?.toLowerCase()));
  const skillQuery = createMemo(() => (commandQuery() === undefined ? skillReference(value()) : undefined));
  const matches = createMemo(() => paletteDismissed() ? [] : commandQuery() !== undefined
    ? composer().commands.filter((command) => command.name.toLowerCase().includes((commandQuery())!)).slice(0, 7)
    : skillQuery() !== undefined
      ? composer().commands.filter((command) => skillName(command)?.toLowerCase().includes((skillQuery())!)).slice(0, 7)
      : []);
  createDependencyEffect(() => setSelectedMatch(0), () => [commandQuery(), skillQuery(), matches().length]);
  createDependencyEffect(() => {
    composerRef.current?.querySelector<HTMLElement>('.command-palette [aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, () => [selectedMatch(), matches()]);
  createDependencyEffect(() => setPaletteDismissed(false), () => [value()]);
  createDependencyEffect(() => {
    const dismissOutside = (event: PointerEvent) => { if (!composerRef.current?.contains(event.target as Node)) setPaletteDismissed(true); };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, () => []);

  createDependencyEffect(() => {
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
  }, () => []);

  const resizeEditor = () => {
    const editor = ref.current; if (!editor) return;
    editor.style.height = "auto";
    const contentHeight = Math.max(editor.scrollHeight, 31);
    editor.style.height = `${Math.min(contentHeight, COMPOSER_MAX_HEIGHT)}px`;
    editor.style.overflowY = contentHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  };
  createDependencyEffect(resizeEditor, () => [value()]);

  createDependencyEffect(() => {
    const resize = () => resizeEditor();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, () => []);
  createDependencyEffect(() => {
    const capturedComposer = { ...composer() };
 if (capturedComposer.focusRequest) ref.current?.focus(); }, () => [composer().focusRequest]);
  createDependencyEffect(() => {
    const capturedComposer = { ...composer() }; const capturedValue = value();
 if (capturedComposer.restoredDraft && (capturedComposer.restoredDraft)!.id !== restoredDraftId.current) { restoredDraftId.current = (capturedComposer.restoredDraft)!.id; if (!capturedValue) setValue((capturedComposer.restoredDraft)!.value); } }, () => [composer().restoredDraft]);

  const addFiles = async (files: FileList | File[] | null, initialErrors: string[] = []) => { const capturedUploads = uploads();
    if (!files) return;
    setUploadError(undefined);
    const next: ComposerUpload[] = [];
    const errors = [...initialErrors];
    let totalBytes = capturedUploads.reduce((total, upload) => total + upload.byteSize, 0);
    for (const file of Array.from(files)) {
      if (imageFile(file) && !supportsImagesRef.current) { setImageInputError(true); continue; }
      if (capturedUploads.length + next.length >= UPLOAD_COUNT_LIMIT) { errors.push(`Only ${UPLOAD_COUNT_LIMIT} attachments are allowed`); break; }
      if (file.size + totalBytes > TOTAL_UPLOAD_LIMIT) { errors.push(`${file.name} exceeds the 24 MB attachment limit`); continue; }
      const upload = file.type.startsWith("image/") ? await imageUpload(file, errors) : await textUpload(file, errors);
      if (!upload) continue;
      next.push(upload);
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
  const nativeDropRef = createRef({ inputDisabled: controls().inputDisabled, addPaths });
  createDependencyEffect(() => {
    const capturedControls = { ...controls() };
 nativeDropRef.current = { inputDisabled: capturedControls.inputDisabled, addPaths }; });
  createDependencyEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed) return;
      if (payload.type === "leave") { setDraggingFiles(false); return; }
      const bounds = composerRef.current?.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio;
      const y = payload.position.y / window.devicePixelRatio;
      const inside = insideBounds(bounds, x, y);
      const enabled = inside && !nativeDropRef.current.inputDisabled;
      setDraggingFiles(payload.type !== "drop" && enabled);
      if (payload.type !== "drop" || !enabled) return;
      void nativeDropRef.current.addPaths(payload.paths, () => disposed).catch((reason) => { if (!disposed) setUploadError(String(reason)); });
      ref.current?.focus();
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; })
      .catch((reason) => { if (!disposed) setUploadError(`Could not enable file drops: ${String(reason)}`); });
    return () => { disposed = true; unlisten?.(); };
  }, () => []);

  const [expandedPending, setExpandedPending] = createSignal<string>();
  const [changingPending, setChangingPending] = createSignal(false);
  const changePending = (id: string, action: import("../types").PendingMessageAction) => {
    if (!composer().onChangePending) return;
    setChangingPending(true); setControlError(undefined);
    void (composer().onChangePending)!(id, action).catch((reason) => setControlError(reason instanceof Error ? reason.message : String(reason))).finally(() => setChangingPending(false));
  };
  const pendingDrag = usePendingMessageDrag(() => (composer().pendingMessages), () => (pendingControlsDisabled(composer().controlsDisabled, changingPending(), composer().pausing, composer().onChangePending)), () => (changePending));
  const controlsBlocked = () => composer().controlsDisabled || composer().pausing || controlActionRef.current || stoppingRef.current;
  const canSubmit = (message: string, images: ImageAttachment[]) => {
    if (images.length && !supportsImagesRef.current) { setImageInputError(true); return false; }
    return Boolean((message || images.length) && !sendingRef.current);
  };
  const restoreSubmission = (submittedValue: string, submittedUploads: ComposerUpload[], reason: unknown) => {
    const newerDraft = ref.current?.value || "";
    setValue(newerDraft && newerDraft !== submittedValue ? `${submittedValue}\n\n${newerDraft}` : submittedValue);
    updateUploads((current) => [...submittedUploads.filter((item) => !current.some((other) => other.id === item.id)), ...current]);
    setUploadError(reason instanceof Error ? reason.message : String(reason));
  };
  const submit = async (behavior: "steer" | "followUp" = "followUp") => { const capturedUploads = uploads(); const capturedValue = value(); const capturedComposer = { ...composer() };
    if (controlsBlocked()) return;
    const textFiles = capturedUploads.filter((upload) => upload.kind === "text");
    const escapeFileContent = (text: string) => text.replace(/<\/file>/gi, "<\\/file>");
    const message = [expandSkillReference(capturedValue.trim(), capturedComposer.commands), ...textFiles.map((file) => `<file name="${escapeAttribute(file.name)}">\n${escapeFileContent(file.text ?? "")}\n</file>`)].filter(Boolean).join("\n\n");
    const images = capturedUploads.flatMap((upload) => upload.image ? [upload.image] : []);
    if (!canSubmit(message, images)) return;
    sendingRef.current = true; setSending(true); setUploadError(undefined);
    const submittedValue = capturedValue; const submittedUploads = capturedUploads;
    setValue(""); updateUploads([]);
    try {
      const accepted = await capturedComposer.onSend(message || "Describe the attached image.", capturedComposer.streaming ? behavior : undefined, images);
      if (accepted === false) throw new Error("Message was not submitted");
    } catch (reason) {
      restoreSubmission(submittedValue, submittedUploads, reason);
    } finally { sendingRef.current = false; setSending(false); }
  };
  const abort = async () => { const capturedComposer = { ...composer() }; const capturedControlAction = controlAction();
    if (capturedComposer.controlsDisabled || stoppingRef.current || capturedControlAction === "resume") return;
    stoppingRef.current = true; setStopping(true); setControlError(undefined);
    try { await capturedComposer.onAbort(); }
    catch (reason) { setControlError(reason instanceof Error ? reason.message : String(reason)); }
    finally { stoppingRef.current = false; setStopping(false); }
  };
  const control = async (action: "pause" | "resume" | "abort") => { const capturedComposer = { ...composer() };
    if (action === "abort") return abort();
    if (controlsBlocked()) return;
    controlActionRef.current = true; setControlAction(action); setControlError(undefined);
    try { await (action === "pause" ? capturedComposer.onPause() : capturedComposer.onResume()); }
    catch (reason) { setControlError(reason instanceof Error ? reason.message : String(reason)); }
    finally { controlActionRef.current = false; setControlAction(undefined); }
  };
  const chooseCommand = (command: SlashCommand) => {
    const name = skillName(command);
    if (skillQuery() !== undefined && name) setValue(value().replace(/\$[a-zA-Z0-9_-]*$/, `$${name} `));
    else setValue(`/${command.name} `);
    ref.current?.focus();
  };
  const handlePaletteKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && matches().length) { event.preventDefault(); event.stopPropagation(); setPaletteDismissed(true); return true; }
    if (matches().length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setSelectedMatch((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + matches().length) % matches().length); return true; }
    if (canPickCommand(event) && matches()[selectedMatch()]) { event.preventDefault(); chooseCommand(matches()[selectedMatch()]); return true; }
    return false;
  };
  const handleEditorKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.isComposing || handlePaletteKey(event)) return;
    if (event.key === "Enter" && !event.shiftKey && (!isMobile || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); void submit(event.ctrlKey ? "steer" : "followUp"); }
  };

  const renderStreamBanner = () => {
    const renderStreamStatus = () => (<span class="stream-status" role="status">{composer().paused ? <Pause size={11} /> : <span class="pulse" />}{stopping() ? "Stopping…" : controlAction() === "resume" ? "Resuming…" : composer().pausing || controlAction() === "pause" ? "Pausing…" : composer().paused ? "Paused · Completed turns saved" : "piop is working"}{composer().queued > 0 && ` · ${composer().queued} queued`}</span>);
    return ((composer().streaming || composer().paused || composer().pausing) && <div class={`stream-banner${composer().paused ? " paused" : ""}`}>
      {renderStreamStatus()}
    </div>);
  };
  const renderComposer = () => {
    const renderComposerDropHint = () => (draggingFiles() && !controls().inputDisabled && <div class="composer-drop-hint" role="status">Drop files to attach</div>);
    const renderCommandPalette = () => (matches().length > 0 && <div class="command-palette" role="listbox" aria-label={skillQuery() === undefined ? "piop commands" : "piop skills"}>{<Key each={matches()} by={(command) => `${command.source}:${command.name}`}>{(command, index) => <button ref={element => { if (index() === selectedMatch()) selectedCommandRef.current = element; }} role="option" aria-selected={index() === selectedMatch()}  type="button" onClick={() => chooseCommand(command())}><span><strong>{skillQuery() !== undefined ? `$${skillName(command())}` : `/${command().name}`}</strong>{command().description && <small>{command().description}</small>}</span></button>}</Key>}</div>);
    const renderComposerEditor = () => (<div class="composer-editor">
        <textarea ref={element => { ref.current = element; }} aria-label="Message piop" disabled={composer().controlsDisabled} placeholder={composer().controlsDisabled ? "Connecting to piop…" : composer().paused ? "Send a message to continue piop…" : composer().streaming ? "Queue a follow-up…" : "Ask piop to build, explain, or change anything…"} value={value()} rows={1} onInput={(event) => { setPaletteDismissed(false); setValue(event.target.value); }} onKeyDown={handleEditorKey} />
      </div>);
    const renderComposerBar = () => {
      const renderComposerTools = () => (<div class="composer-tools">{visualProps.voiceControls}<DictationControls disabled={composer().controlsDisabled} onText={(text) => { const current = value(); setValue(`${current}${current && !/\s$/.test(current) ? " " : ""}${text}`); ref.current?.focus(); }} />{composer().onOpenTerminal && <IconButton title="" label="Open terminal" disabled={composer().controlsDisabled} onClick={(composer().onOpenTerminal)!}><TerminalSquare size={17} /></IconButton>}<Show when={composer().contextUsage} keyed>{usage => <ContextWheel usage={usage} />}</Show><Show when={composer().sessionCache} keyed>{cache => <span class={`session-cache-hit${cache.low ? " low" : ""}`}>Cache {cache.rate}%</span>}</Show></div>);
      const renderComposerActions = () => {
        const renderMobileSteer = () => (isMobile && composer().streaming && <button class="mobile-steer" disabled={composer().controlsDisabled || !hasVisibleText(value())} onClick={() => void submit("steer")}>Steer</button>);
        const renderAgentPicker = () => (<ContainedPicker label="Agent" selectedLabel={composer().agentUnavailable ? `Agent unavailable: ${composer().activeAgent}` : `${composer().activeAgent ?? "general"}${composer().agentSaved ? " · saved" : ""}`} value={composer().activeAgent ?? "general"} disabled={composer().agentLocked || composer().streaming || controls().inputDisabled} menuMinWidth={130} centered compact options={composer().agents.map((agent) => ({ value: agent.name, label: agent.name }))} onChange={composer().onAgent} />);
        const renderFastModeIndicator = () => (fastModeSupported() && <button type="button" class={`fast-mode-indicator${fastModeEnabled() ? " active" : ""}`} aria-label="Fast mode" aria-description={(composer().fastModeStatus)!} aria-pressed={fastModeEnabled()} aria-busy={togglingFastMode()} disabled={controls().inputDisabled || togglingFastMode()} onClick={() => void toggleFastMode()}><Zap size={14} strokeWidth={1.5} fill={fastModeEnabled() ? "currentColor" : "none"} aria-hidden="true" /></button>);
        const renderModelPicker = () => (<ContainedPicker label="Model" selectedLabel={composer().model ? displayModelName((composer().model)!, composer().models) : undefined} value={composer().model ? `${(composer().model)!.provider}/${(composer().model)!.id}` : ""} disabled={composer().streaming || controls().inputDisabled} options={composer().models.map((item) => ({ value: `${item.provider}/${item.id}`, label: displayModelName(item, composer().models), detail: providerAccountLabel(item.provider) }))} onChange={(value) => { const next = composer().models.find((item) => `${item.provider}/${item.id}` === value); if (next) composer().onModel(next); }} />);
        const renderStopButton = () => ((composer().streaming || composer().paused || composer().pausing) && <IconButton title="" label="Stop piop" class="stop-compact" disabled={controls().stopDisabled} onClick={() => void control("abort")}><CircleStop size={17} /></IconButton>);
        const renderSend = () => ((composer().streaming || composer().paused || composer().pausing)
            ? <IconButton title="" label={composer().paused ? "Resume piop" : "Pause piop"} class="send" disabled={controls().inputDisabled} onClick={() => void control(composer().paused ? "resume" : "pause")}>{composer().paused ? <Play size={17} /> : <Pause size={17} />}</IconButton>
            : <IconButton title="" label="Send message" class="send" disabled={controls().inputDisabled || sending() || (!hasVisibleText(value()) && uploads().length === 0)} onClick={() => void submit()}><ArrowUp size={18} /></IconButton>);
        return (<div class="composer-actions">{renderMobileSteer()}
          {renderAgentPicker()}
          {renderFastModeIndicator()}
          {renderModelPicker()}
          <ContainedPicker label="Thinking level" value={composer().thinkingLevel} disabled={composer().streaming || controls().inputDisabled} menuWidth={120} centered compact options={composer().thinkingLevels.map((level) => ({ value: level, label: level.charAt(0).toUpperCase() + level.slice(1) }))} onChange={composer().onThinking} />
          <span class="composer-divider" />
          {renderStopButton()}
          {renderSend()}
        </div>);
      };
      return (<div class="composer-bar">{renderComposerTools()}
        {renderComposerActions()}
      </div>);
    };
    return (<div ref={element => { composerRef.current = element; }} class={`composer${draggingFiles() && !controls().inputDisabled ? " dragging-files" : ""}`}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.length) return;
        event.preventDefault();
        if (controls().inputDisabled) return;
        void addFiles(files).catch((reason) => setUploadError(reason instanceof Error ? reason.message : String(reason)));
      }}
      onDragEnter={(event) => {
        if (!event.dataTransfer || (!event.dataTransfer.types.includes("Files") && !(isTauri() && event.dataTransfer.types.includes("text/uri-list")))) return;
        event.preventDefault(); dragDepth.current += 1; setDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer || (!event.dataTransfer.types.includes("Files") && !(isTauri() && event.dataTransfer.types.includes("text/uri-list")))) return;
        event.preventDefault(); event.dataTransfer.dropEffect = controls().inputDisabled ? "none" : "copy";
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDraggingFiles(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer || (!event.dataTransfer.types.includes("Files") && !(isTauri() && event.dataTransfer.types.includes("text/uri-list")))) return;
        event.preventDefault(); dragDepth.current = 0; setDraggingFiles(false);
        if (controls().inputDisabled) return;
        const files = Array.from(event.dataTransfer?.files ?? []);
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
      {renderComposerDropHint()}
      {renderCommandPalette()}
      {uploads().length > 0 && <div class="attachments">{<Key each={uploads()} by={(upload) => upload.id}>{(upload, index) => <span >{upload().kind === "image" ? <ImagePlus size={12} /> : <FileText size={12} />}<b>{upload().name}</b><button aria-label={`Remove ${upload().name}`} onClick={() => { updateUploads((current) => current.filter((item) => item.id !== upload().id)); setUploadError(undefined); }}><X size={11} /></button></span>}</Key>}</div>}
      {uploadError() && <div class="upload-error" role="alert">{(uploadError())!}</div>}
      {controlError() && <div class="upload-error" role="alert">{(controlError())!}</div>}
      {renderComposerEditor()}
      {renderComposerBar()}
    </div>);
  };
  return <div class="composer-wrap">
    {imageInputError() && <div class="image-input-toast" role="alert"><CircleX size={14} aria-hidden="true" /><span>This model does not support image inputs. Try a different model</span><button type="button" aria-label="Dismiss image input error" onClick={() => setImageInputError(false)}><X size={14} /></button></div>}
    {renderStreamBanner()}
    {composer().pendingMessages.length > 0 && <div class="pending-messages" aria-label="Pending messages">{<Key each={composer().pendingMessages.filter((message) => message && typeof message.id === "string")} by={(message) => message.id}>{(message, index) => {
      const text = createMemo(() => (typeof message().message === "string" ? message().message : String(message().message ?? "")));
      const change = (action: import("../types").PendingMessageAction) => changePending(message().id, action);
      const disabled = createMemo(() => (composer().controlsDisabled || changingPending() || composer().pausing));
      const peers = createMemo(() => (composer().pendingMessages.filter((item) => !item.retry && item.behavior === message().behavior)));
      const position = createMemo(() => (peers().findIndex((item) => item.id === message().id)));
      const renderPendingDragHandle = () => (<button type="button" class="pending-icon-button pending-drag-handle" disabled={disabled() || message().retry || !composer().onChangePending || peers().length < 2} aria-label={`Drag to reorder queued message: ${text()}`} title="Drag to reorder · Arrow keys to move" onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); change(event.key === "ArrowUp" ? "moveUp" : "moveDown"); }
        }} onPointerDown={(event) => pendingDrag.begin(event, message().id)}><MoveVertical size={16} /></button>);
      const renderPendingMessageActions = () => (composer().onChangePending && <div class="pending-message-actions">
          <div class="pending-order-actions">
            <button type="button" class="pending-icon-button" disabled={disabled() || position() <= 0} aria-label={`Move queued message up: ${text()}`} title="Move earlier in this delivery queue" onClick={() => change("moveUp")}><ChevronUp size={13} /></button>
            <button type="button" class="pending-icon-button" disabled={disabled() || position() < 0 || position() >= peers().length - 1} aria-label={`Move queued message down: ${text()}`} title="Move later in this delivery queue" onClick={() => change("moveDown")}><ChevronDown size={13} /></button>
          </div>
          <button type="button" disabled={disabled()} title={message().behavior === "steer" ? "Queue after the current response" : "Steer at the next turn"} onClick={() => change(message().retry ? message().behavior : message().behavior === "steer" ? "followUp" : "steer")}><CornerDownRight size={13} />{message().retry ? "Retry" : message().behavior === "steer" ? "Queue" : "Steer"}</button>
          <button type="button" class="pending-icon-button" disabled={disabled()} aria-label={`Remove queued message: ${text()}`} title="Remove message" onClick={() => change("remove")}><Trash2 size={13} /></button>
        </div>);
      return <div data-pending-id={message().id} class={pendingMessageClass(message().id, expandedPending(), pendingDrag.drop)} >
        {renderPendingDragHandle()}
        <span class="pending-message-text" title={text()} onDblClick={() => setExpandedPending((current) => current === message().id ? undefined : message().id)}>{message().retry && <small>Not sent · </small>}{text()}</span>
        {renderPendingMessageActions()}
      </div>;
    }}</Key>}</div>}
    {renderComposer()}
  </div>;
}

type PickerOption = { value: string; label: string; detail?: string; disabled?: boolean };

function pickerDefaults({ label, selectedLabel, value, options, disabled, menuWidth = 200, centered = false, compact = false, onChange }: { label: string; selectedLabel?: string; value: string; options: PickerOption[]; disabled?: boolean; menuWidth?: number; menuMinWidth?: number; centered?: boolean; compact?: boolean; onChange: (value: string) => void }) {
  return { label, selectedLabel, value, options, disabled, menuWidth, centered, compact, onChange };
}

function ContainedPicker(props: { label: string; selectedLabel?: string; value: string; options: PickerOption[]; disabled?: boolean; menuWidth?: number; menuMinWidth?: number; centered?: boolean; compact?: boolean; onChange: (value: string) => void }) {
  const picker = createMemo(() => (pickerDefaults(props)));
  const [menuStyle, setMenuStyle] = createSignal<CSSProperties>();
  const [activeIndex, setActiveIndex] = createSignal(0);
  const root = createRef<HTMLDivElement>(null);
  const trigger = createRef<HTMLButtonElement>(null);
  const optionRefs = createRef<Array<HTMLButtonElement | null>>([]);
  const optionChosenRef = createRef(false);
  const selectedOption = createMemo(() => (picker().options.find((option) => option.value === picker().value)));
  const close = () => setMenuStyle(undefined);
  createDependencyEffect(() => {
    const capturedPicker = { ...picker() };
 if (capturedPicker.disabled) close(); }, () => [picker().disabled]);
  const toggle = () => {
    if (menuStyle()) return close();
    optionChosenRef.current = false;
    const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
    const width = Math.min(props.menuMinWidth ?? picker().menuWidth, window.innerWidth - 16);
    const right = Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - width - 8));
    const selectedIndex = picker().options.findIndex((option) => option.value === picker().value && !option.disabled);
    const index = Math.max(0, selectedIndex >= 0 ? selectedIndex : picker().options.findIndex((option) => !option.disabled));
    setActiveIndex(index);
    setMenuStyle({
      ...(props.menuMinWidth === undefined
        ? { left: cssPixels(Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))), width: cssPixels(width) }
        : { right: cssPixels(right), width: "max-content", "min-width": cssPixels(width), "max-width": cssPixels(window.innerWidth - right - 8) }),
      bottom: cssPixels(window.innerHeight - rect.top + 6),
      "max-height": cssPixels(Math.max(0, rect.top - 14)),
    });
    requestAnimationFrame(() => optionRefs.current[index]?.focus());
  };
  createDependencyEffect(() => { const capturedMenuStyle = menuStyle();
    if (!capturedMenuStyle) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", dismiss); window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", dismiss); window.removeEventListener("resize", close); };
  }, () => [menuStyle()]);
  const move = (direction: 1 | -1) => {
    if (!picker().options.some((option) => !option.disabled)) return;
    let next = activeIndex();
    for (let count = 0; count < picker().options.length; count += 1) { next = (next + direction + picker().options.length) % picker().options.length; if (!picker().options[next].disabled) break; }
    setActiveIndex(next); optionRefs.current[next]?.focus();
  };
  return <div ref={element => { root.current = element; }} class="composer-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus(); } else if (menuStyle() && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); } }}>
    <button ref={element => { trigger.current = element; }} type="button" class="select-control composer-picker-trigger" aria-label={picker().label} aria-haspopup="listbox" aria-expanded={Boolean(menuStyle())} data-value={picker().value} data-options={picker().options.map((option) => option.value).join(" ")} disabled={picker().disabled} onClick={toggle}>{selectedOption()?.label || picker().selectedLabel || picker().label}</button>
    {menuStyle() && <div class={`composer-picker-menu${picker().centered ? " centered" : ""}${picker().compact ? " compact" : ""}`} role="listbox" aria-label={`${picker().label} options`} style={(menuStyle())!}>{picker().options.length === 0 && <div class="empty-small">No options available</div>}{<Key each={picker().options} by={(option) => `${option.detail ?? picker().label}:${option.value}`}>{(option, index) => <button ref={(element) => { optionRefs.current[index()] = element; }}  type="button" role="option" aria-selected={option().value === picker().value} tabIndex={index() === activeIndex() ? 0 : -1} data-value={option().value} disabled={picker().disabled || option().disabled} onFocus={() => setActiveIndex(index())} onClick={() => { if (picker().disabled || optionChosenRef.current) return; optionChosenRef.current = true; picker().onChange(option().value); close(); trigger.current?.focus(); }}><span>{option().label}</span>{option().detail && <small>{option().detail}</small>}</button>}</Key>}</div>}
  </div>;
}

function ContextWheel(componentProps: { usage: ContextUsage }) {
  const rawPercent = createMemo(() => (componentProps.usage.percent ?? (componentProps.usage.tokens === null ? null : componentProps.usage.tokens / componentProps.usage.contextWindow * 100)));
  const percent = createMemo(() => (rawPercent() === null ? null : Math.max(0, Math.min(100, (rawPercent())!))));
  const tooltip = createMemo(() => (`${percent() === null ? "—" : `${Math.round((percent())!)}%`} of ${componentProps.usage.contextWindow.toLocaleString()}`));
  const label = createMemo(() => (percent() === null ? `Context usage unavailable; window is ${componentProps.usage.contextWindow.toLocaleString()} tokens` : `${Math.round((percent())!)}% of ${componentProps.usage.contextWindow.toLocaleString()} context tokens used`));
  return <span class="context-wheel" data-tooltip={tooltip()} aria-label={label()} tabIndex={0}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><circle class="context-wheel-track" cx="10" cy="10" r="7.5" /><circle class="context-wheel-value" cx="10" cy="10" r="7.5" pathLength="100" style={{ "stroke-dasharray": `${percent() ?? 0} 100` }} /></svg>
  </span>;
}
