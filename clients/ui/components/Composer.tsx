import { CacheIcon } from "./CacheIcon";
import "./composerField";
import type { ComposerFieldElement } from "./composerField";
import { required } from "../lib/required";
import { trackToastMessage } from "../lib/toastHistory";
import { createComposerPromptHistory } from "../lib/promptHistory";
import { createComposerEditorKey } from "../lib/composerKeyboard";
import { Key } from "@solid-primitives/keyed";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { createMemo,createSelector,createSignal,Show,splitProps } from "solid-js";
import { createFilePaste } from "../lib/filePaste";
import { buildComposerPrompt,composerReference,isPromptCommand,skillName } from "../lib/composerPrompt";
import { createDependencyEffect,createMemoFields,createRef,cssPixels,type CSSProperties,type JSXElement,type KeyboardEvent,type StateUpdate } from "../lib/solid";
import { useComposerAttachments } from "../lib/useComposerAttachments";
import { stageComposerDraft, type DraftSubmissionHandle, type StageDraftSubmission } from "../lib/draftSubmission";
import { ComposerSettingsMenu } from "./ComposerSettingsMenu";
import { ComposerPlugins } from "../plugins/composer";
import { GoalActions, type GoalControls } from "./GoalControls";

import { ArrowUp,Check,ChevronDown,ChevronUp,CircleStop,CircleX,CornerDownRight,FileText,ImagePlus,MoveVertical,Pause,Pencil,Play,RefreshCw,TerminalSquare,Trash2,X,Zap } from "lucide-solid";
import { hasVisibleText } from "../lib/content";
import { usePendingMessageDrag } from "../lib/usePendingMessageDrag";
import type { AgentProfile,ComposerUpload,ContextUsage,ImageAttachment,Model,PendingMessage,SlashCommand } from "../types";
import { IconButton } from "./IconButton";
import { PendingImages } from "./PendingImages";
import { PendingMessageAttachments, pendingEditAction, startPendingEdit, type PendingEdit } from "./PendingMessageEditor";
import { z } from "zod";
import { queuedCommand } from "../plugins";
import { isDaemonRefusal } from "../lib/commandRejected";


const pendingMessageIdentitySchema = z.object({ id: z.string() });

interface Props {
  refreshError?: string;
  capabilityErrors?: string[];
  capabilitiesLoading?: boolean;
  onRetryCapabilities?: () => void;
  ownershipRequired?: boolean;
  onTakeOwnership?: () => Promise<void>;
  toolbar?: JSXElement;
  /** The conversation goal. Its queue entry carries the goal buttons; a paused goal shows as its own entry. */
  goal?: GoalControls;
  streaming: boolean;
  compacting?: boolean;
  queued: number;
  commands: SlashCommand[];
  agents: AgentProfile[];
  activeAgent?: string;
  agentLocked?: boolean;
  agentSaved?: boolean;
  agentUnavailable?: boolean;
  modelAliases?: Record<string, string>;
  models: Model[];
  model: Model | null;
  fastModeStatus?: string;
  thinkingLevel: string;
  thinkingLevels: string[];
  sessionCache?: { rate: number; low: boolean; cachedTokens: number; promptTokens: number };
  contextUsage?: ContextUsage;
  controlsDisabled?: boolean;
  /** Disables the controls of the queued messages and the hold button. A message being sent does not disable them, because the daemon changes the queue one step at a time. Defaults to controlsDisabled. */
  queueControlsDisabled?: boolean;
  submissionDisabled?: boolean;
  draft?: string;
  recentPrompts?: () => string[];
  onDraftChange?: (value: StateUpdate<string>) => void;
  uploads?: ComposerUpload[];
  onUploadsChange?: (uploads: StateUpdate<ComposerUpload[]>) => void;
  focusRequest?: number;
  pendingMessages?: import("../types").PendingMessage[];
  /** Loads an image of a queued message for its preview. */
  loadPendingImage?: import("./PendingImages").PendingImageLoader;
  onChangePending?: (id: string, behavior: import("../types").PendingMessageAction) => Promise<void>;
  /** True while the queue is on hold: queued messages wait until the user resumes it. */
  queueHeld?: boolean;
  /** Holds the queue, or resumes it and sends the held messages. */
  onHoldQueue?: (held: boolean) => Promise<void>;
  onStageSubmission?: StageDraftSubmission;
  onSend: (message: string, behavior?: "steer" | "followUp", images?: ImageAttachment[], submission?: DraftSubmissionHandle) => void | boolean | Promise<void | boolean>;
  onAbort: () => void | Promise<void>;
  onOpenTerminal?: () => void;
  onJumpToLatest?: () => void;
  terminalDisabled?: boolean;
  onAgent: (name: string) => void;
  onReloadAgents?: () => Promise<void>;
  agentHostLabel?: string;
  agentReloadScope?: string;
  onModel: (model: Model) => void;
  onToggleFastMode: () => void | Promise<void>;
  onThinking: (level: string) => void;
}


function commandMatches(commands: SlashCommand[], query: string) {
  const exact: SlashCommand[] = [];
  const matches: SlashCommand[] = [];

  for (const command of commands) {
    const name = command.name.toLowerCase();

    if (name === query) exact.push(command);
    else if (matches.length < 7 && name.includes(query)) matches.push(command);

    if (exact.length === 7) break;
  }

  return [...exact, ...matches].slice(0, 7);
}

/** The arguments a command takes, for example "[scope]" or "[on|off|toggle]". Hints (options with an empty value) give the full form; without hints the choices make it. Undefined when the command declares none. */
function commandUsage(command: SlashCommand) {
  const options = command.options ?? [];
  const hints = options.filter(option => !option.value).map(option => option.label);
  const choices = options.filter(option => option.value).map(option => option.value);

  return (hints.length ? hints.join(" ") : choices.length ? `[${choices.join(" | ")}]` : "") || undefined;
}

function skillMatches(commands: SlashCommand[], query: string) {
  const matches: SlashCommand[] = [];

  for (const command of commands) {
    if (skillName(command)?.toLowerCase().includes(query)) matches.push(command);

    if (matches.length === 7) break;
  }

  return matches;
}

function composerDefaults({ streaming, compacting = false, queued, pendingMessages = [], onChangePending, commands, agents, activeAgent, agentLocked = false, agentSaved = false, agentUnavailable = false, models, modelAliases, model, fastModeStatus, thinkingLevel, thinkingLevels, sessionCache, contextUsage, controlsDisabled = false, draft, onDraftChange, uploads: controlledUploads, onUploadsChange, focusRequest, onSend, onStageSubmission, onAbort, onOpenTerminal, onAgent, onModel, onToggleFastMode, onThinking }: Props) {
  return { streaming, compacting, queued, pendingMessages, onChangePending, commands, agents, activeAgent, agentLocked, agentSaved, agentUnavailable, models, modelAliases, model, fastModeStatus, thinkingLevel, thinkingLevels, sessionCache, contextUsage, controlsDisabled, draft, onDraftChange, controlledUploads, onUploadsChange, focusRequest, onSend, onStageSubmission, onAbort, onOpenTerminal, onAgent, onModel, onToggleFastMode, onThinking };
}

function composerControlState(controlsDisabled: boolean, stopping: boolean) {
  return { controlPending: stopping, inputDisabled: controlsDisabled || stopping, stopDisabled: controlsDisabled || stopping };
}

function insideBounds(bounds: DOMRect | undefined, x: number, y: number) {
  return Boolean(bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom);
}

/** True for a queued /compact. It runs as it is, so it cannot be edited. */
const queuedCompaction = (text: string) => /^\/compact(?:\s|$)/.test(text.trimStart());

/** A sent message keeps its row when the daemon queues it: the row of the message still being sent has the submission ID that the queued item carries. */
const pendingKey = (message: import("../types").PendingMessage) => message.goalSubmissionId ?? message.id;

function pendingControlsDisabled(controlsDisabled: boolean, changingPending: boolean, onChangePending: Props['onChangePending']) {
  return controlsDisabled || changingPending || !onChangePending;
}

function pendingQueuePositions(messages: PendingMessage[]) {
  const queues = new Map<PendingMessage["behavior"], { length: number; positions: Map<string, number> }>();

  for (const message of messages) {
    if (!message || message.retry) continue;
    let queue = queues.get(message.behavior);

    if (!queue) queues.set(message.behavior, queue = { length: 0, positions: new Map() });

    if (!queue.positions.has(message.id)) queue.positions.set(message.id, queue.length);
    queue.length++;
  }

  return queues;
}

function pendingMessageClass(id: string, expanded: string | undefined, drop: ReturnType<typeof usePendingMessageDrag>['drop']) {
  return `pending-message${expanded === id ? " expanded" : ""}${drop?.id === id ? " dragging" : ""}${drop?.targetId === id ? ` drop-${drop.edge}` : ""}`;
}

function canPickCommand(event: KeyboardEvent) {
  return (event.key === "Tab" || event.key === "Enter") && !event.shiftKey && !event.ctrlKey;
}

function reviewBehavior(message: string, behavior: "steer" | "followUp") {
  return queuedCommand(message) ? "followUp" : behavior;
}

export function Composer(props: Props) {
  const [reloadingAgents, setReloadingAgents] = createSignal(false);
  const [reloadError, setReloadError] = createSignal<string>();

  createDependencyEffect(() => { setReloadError(undefined); setReloadingAgents(false); }, () => [props.agentReloadScope]);

  const reloadAgents = async () => {
    if (!props.onReloadAgents || reloadingAgents()) return;
    const scope = props.agentReloadScope;

    setReloadingAgents(true); setReloadError(undefined);

    try { await props.onReloadAgents(); }
    catch (error) { if (scope === props.agentReloadScope) setReloadError(error instanceof Error ? error.message : String(error)); }
    finally { if (scope === props.agentReloadScope) setReloadingAgents(false); }
  };

  const [visualProps, controlProps] = splitProps(props, ["toolbar"]);
  const composerFields = createMemoFields(() => composerDefaults(controlProps));
  const composer = () => composerFields;
  const pendingQueues = createMemo(() => pendingQueuePositions(composer().pendingMessages));
  const [editingPending, setEditingPending] = createSignal<PendingEdit>();
  const [savingEdit, setSavingEdit] = createSignal(false);
  const isEditingPending = createSelector(() => editingPending()?.id);
  const [localValue, setLocalValue] = createSignal("");
  const value = createMemo(() => (editingPending()?.prompt ?? composer().draft ?? localValue()));
  const agentOptions = createMemo(() => composer().agents.map(agent => ({ value: agent.name, label: agent.name })));
  const displayModelName = (model: Model) => composer().modelAliases?.[`${model.provider}/${model.id}`] || (model.name || model.id).replace(/^gpt-/i, "");
  const modelOptions = createMemo(() => composer().models.map(item => ({ value: `${item.provider}/${item.id}`, label: displayModelName(item), detail: item.provider })));
  const thinkingOptions = createMemo(() => composer().thinkingLevels.map(level => ({ value: level, label: level.charAt(0).toUpperCase() + level.slice(1) })));
  const fastModeEnabled = createMemo(() => (composer().fastModeStatus === "Fast mode on"));
  const fastModeSupported = createMemo(() => (fastModeEnabled() || composer().fastModeStatus === "Fast mode off"));
  const [togglingFastMode, setTogglingFastMode] = createSignal(false);
  const togglingFastModeRef = createRef(false);
  const writeValue = (next: string) => { if (editingPending()) { setEditingPending(edit => edit && ({ ...edit, prompt: next })); return; } if (composer().onDraftChange) required((composer().onDraftChange))(next); else setLocalValue(next); };

  const promptHistory = createComposerPromptHistory(value, writeValue, () => props.recentPrompts?.() ?? [], next => { setPaletteDismissed(true); setSelection({ start: next.length, end: next.length }); });

  const setValue = (next: string) => { promptHistory.reset(); writeValue(next); };

  const attachmentOptions = createMemo(() => {
    const edit = editingPending();
    if (!edit) return composer();
    const id = edit.id;
    return { ...composer(), controlledUploads: edit.added, onUploadsChange: (update: StateUpdate<ComposerUpload[]>) => {
      setEditingPending(current => current?.id === id ? { ...current, added: typeof update === "function" ? update(current.added) : update } : current);
    } };
  });
  const attachments = useComposerAttachments(attachmentOptions);
  const { uploads, updateUploads, uploadError, setUploadError, readingUploads, imageInputError, setImageInputError, addFiles, addPaths } = attachments;
  trackToastMessage("Composer", "Image input error", () => imageInputError() ? "This model does not support image inputs. Try a different model" : undefined);
  const [sending, setSending] = createSignal(false);
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

  const controls = createMemo(() => { const state = composerControlState(composer().controlsDisabled, stopping());

  return { ...state, inputDisabled: state.inputDisabled || composer().compacting }; });

  const [selectedMatch, setSelectedMatch] = createSignal(0);
  const [paletteDismissed, setPaletteDismissed] = createSignal(false);
  const [selection, setSelection] = createSignal<{ start: number; end: number }>();
  const ref = createRef<ComposerFieldElement>(null);
  const focusOwnedEditor = () => { if (!props.ownershipRequired) ref.current?.focus(); };

  const composerRef = createRef<HTMLDivElement>(null);
  const selectedCommandRef = createRef<HTMLButtonElement>(null);
  const [draggingFiles, setDraggingFiles] = createSignal(false);
  const dragDepth = createRef(0);

  const reference = createMemo(() => {
    const caret = selection();

    if (caret && caret.start !== caret.end) return undefined;

    return composerReference(value(), caret?.start ?? value().length);
  });

  const commandQuery = createMemo(() => reference()?.marker === "/" ? reference()?.query : undefined);
  const skillQuery = createMemo(() => reference()?.marker === "$" ? reference()?.query : undefined);

  const visibleCommands = createMemo(() => {
    const agent = composer().agents.find(agent => agent.name === composer().activeAgent);
    const goalEnabled = !composer().agentUnavailable && Boolean(agent?.tools.includes("update_goal_status"));

    return composer().commands.filter(command => (command.name !== "goal" || goalEnabled) && (!reference()?.start || isPromptCommand(command)));
  });

  const matches = createMemo(() => paletteDismissed() ? [] : commandQuery() !== undefined
    ? commandMatches(visibleCommands(), required(commandQuery()))
    : skillQuery() !== undefined
      ? skillMatches(composer().commands, required(skillQuery()))
      : []);

  /** The command and argument text while the user types the argument of a command that has options. */
  const argumentInput = createMemo(() => {
    const caret = selection();
    const text = value();

    if (reference() || (caret && (caret.start !== caret.end || caret.end !== text.length))) return undefined;
    const typed = /^\/(\S+) ([^\n]*)$/.exec(text);
    const command = typed ? visibleCommands().find(command => command.name === typed[1]) : undefined;

    return typed && command?.options?.length ? { command, options: command.options, prefix: typed[2].trimStart().toLowerCase() } : undefined;
  });

  /** The command and its arguments, shown while the user writes the command. */
  const argumentUsage = createMemo(() => {
    const input = argumentInput();

    return input && !paletteDismissed() ? `/${input.command.name}` : undefined;
  });

  createDependencyEffect(() => { setSelectedMatch(0); }, () => [commandQuery(), skillQuery(), matches().length]);
  createDependencyEffect(() => {
    composerRef.current?.querySelector<HTMLElement>('.command-palette [aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, () => [selectedMatch(), matches()]);
  createDependencyEffect(() => { setPaletteDismissed(false); }, () => [value()]);
  createDependencyEffect(() => {
    const dismissOutside = (event: PointerEvent) => { if (!(event.target instanceof Node) || !composerRef.current?.contains(event.target)) setPaletteDismissed(true); };

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
    const editor = ref.current;

    if (!editor) return;
    editor.style.height = "auto";
    const contentHeight = Math.max(editor.scrollHeight, 31);
    const maxHeight = parseFloat(getComputedStyle(editor).maxHeight);
    editor.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    editor.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  };

  createDependencyEffect(resizeEditor, () => [value()]);

  createDependencyEffect(() => {
    // Measure after the mobile viewport height is updated.
    let frame = 0;
    const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(resizeEditor); };
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);

    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); };
  }, () => []);
  let handledFocusRequest: number | undefined;
  createDependencyEffect(() => {
    const request = composer().focusRequest ?? 0;

    if (props.ownershipRequired) { handledFocusRequest = request;

    return; }

    if (handledFocusRequest === request) return;

    const frame = requestAnimationFrame(() => {
      const editor = ref.current;

      if (!editor?.isConnected || props.ownershipRequired || document.querySelector("dialog[open]")) return;
      editor.focus({ preventScroll: true });

      if (document.activeElement === editor) handledFocusRequest = request;
    });

    return () => cancelAnimationFrame(frame);
  }, () => [composer().focusRequest, props.ownershipRequired]);
  createDependencyEffect(() => {
    if (props.ownershipRequired) ref.current?.blur();
  }, () => [props.ownershipRequired]);

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

      if (payload.type === "leave") { setDraggingFiles(false);

      return; }

      const bounds = composerRef.current?.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio;
      const y = payload.position.y / window.devicePixelRatio;
      const inside = insideBounds(bounds, x, y);
      const enabled = inside && !nativeDropRef.current.inputDisabled;
      setDraggingFiles(payload.type !== "drop" && enabled);

      if (payload.type !== "drop" || !enabled) return;
      void nativeDropRef.current.addPaths(payload.paths, () => disposed).catch((reason) => { if (!disposed) setUploadError((reason instanceof Error ? reason.message : String(reason))); });
      focusOwnedEditor();
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; })
      .catch((reason) => { if (!disposed) setUploadError(`Could not enable file drops: ${(reason instanceof Error ? reason.message : String(reason))}`); });

    return () => { disposed = true; unlisten?.(); };
  }, () => []);

  const [expandedPending, setExpandedPending] = createSignal<string>();
  const [changingPending, setChangingPending] = createSignal(false);
  const cancelEdit = () => { if (!savingEdit()) { setEditingPending(undefined); setControlError(undefined); focusOwnedEditor(); } };
  const beginEdit = (message: PendingMessage) => {
    if (editingPending()?.id !== message.id) setEditingPending(startPendingEdit(message));
    setControlError(undefined);
    focusOwnedEditor();
    ref.current?.setSelectionRange(value().length, value().length);
  };

  /** Saves the edited queued message. The editor stays open with the error when the save fails. */
  const saveEdit = async () => {
    const edit = editingPending();

    if (!edit || savingEdit() || readingUploads() || queueDisabled() || !composer().onChangePending) return;
    setSavingEdit(true); setControlError(undefined);

    try { await required(composer().onChangePending)(edit.id, pendingEditAction(edit)); setEditingPending(undefined); }
    catch (reason) { setControlError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSavingEdit(false); }
  };


  const changePending = (id: string, action: import("../types").PendingMessageAction) => {
    if (!composer().onChangePending) return;
    setChangingPending(true); setControlError(undefined);
    void required((composer().onChangePending))(id, action).catch((reason) => setControlError(reason instanceof Error ? reason.message : String(reason))).finally(() => setChangingPending(false));
  };

  const holdQueue = (held: boolean) => {
    if (!props.onHoldQueue) return;
    setChangingPending(true); setControlError(undefined);
    void props.onHoldQueue(held).catch((reason) => setControlError(reason instanceof Error ? reason.message : String(reason))).finally(() => setChangingPending(false));
  };

  /** The queue box shows while it has messages, a paused goal, a goal error, or a hold. */
  const showPendingBox = () => composer().pendingMessages.length > 0 || Boolean(props.goal?.error()) || Boolean(props.queueHeld);
  /** The hold button. Without a queue box it stands alone, so the user can hold the queue before sending. */
  const renderQueueHold = (alone = false) => (<Show when={props.onHoldQueue}><div class="pending-queue-hold" classList={{ held: Boolean(props.queueHeld), alone }}><span>{props.queueHeld ? "Queue on hold. Messages wait until you resume." : ""}</span><button type="button" disabled={queueDisabled() || changingPending()} aria-pressed={Boolean(props.queueHeld)} data-tooltip={props.queueHeld ? "Send the held messages" : "Keep messages in the queue until you resume"} onClick={() => holdQueue(!props.queueHeld)}>{props.queueHeld ? <><Play size={13} />Resume queue</> : <><Pause size={13} />Hold queue</>}</button></div></Show>);
  const queueDisabled = () => props.queueControlsDisabled ?? composer().controlsDisabled;
  const pendingDrag = usePendingMessageDrag(() => (composer().pendingMessages), () => (pendingControlsDisabled(queueDisabled(), changingPending(), composer().onChangePending)), () => (changePending));
  const controlsBlocked = () => composer().agentUnavailable || (props.submissionDisabled ?? composer().controlsDisabled) || composer().compacting || stopping();

  const canSubmit = (message: string, images: ImageAttachment[]) => {
    if (!attachments.acceptsImages(images.length)) return false;

    return Boolean((hasVisibleText(message) || images.length) && !sending() && !readingUploads());
  };

  const submit = async (behavior: "steer" | "followUp" = "followUp") => { const capturedUploads = uploads(); const capturedValue = value(); const capturedComposer = { ...composer() };

    if (editingPending()) return saveEdit();
    if (controlsBlocked()) return;
    let prompt: ReturnType<typeof buildComposerPrompt>;

    try { prompt = buildComposerPrompt(capturedValue, capturedUploads, capturedComposer.commands); }
    catch (reason) { setUploadError(reason instanceof Error ? reason.message : String(reason)); return; }
    const { message, images } = prompt;

    if (!canSubmit(message, images)) return;
    setSending(true); setUploadError(undefined);
    const submittedValue = capturedValue; const submittedUploads = capturedUploads;
    const changeDraft = capturedComposer.onDraftChange ?? setLocalValue;
    const changeUploads = attachments.captureUploadWriter();

    const clearUnstaged = (submission?: DraftSubmissionHandle) => {
      if (submission) return;
      changeDraft(current => current === submittedValue ? "" : current);
      changeUploads(current => current.filter(item => !submittedUploads.some(submitted => submitted.id === item.id)));
    };

    try {
      const submission = capturedComposer.onStageSubmission ? await stageComposerDraft(capturedComposer.onStageSubmission, { rawText: submittedValue, uploads: submittedUploads, consume: true }, changeDraft, changeUploads) : undefined;
      const accepted = await capturedComposer.onSend(message, capturedComposer.streaming ? reviewBehavior(message, behavior) : undefined, images, submission);

      if (accepted === false) throw new Error("Message was not submitted");

      clearUnstaged(submission);
    } catch (reason) {
      if (!isDaemonRefusal(reason)) setUploadError(reason instanceof Error ? reason.message : String(reason));
    } finally { setSending(false); }
  };

  const abort = async () => { const capturedComposer = { ...composer() };

    if (capturedComposer.controlsDisabled || stoppingRef.current) return;
    stoppingRef.current = true; setStopping(true); setControlError(undefined);

    try { await capturedComposer.onAbort(); }
    catch (reason) { setControlError(reason instanceof Error ? reason.message : String(reason)); }
    finally { stoppingRef.current = false; setStopping(false); }
  };

  const chooseCommand = (command: SlashCommand) => {
    const token = reference();

    if (!token) return;
    const name = skillName(command);
    const replacement = name && (token.marker === "$" || token.start > 0) ? `$${name} ` : `/${command.name} `;
    setValue(value().slice(0, token.start) + replacement + value().slice(token.end));
    const caret = token.start + replacement.length;
    setSelection({ start: caret, end: caret });
    focusOwnedEditor();
    ref.current?.setSelectionRange(caret, caret);
  };

  const handlePaletteKey = (event: KeyboardEvent<ComposerFieldElement>) => {
    if (event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) return false;

    if (event.key === "Escape" && (matches().length || argumentUsage())) { event.preventDefault(); event.stopPropagation(); setPaletteDismissed(true);

    return true; }

    if (matches().length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setSelectedMatch((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + matches().length) % matches().length);

    return true; }

    if (canPickCommand(event) && matches()[selectedMatch()]) { event.preventDefault(); chooseCommand(matches()[selectedMatch()]);

    return true; }

    return false;
  };

  const filePaste = createFilePaste({
    field: () => ref.current,
    enabled: () => !controls().inputDisabled && !savingEdit() && !props.ownershipRequired,
    start: () => { const commit = attachments.captureUploadWriter();

      return files => addFiles(files, [], commit); },
    error: setUploadError,
  });

  const handleEditorKey = createComposerEditorKey({ paste: filePaste.onKeyDown, ownershipRequired: () => props.ownershipRequired, palette: handlePaletteKey, history: event => editingPending() ? false : promptHistory.handleKey(event), submit });

  const renderStreamBanner = () => {
    const statusText = () => stopping() ? "Stopping…" : composer().compacting ? "Compacting context…" : undefined;
    const renderStreamStatus = () => (<span class="stream-status" role="status"><span class="pulse" />{statusText()}</span>);

    return (<Show when={statusText()} fallback={composer().streaming && <button type="button" class="working-dots" role="status" aria-label="piop is working" onClick={() => props.onJumpToLatest?.()}><span /><span /><span /></button>}><div class="stream-banner">
      {renderStreamStatus()}
    </div></Show>);
  };

  const ComposerBody = () => {
    const renderComposerDropHint = () => (draggingFiles() && !controls().inputDisabled && <div class="composer-drop-hint" role="status">Drop files to attach</div>);
    const renderCommandPalette = () => (<Show when={matches().length > 0}><div class="command-palette" role="listbox" aria-label={skillQuery() === undefined ? "piop commands" : "piop skills"}>{<Key each={matches()} by={(command) => `${command.source}:${command.name}`}>{(command, index) => <button ref={element => { if (index() === selectedMatch()) selectedCommandRef.current = element; }} role="option" aria-selected={index() === selectedMatch()}  type="button" onClick={() => chooseCommand(command())}><span><strong>{skillQuery() !== undefined ? `$${skillName(command())}` : `/${command().name}`}<Show when={skillQuery() === undefined && commandUsage(command())}>{usage => <em class="command-usage"> {usage()}</em>}</Show></strong></span></button>}</Key>}</div></Show>);
    const renderArgumentPalette = () => (<Show when={argumentUsage()}>{name => <div class="command-palette" aria-label={`${name()} arguments`}>
      <div class="command-hint"><span><strong>{name()}<em class="command-usage"> {commandUsage(required(argumentInput()).command)}</em></strong></span></div>
    </div>}</Show>);

    const renderComposerEditor = () => (<div class="composer-editor">
        <piop-composer-field ref={element => { ref.current = element; }} classList={{ "pending-edit": Boolean(editingPending()) }} aria-label="Message piop" readOnly={props.ownershipRequired || savingEdit()} onFocus={() => { setPaletteDismissed(false); if (props.ownershipRequired) void props.onTakeOwnership?.(); }} placeholder={props.ownershipRequired ? "" : composer().streaming || props.queueHeld ? "Queue a follow-up…" : "Ask piop to build, explain, or change anything…"} value={value()} onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} onInput={(event) => { setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }); setPaletteDismissed(false); setValue(event.currentTarget.value); }} onKeyDown={event => {
          if (editingPending() && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelEdit(); return; }
          handleEditorKey(event);
        }} />
      </div>);

    const ComposerBar = () => {
      const mobileQuery = window.matchMedia("(max-width: 700px)");
      const [mobileLayout, setMobileLayout] = createSignal(mobileQuery.matches);

      createDependencyEffect(() => {
        const updateLayout = () => setMobileLayout(mobileQuery.matches);
        mobileQuery.addEventListener("change", updateLayout);
        updateLayout();

        return () => mobileQuery.removeEventListener("change", updateLayout);
      }, () => []);

      const ComposerTools = () => (<div class="composer-tools"><ComposerPlugins disabled={composer().controlsDisabled} onText={(text) => { const current = value(); setValue(`${current}${current && !/\s$/.test(current) ? " " : ""}${text}`); focusOwnedEditor(); }} />{composer().onOpenTerminal && <IconButton class="composer-terminal" title={props.terminalDisabled ? "Unavailable in empty session" : ""} label="Open terminal" data-unavailable={props.terminalDisabled ? "" : undefined} disabled={props.terminalDisabled || (composer().controlsDisabled && !props.ownershipRequired)} onClick={(composer().onOpenTerminal)}><TerminalSquare size={17} /></IconButton>}<Show when={composer().contextUsage}>{usage => <ContextWheel usage={usage()} />}</Show><Show when={composer().sessionCache}>{cache => <span class={`session-cache-hit${cache().low ? " low" : ""}`} aria-label={`Cache ${cache().rate}%, ${cache().cachedTokens}/${cache().promptTokens}`} tabIndex={0} data-tooltip-tap data-tooltip={`${cache().cachedTokens.toLocaleString()} / ${cache().promptTokens.toLocaleString()} tokens cached`}><CacheIcon rate={cache().rate} />{cache().rate}%</span>}</Show></div>);

      const renderComposerActions = () => {
        const agentSelectionDisabled = () => composer().agentLocked || composer().streaming || controls().inputDisabled;
        const changeAgent = (name: string) => { if (!agentSelectionDisabled()) composer().onAgent(name); };

        const agentLabel = () => composer().agentUnavailable ? `Agent unavailable: ${composer().activeAgent}` : composer().activeAgent ?? "general";

        const renderAgentPicker = () => (<ContainedPicker label="Agent" selectedLabel={agentLabel()} value={composer().activeAgent ?? "general"} disabled={props.onReloadAgents ? controls().inputDisabled : agentSelectionDisabled()} menuMinWidth={130} centered compact options={agentOptions().map(option => ({ ...option, disabled: agentSelectionDisabled() || reloadingAgents() }))} onChange={changeAgent} footer={props.onReloadAgents && <><div class="agent-definitions-host"><span>{props.agentHostLabel ?? "Local"}</span><button class="agent-definitions-reload" type="button" aria-label={reloadingAgents() ? "Reloading agent definitions" : "Reload agent definitions"} data-tooltip={`Reload definitions on ${props.agentHostLabel ?? "Local"} for new agents`} disabled={reloadingAgents()} onClick={() => void reloadAgents()}><RefreshCw size={13} class={reloadingAgents() ? "spinning" : ""} aria-hidden="true" /></button></div>{reloadError() && <p role="alert">{reloadError()}</p>}</>} />);
        const renderFastModeIndicator = () => (fastModeSupported() && <button type="button" class={`fast-mode-indicator${fastModeEnabled() ? " active" : ""}`} aria-label="Fast mode" data-tooltip="2.5x more usage" aria-description={(composer().fastModeStatus)} aria-pressed={fastModeEnabled()} aria-busy={togglingFastMode()} disabled={controls().inputDisabled || togglingFastMode()} onClick={() => void toggleFastMode()}><Zap size={14} strokeWidth={1.5} fill={fastModeEnabled() ? "currentColor" : "none"} aria-hidden="true" /></button>);

        const renderModelPicker = () => (<ContainedPicker label="Model" selectedLabel={composer().model ? displayModelName(required((composer().model))) : undefined} value={composer().model ? `${required((composer().model)).provider}/${required((composer().model)).id}` : ""} disabled={controls().inputDisabled} options={modelOptions()} onChange={(value) => { const next = composer().models.find((item) => `${item.provider}/${item.id}` === value);

        if (next) composer().onModel(next); }} />);

        const renderStopButton = () => (<Show when={composer().streaming || composer().compacting}><IconButton title="" label="Stop piop" class="stop-compact" disabled={controls().stopDisabled} onClick={() => void abort()}><CircleStop size={17} /></IconButton></Show>);
        const renderEffortPicker = () => (<ContainedPicker label="Thinking level" selectedLabel={composer().thinkingLevel.charAt(0).toUpperCase() + composer().thinkingLevel.slice(1)} value={composer().thinkingLevel} disabled={controls().inputDisabled} menuWidth={120} centered compact options={thinkingOptions()} onChange={composer().onThinking} />);

        const renderSend = () => <Show when={editingPending()} fallback={<IconButton title="" label="Send message" class="send" disabled={controlsBlocked() || sending() || readingUploads() > 0 || (!hasVisibleText(value()) && uploads().length === 0)} onClick={() => void submit()}><ArrowUp size={18} /></IconButton>}>
          <IconButton title="" label="Cancel editing" disabled={savingEdit()} onClick={cancelEdit}><X size={18} /></IconButton>
          <IconButton title="" label="Save edited message" class="send" disabled={queueDisabled() || savingEdit() || readingUploads() > 0} onClick={() => void saveEdit()}><Check size={18} /></IconButton>
        </Show>;

        return (<div class="composer-actions">
          <ComposerSettingsMenu agent={composer().activeAgent ?? "general"}>
            <div class="composer-settings-row"><span>Agent</span>{renderAgentPicker()}</div>
            <Show when={!mobileLayout()}>{renderModelPicker()}</Show>
            <Show when={fastModeSupported()}><div class="composer-settings-row"><span>Fast mode</span>{renderFastModeIndicator()}</div></Show>
            <Show when={!mobileLayout()}>{renderEffortPicker()}</Show>
          </ComposerSettingsMenu>
          <Show when={mobileLayout()}>{renderModelPicker()}</Show>
          <Show when={mobileLayout()}>{renderEffortPicker()}</Show>
          <span class="composer-divider" />
          {renderStopButton()}
          {renderSend()}
        </div>);
      };

      return (<div class="composer-bar"><ComposerTools />
        {renderComposerActions()}
      </div>);
    };

    return (<div ref={element => { composerRef.current = element; }} classList={{ "editing-pending": Boolean(editingPending()) }} class={`composer${draggingFiles() && !controls().inputDisabled ? " dragging-files" : ""}`}
      onPaste={event => filePaste.onPaste(event)}
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
        focusOwnedEditor();
      }}>
      {renderComposerDropHint()}
      {renderCommandPalette()}
      {renderArgumentPalette()}
      {!editingPending() && uploads().length > 0 && <div class="attachments">{<Key each={uploads()} by={(upload) => upload.id}>{(upload, _index) => <span >{upload().kind === "image" ? <ImagePlus size={12} /> : <FileText size={12} />}<b>{upload().name}</b><button aria-label={`Remove ${upload().name}`} onClick={() => { updateUploads((current) => current.filter((item) => item.id !== upload().id)); setUploadError(undefined); }}><X size={11} /></button></span>}</Key>}</div>}
      {uploadError() && <div class="upload-error" role="alert">{(uploadError())}</div>}
      {controlError() && <div class="upload-error" role="alert">{(controlError())}</div>}
      <Show when={editingPending()}>{edit => <PendingMessageAttachments message={composer().pendingMessages.find(message => message.id === edit().id) ?? { id: edit().id, message: edit().prompt, behavior: "followUp" }} edit={edit()} saving={savingEdit()} load={props.loadPendingImage} onChange={update => setEditingPending(current => current?.id === edit().id ? update(current) : current)} addFiles={files => attachments.addFiles(files)} />}</Show>
      {renderComposerEditor()}
      <ComposerBar />
    </div>);
  };

  return <div class="composer-wrap">
    <Show when={composer().agentUnavailable}>
      <div role="alert">Agent "{composer().activeAgent}" is unavailable. This conversation cannot start.</div>
    </Show>
    <Show when={props.refreshError}>
      <div role="alert">
        <p>{props.refreshError}</p>
        <button type="button" onClick={() => props.onRetryCapabilities?.()}>Retry loading chat</button>
      </div>
    </Show>
    <Show when={!props.capabilitiesLoading && props.capabilityErrors?.length}>
      <div role="alert">
        <Key each={props.capabilityErrors ?? []} by={message => message}>{message => <p>{message()}</p>}</Key>
        <button type="button" disabled={props.capabilitiesLoading} onClick={() => props.onRetryCapabilities?.()}>Retry loading choices</button>
      </div>
    </Show>
    {imageInputError() && <div class="image-input-toast" role="alert"><CircleX size={14} aria-hidden="true" /><span>This model does not support image inputs. Try a different model</span><button type="button" aria-label="Dismiss image input error" onClick={() => setImageInputError(false)}><X size={14} /></button></div>}
    <div class="composer-above">
    {renderStreamBanner()}
    {showPendingBox() ? <div class="pending-messages" aria-label="Pending messages">{renderQueueHold()}{<Key each={composer().pendingMessages.filter((message) => pendingMessageIdentitySchema.safeParse(message).success)} by={pendingKey}>{(message, _index) => {
      const text = createMemo(() => String(message().message ?? ""));
      const change = (action: import("../types").PendingMessageAction) => changePending(message().id, action);
      const disabled = createMemo(() => (queueDisabled() || changingPending() || Boolean(message().sending)));
      const queue = createMemo(() => pendingQueues().get(message().behavior));
      const peerCount = createMemo(() => queue()?.length ?? 0);
      const position = createMemo(() => queue()?.positions.get(message().id) ?? -1);

      const renderPendingDragHandle = () => (<button type="button" class="pending-icon-button pending-drag-handle" disabled={disabled() || message().retry || !composer().onChangePending || peerCount() < 2} aria-label={`Drag to reorder queued message: ${text()}`} data-tooltip="Drag to reorder · Arrow keys to move" onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); change(event.key === "ArrowUp" ? "moveUp" : "moveDown"); }
        }} onPointerDown={(event) => pendingDrag.begin(event, message().id)}><MoveVertical size={16} /></button>);

      const renderPendingMessageActions = () => (composer().onChangePending && <div class="pending-message-actions">
          <Show when={!message().goal && !queuedCompaction(text())}><button type="button" class="pending-icon-button" disabled={disabled() || savingEdit()} aria-label={`Edit queued message: ${text()}`} data-tooltip="Edit message" onClick={() => beginEdit(message())}><Pencil size={12} /></button></Show>
          <div class="pending-order-actions">
            <button type="button" class="pending-icon-button" disabled={disabled() || position() <= 0} aria-label={`Move queued message up: ${text()}`} data-tooltip="Move earlier in this delivery queue" onClick={() => change("moveUp")}><ChevronUp size={13} /></button>
            <button type="button" class="pending-icon-button" disabled={disabled() || position() < 0 || position() >= peerCount() - 1} aria-label={`Move queued message down: ${text()}`} data-tooltip="Move later in this delivery queue" onClick={() => change("moveDown")}><ChevronDown size={13} /></button>
          </div>
          <Show when={!message().goal && (message().retry || !queuedCommand(text()))}><button type="button" disabled={disabled()} data-tooltip={message().retry ? (props.queueHeld ? "Keep it in the held queue. It is sent when you resume." : "Send it again") : message().behavior === "steer" ? "Queue after the current response" : "Steer at the next turn"} onClick={() => change(message().retry ? message().behavior : message().behavior === "steer" ? "followUp" : "steer")}><CornerDownRight size={13} />{message().retry ? "Retry" : message().behavior === "steer" ? "Queue" : "Steer"}</button></Show>
          <Show when={message().goal && props.goal?.goal()}>{goal => <GoalActions controls={required(props.goal)} goal={goal()} />}</Show>
          <Show when={!message().goal}><button type="button" class="pending-icon-button" disabled={disabled()} aria-label={`Remove queued message: ${text()}`} data-tooltip="Remove message" onClick={() => change("remove")}><Trash2 size={13} /></button></Show>
        </div>);

      return <div data-pending-id={message().id} class={pendingMessageClass(message().id, expandedPending(), pendingDrag.drop)} classList={{ "editing-pending": isEditingPending(message().id), "pending-goal": Boolean(message().goal), paused: Boolean(message().paused) }}>
        {renderPendingDragHandle()}
        <PendingImages message={message()} load={props.loadPendingImage} />
        <span class="pending-message-text" data-tooltip={message().recovered ? "This saved answer may not have reached the model. Check the conversation before retrying." : message().retry ? "piop could not confirm whether this message reached the model, for example after a restart, so it is not sent by itself. Retry sends it again. Remove it if the conversation already has it." : text()} onDblClick={() => setExpandedPending((current) => current === message().id ? undefined : message().id)}>{message().goal && <>{message().paused && <small>Paused · </small>}<small class="goal-label">Goal · </small></>}{message().retry && <small>{message().recovered ? "Saved answer · " : "Retry needed · "}</small>}{text()}</span>
        {renderPendingMessageActions()}
      </div>;
    }}</Key>}<Show when={props.goal?.error()}>{message => <div class="pending-goal-error" role="alert">{message()}</div>}</Show></div> : renderQueueHold(true)}
    {visualProps.toolbar}
    </div>
    <ComposerBody />
  </div>;
}

type PickerOption = { value: string; label: string; detail?: string; disabled?: boolean };

function pickerDefaults({ label, selectedLabel, value, options, disabled, menuWidth = 200, centered = false, compact = false, onChange }: { label: string; selectedLabel?: string; value: string; options: PickerOption[]; disabled?: boolean; menuWidth?: number; menuMinWidth?: number; centered?: boolean; compact?: boolean; onChange: (value: string) => void }) {
  return { label, selectedLabel, value, options, disabled, menuWidth, centered, compact, onChange };
}

export function ContainedPicker(props: { label: string; selectedLabel?: string; value: string; options: PickerOption[]; disabled?: boolean; menuWidth?: number; menuMinWidth?: number; anchorLeft?: boolean; icon?: JSXElement; centered?: boolean; compact?: boolean; onChange: (value: string) => void; footer?: JSXElement }) {
  const pickerFields = createMemoFields(() => pickerDefaults(props));
  const picker = () => pickerFields;
  const [menuStyle, setMenuStyle] = createSignal<CSSProperties>();
  const [activeIndex, setActiveIndex] = createSignal(0);
  const isActive = createSelector(activeIndex);
  const root = createRef<HTMLDivElement>(null);
  const trigger = createRef<HTMLButtonElement>(null);
  const optionRefs = createRef<Array<HTMLButtonElement | null>>([]);
  const optionChosenRef = createRef(false);
  const selectedOption = createMemo(() => (picker().options.find((option) => option.value === picker().value)));
  const close = () => setMenuStyle(undefined);
  createDependencyEffect(() => {
    const capturedPicker = { ...picker() };

 if (capturedPicker.disabled) close(); }, () => [picker().disabled]);

  const menuEdges = () => {
    const pane = root.current?.closest(".chat-shell")?.getBoundingClientRect();

    return { leftEdge: Math.max(8, (pane?.left ?? 0) + 8), rightEdge: Math.min(window.innerWidth - 8, (pane?.right ?? window.innerWidth) - 8) };
  };

  const toggle = () => {
    if (menuStyle()) return close();
    optionChosenRef.current = false;
    const rect = trigger.current?.getBoundingClientRect();

    if (!rect) return;
    const { leftEdge, rightEdge } = menuEdges();
    const width = Math.max(0, Math.min(props.menuMinWidth ?? picker().menuWidth, rightEdge - leftEdge));
    const right = window.innerWidth - Math.min(rightEdge, Math.max(rect.right, leftEdge + width));
    const left = Math.max(leftEdge, Math.min(rect.left, rightEdge - width));
    const selectedIndex = picker().options.findIndex((option) => option.value === picker().value && !option.disabled);
    const index = Math.max(0, selectedIndex >= 0 ? selectedIndex : picker().options.findIndex((option) => !option.disabled));
    setActiveIndex(index);
    setMenuStyle({
      ...(props.menuMinWidth === undefined
        ? { left: cssPixels(Math.max(leftEdge, Math.min(rect.right - width, rightEdge - width))), width: cssPixels(width) }
        : props.anchorLeft
          ? { left: cssPixels(left), width: "max-content", "min-width": cssPixels(width), "max-width": cssPixels(rightEdge - left) }
          : { right: cssPixels(right), width: "max-content", "min-width": cssPixels(width), "max-width": cssPixels(window.innerWidth - right - leftEdge) }),
      bottom: cssPixels(window.innerHeight - rect.top + 6),
      "max-height": cssPixels(Math.max(0, rect.top - 14)),
    });
    requestAnimationFrame(() => optionRefs.current[index]?.focus());
  };

  createDependencyEffect(() => { const capturedMenuStyle = menuStyle();

    if (!capturedMenuStyle) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Node) || !root.current?.contains(event.target)) close(); };

    document.addEventListener("pointerdown", dismiss); window.addEventListener("resize", close);

    return () => { document.removeEventListener("pointerdown", dismiss); window.removeEventListener("resize", close); };
  }, () => [menuStyle()]);

  const move = (direction: 1 | -1) => {
    if (!picker().options.some((option) => !option.disabled)) return;
    let next = activeIndex();

    for (let count = 0; count < picker().options.length; count += 1) { next = (next + direction + picker().options.length) % picker().options.length;

    if (!picker().options[next].disabled) break; }

    setActiveIndex(next); optionRefs.current[next]?.focus();
  };

  return <div ref={element => { root.current = element; }} class="composer-picker" onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) close(); }} onKeyDown={(event) => { if (event.key === "Escape" && menuStyle()) { event.preventDefault(); event.stopPropagation(); close(); trigger.current?.focus(); } else if (menuStyle() && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); } }}>
    <button ref={element => { trigger.current = element; }} type="button" class="select-control composer-picker-trigger" aria-label={props.icon ? `${picker().label}: ${picker().selectedLabel ?? selectedOption()?.label ?? ""}` : picker().label} aria-haspopup="listbox" aria-expanded={Boolean(menuStyle())} data-value={picker().value} data-options={picker().options.map((option) => option.value).join(" ")} disabled={picker().disabled} onClick={toggle}>{props.icon ?? (picker().selectedLabel ?? selectedOption()?.label ?? picker().label)}</button>
    {menuStyle() && <div class={`composer-picker-menu${picker().centered ? " centered" : ""}${picker().compact ? " compact" : ""}`} aria-label={`${picker().label} options`} style={(menuStyle())}><div role="listbox" aria-label={`${picker().label} options`}>{picker().options.length === 0 && <div class="empty-small">No options available</div>}{<Key each={picker().options} by={(option) => `${option.detail ?? picker().label}:${option.value}`}>{(option, index) => <button ref={(element) => { optionRefs.current[index()] = element; }}  type="button" role="option" aria-selected={option().value === picker().value} tabIndex={isActive(index()) ? 0 : -1} data-value={option().value} disabled={picker().disabled || option().disabled} onFocus={() => setActiveIndex(index())} onClick={() => { if (picker().disabled || optionChosenRef.current) return; optionChosenRef.current = true; picker().onChange(option().value); close(); trigger.current?.focus(); }}><span>{option().label}</span>{option().detail && <small>{option().detail}</small>}</button>}</Key>}</div>{props.footer && <div class="composer-picker-footer">{props.footer}</div>}</div>}
  </div>;
}

function ContextWheel(componentProps: { usage: ContextUsage }) {
  const rawPercent = createMemo(() => (componentProps.usage.percent ?? (componentProps.usage.tokens === null ? null : componentProps.usage.tokens / componentProps.usage.contextWindow * 100)));
  const percent = createMemo(() => (rawPercent() === null ? null : Math.max(0, Math.min(100, required((rawPercent()))))));
  const tooltip = createMemo(() => (`${percent() === null ? "—" : `${Math.round(required((percent())))}%`} of ${componentProps.usage.contextWindow.toLocaleString()}`));
  const label = createMemo(() => (percent() === null ? `Context usage unavailable; window is ${componentProps.usage.contextWindow.toLocaleString()} tokens` : `${Math.round(required((percent())))}% of ${componentProps.usage.contextWindow.toLocaleString()} context tokens used`));

  return <span class="context-wheel" classList={{ unknown: percent() === null }} data-tooltip={tooltip()} data-tooltip-tap aria-label={label()} tabIndex={0}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><circle class="context-wheel-track" cx="10" cy="10" r="7.5" /><circle class="context-wheel-value" cx="10" cy="10" r="7.5" pathLength="100" style={{ "stroke-dasharray": `${percent() ?? 100} 100` }} /></svg>
  </span>;
}
