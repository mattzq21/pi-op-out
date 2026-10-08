import { z } from "zod";
import { regularChatSchema, chatModelsSchema, chatAccountsSchema, chatRequirementsSchema, type RegularChat } from "./chatSchemas";
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { createDependencyEffect } from "../../lib/solid";
import { invoke } from "../../lib/platform";
import { chatGptContext, type ChatGptContextSource } from "./context";
import { chatGptPrepareToken, solveChatGptRequirements } from "./chatGptIntegrity";
import { createModelSelection, type ChatModel } from "./modelSelection";
import { ownershipSchema, type PluginOwnership } from "../ownership";
import { watchChatGptCatalog } from "./catalogUpdates";

export type { RegularChat } from "./chatSchemas";

export interface QuickChatRequest { id: string; source: Accessor<ChatGptContextSource>; onAccepted?: () => void }

export function useChatGpt(request: Accessor<QuickChatRequest | undefined>, open: Accessor<boolean>) {
  let provider = "openai-codex";
  const [models, setModels] = createSignal<ChatModel[]>([]);
  const [chats, setChats] = createSignal<RegularChat[]>([]);
  const [chat, setChat] = createSignal<RegularChat>();
  const [prompt, setPrompt] = createSignal("");
  const [draftIncludeContext, setDraftIncludeContext] = createSignal(true);
  const includeContext = () => chat()?.messages.length ? Boolean(chat()?.contextSource) : draftIncludeContext();
  const modelSelection = createModelSelection(models);
  const source = () => includeContext() ? request()?.source() : undefined;
  const responding = () => isResponding(chat());
  const recovering = () => isRecovering(chat());
  const [draftId, setDraftId] = createSignal(crypto.randomUUID());
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [catalogLoading, setCatalogLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  const [pollError, setPollError] = createSignal<string>();
  const [cancellationError, setCancellationError] = createSignal<string>();
  const [catalogError, setCatalogError] = createSignal<string>();
  const [leaseRevision, setLeaseRevision] = createSignal(0);
  const leaseId = crypto.randomUUID();
  let desiredChat: string | undefined;
  const leasedChats = new Set<string>();
  let disposed = false;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let submission: AbortController | undefined;
  let stopOperation: symbol | undefined;
  let selection = 0;
  let pending: { key: string; id: string } | undefined;
  let call = createChatGptCall(provider, leaseId);

  const release = (id?: string) => {
    const targets = id ? [id] : [...leasedChats];
    clearTimeout(leaseTimer);
    setChat(value => value && targets.includes(value.id) ? observingChat(value) : value);

    for (const chatId of targets) { leasedChats.delete(chatId); void call("release", ownershipSchema, { chatId }).catch(() => undefined); }
  };

  const claim = async (id: string) => {
    const claimCall = call;
    const current = generation;
    const selected = selection;
    const ownership = await claimCall("claim", ownershipSchema, { chatId: id });

    if (disposed || generation !== current || desiredChat !== id || selection !== selected) { if (ownership.owned && (disposed || generation !== current || desiredChat !== id)) void claimCall("release", ownershipSchema, { chatId: id }).catch(() => undefined);

    return { owned: false, available: false }; }

    if (ownership.owned) leasedChats.add(id);

    return ownership;
  };

  const fresh = () => {
    desiredChat = undefined; submission?.abort(); submission = undefined; stopOperation = undefined; setBusy(false);
    release();
    selection++; setLoading(false); setDraftId(crypto.randomUUID()); setChat(undefined); setPrompt(""); setError(undefined); setPollError(undefined); setCancellationError(undefined);
  };

  createDependencyEffect(fresh, () => [request()?.id]);

  const loadCatalog = async (current: number) => {
    const started = Date.now();
    const accounts = await call("accounts", chatAccountsSchema);

    if (generation !== current) return;
    const selected = accounts.find(account => account.configured && account.id === provider) ?? accounts.find(account => account.configured);

    if (!selected || selected.id !== provider && (desiredChat || busy())) throw new Error("Sign in to the chat's ChatGPT account in Settings → Providers.");

    if (selected.id !== provider) { setChats([]); setModels([]); }

    provider = selected.id; call = createChatGptCall(provider, leaseId);
    const catalogCall = call;

    await loadCatalogRecords(catalogCall, current, started);
  };

  const loadCatalogRecords = async (catalogCall: typeof call, current: number, started: number) => {
    const [history, catalog] = await Promise.allSettled([catalogCall("list", z.array(regularChatSchema)), catalogCall("models", chatModelsSchema)]);
    const diagnostics = await catalogCall("diagnostics", z.object({ models: z.array(z.object({ message: z.string() })) })).catch(() => undefined);

    if (generation !== current || catalogCall !== call) return;

    if (history.status === "fulfilled") receiveHistory(history.value, started);

    if (catalog.status === "fulfilled") setModels(catalog.value);
    const failures = [...[history, catalog].flatMap(result => result.status === "rejected" ? [String(result.reason)] : []), ...diagnostics?.models.map(value => value.message) ?? []];

    if (failures.length) throw new Error(failures.join("\n"));
  };

  const receiveHistory = (history: RegularChat[], started: number) => {
    setChats(previous => [...history.map(value => {
      if (value.storageDiagnostic) return value;
      const newer = previous.find(item => item.id === value.id && item.updatedAt > value.updatedAt);

      return newer ?? value;
    }), ...previous.filter(value => value.updatedAt >= started && !history.some(item => item.id === value.id))].sort((a, b) => b.updatedAt - a.updatedAt));
  };

  const refreshCatalog = async (catalog: boolean) => {
    const current = generation; const catalogCall = call;
    const started = Date.now();

    try {
      if (catalog) await loadCatalog(current);
      else {
        const history = await catalogCall("list", z.array(regularChatSchema));

        if (generation === current && catalogCall === call) receiveHistory(history, started);
      }

      if (generation === current) setCatalogError(undefined);
    } catch (reason) {
      if (generation === current) setCatalogError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally { if (generation === current) setCatalogLoading(false); }
  };

  watchChatGptCatalog(() => provider, open, refreshCatalog, () => setLeaseRevision(value => value + 1));

  const remember = (value: RegularChat) => {
    setChats(previous => [value, ...previous.filter(item => item.id !== value.id)].sort((a, b) => b.updatedAt - a.updatedAt));
  };

  const preserveStopping = (value: RegularChat): RegularChat => stopOperation && chat()?.id === value.id ? { ...value, status: "stopping" } : value;
  const currentSelection = (current: number, selected: number) => generation === current && selection === selected;
  const releaseSuperseded = (id: string) => { if (desiredChat !== id && !busy() && !responding()) release(id); };

  const receiveChat = (value: RegularChat, acquired = false) => {
    const previous = chat();
    const wasOwned = hasLease(previous);

    if (previous && value.updatedAt < previous.updatedAt) return;

    if (!wasOwned || value.updatedAt !== previous?.updatedAt) modelSelection.restore(value);

    if (!acquired && !wasOwned) value = observingChat(value);
    value = preserveStopping(value);
    setChat(value); remember(value);
  };

  const select = async (id: string) => {
    release();
    desiredChat = id;
    const version = ++selection; const current = generation;
    const selectCall = call;
    setLoading(true); setError(undefined); setPollError(undefined); setCancellationError(undefined);

    try {
      await claim(id);

      if (!currentSelection(current, version)) return;
      const value = await selectCall("read", regularChatSchema, { chatId: id });

      if (currentSelection(current, version)) { setChat(value); modelSelection.restore(value); setPrompt(""); }
    } catch (reason) { if (currentSelection(current, version)) {
      release(id); desiredChat = chat()?.id;
      setError(reason instanceof Error ? reason.message : String(reason));
    } }
    finally { if (currentSelection(current, version)) setLoading(false); }
  };

  createDependencyEffect(() => {
    const id = chat()?.id;

    if (!open() || !id || loading()) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const current = generation;
    const selected = selection;

    const poll = async () => {
      try {
        const value = await call("read", regularChatSchema, { chatId: id });

        if (cancelled || current !== generation || selected !== selection) return;
        receiveChat(value); setPollError(undefined);

        timer = setTimeout(() => void poll(), isResponding(value) ? 400 : 1000);
      } catch (reason) {
        if (cancelled || current !== generation) return;
        setPollError(reason instanceof Error ? reason.message : String(reason)); timer = setTimeout(() => void poll(), 2000);
      }
    };

    timer = setTimeout(() => void poll(), 200);

    return () => { cancelled = true; clearTimeout(timer); };
  }, () => [chat()?.id, open(), loading()]);

  const editable = () => open() && (!chat() || chat()?.ownership?.owned === true);
  const canChooseContext = () => !chat()?.messages.length && !busy() && !loading() && !catalogLoading() && !responding();
  const setIncludeContext = (value: boolean) => { if (canChooseContext()) setDraftIncludeContext(value); };

  const canSend = () => editable() && !busy() && !loading() && !catalogLoading() && models().length > 0 && !responding() && Boolean(prompt().trim());
  const contextSource = () => source()?.messages.length || source()?.selected ? source() : undefined;
  const targetChatId = () => chat()?.id ?? draftId();

  const submissionId = (key: string) => {
    if (pending?.key !== key) pending = { key, id: crypto.randomUUID() };

    return pending.id;
  };

  const acceptSubmission = (id: string, acceptedRequest: QuickChatRequest | undefined) => {
    if (pending?.id === id) pending = undefined;
    acceptedRequest?.onAccepted?.();
  };

  const finishSubmission = (current: number, controller: AbortController) => {
    if (generation === current && submission === controller) { setBusy(false); submission = undefined; }
  };

  const sourceIdentity = (value: ChatGptContextSource | undefined) => [value?.hostId, value?.sessionId];

  const send = async () => {
    if (!canSend()) return;
    const current = generation; const selected = selection; const text = prompt(); const currentRequest = request();
    const id = targetChatId(); const chosenModel = modelSelection.selection(); const capturedSource = contextSource();
    desiredChat = id;
    const submissionKey = JSON.stringify([provider, id, text, chosenModel, sourceIdentity(capturedSource)]);
    const attemptId = submissionId(submissionKey);
    const sendCall: ChatGptCall = call;
    const controller = new AbortController(); submission = controller; stopOperation = undefined;
    setBusy(true); setError(undefined); setCancellationError(undefined);

    try {
      const ownership = await claim(id);

      if (!ownership.owned) throw new Error("Another client holds this chat's editing lease.");
      controller.signal.throwIfAborted();
      const result = await submitChatGpt(sendCall, { chatId: id, prompt: text, ...chosenModel, submissionId: attemptId }, capturedSource, controller.signal);
      const value = result.chat;

      acceptSubmission(attemptId, currentRequest);

      if (generation !== current) return;
      remember(value);

      if (selection === selected && submission === controller) { setCancellationError(result.cancellationError); setChat(value); setPrompt(""); }
    } catch (reason) {
      if (generation !== current) return;

      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { finishSubmission(current, controller); }
  };

  const currentStop = (current: number, operation: symbol) => generation === current && stopOperation === operation;

  const finishStop = (current: number, operation: symbol) => { if (currentStop(current, operation)) { stopOperation = undefined; setBusy(false); } };

  const stopped = (value: RegularChat, current: number, operation: symbol) => {
    if (currentStop(current, operation) && chat()?.id === value.id) { setChat(value); remember(value); }
  };

  const stop = async () => {
    if (submission) { submission.abort();

    return; }

    const id = chat()?.id;

    if (!id || !editable()) return;
    const operation = Symbol(); stopOperation = operation;
    const current = generation; setError(undefined); setCancellationError(undefined); setBusy(true);
    setChat(value => value && { ...value, status: "stopping" });

    try { stopped(await call("stop", regularChatSchema, { chatId: id }), current, operation); }
    catch (reason) { if (currentStop(current, operation)) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { finishStop(current, operation); }
  };

  const refreshLease = async (id: string) => {
    const leaseCall = call;
    const ownership = await claim(id);
    const refreshed = chat()?.id === id ? await leaseCall("read", regularChatSchema, { chatId: id }) : undefined;

    return { ownership, refreshed };
  };

  const receiveLease = (id: string, ownership: PluginOwnership, refreshed: RegularChat | undefined) => {
    if (!ownership.owned) setChat(value => value?.id === id ? { ...value, ownership } : value);

    if (refreshed) receiveChat(refreshed, ownership.owned);
    clearTimeout(leaseTimer);

    if (ownership.owned) leaseTimer = setTimeout(() => setChat(value => value?.id === id ? { ...value, ownership: { owned: false, available: false } } : value), 25000);
  };

  createDependencyEffect(() => {
    setChat(value => value && observingChat(value));

    if (!open()) { if (!busy() && !responding()) release();

    return; }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const renew = async () => {
      const id = desiredChat;
      const selected = selection;
      const current = generation;

      try {
        if (id) {
          const { ownership, refreshed } = await refreshLease(id);

          if (current !== generation) return;

          if (cancelled || desiredChat !== id || selected !== selection) { releaseSuperseded(id);

          return; }

          receiveLease(id, ownership, refreshed);
        }
      } catch {}
      finally { if (!cancelled) timer = setTimeout(() => void renew(), 8000); }
    };

    void renew();

    return () => { cancelled = true; clearTimeout(timer); };
  }, () => [open(), leaseRevision()]);

  onCleanup(() => { disposed = true; desiredChat = undefined; generation++; submission?.abort(); release(); });

  return { models, modelSelection, chats, chat, prompt, setPrompt, source, includeContext, setIncludeContext, canChooseContext, responding, recovering,
    busy, loading: () => loading() || catalogLoading(), editable, error: () => error() ?? cancellationError() ?? catalogError() ?? pollError(), fresh, select, send, stop };
}

type ChatGptCall = <S extends z.ZodType>(action: string, schema: S, args: Record<string, import("zod").JSONType | undefined>) => Promise<z.output<S>>;

function createChatGptCall(providerId: string, leaseId: string) {
  return <S extends z.ZodType,>(action: string, schema: S, args: Record<string, import("zod").JSONType | undefined> = {}) => invoke("plugin_call", { hostId: "local", pluginId: "chatgpt", request: { ...args, action, providerId, leaseId } }, schema);
}

function isRecovering(chat: RegularChat | undefined) { return chat?.status === "error" && chat.interrupted; }

function isResponding(chat: RegularChat | undefined) { return chat?.status === "streaming" || chat?.status === "stopping" || isRecovering(chat); }

function hasLease(chat: RegularChat | undefined) { return chat?.ownership?.owned === true; }

function observingChat(chat: RegularChat): RegularChat { return { ...chat, ownership: { owned: false, available: chat.ownership?.available ?? false } }; }

interface ChatGptSubmissionResult { chat: RegularChat; cancellationError?: string }

async function submitChatGpt(call: ChatGptCall, input: Record<string, import("zod").JSONType | undefined>, source: ChatGptContextSource | undefined, signal: AbortSignal): Promise<ChatGptSubmissionResult> {
  const context = source ? await chatGptContext(source, signal) : undefined;
  signal.throwIfAborted();
  const p = chatGptPrepareToken();
  const prepared = await call("prepare", chatRequirementsSchema, { p });
  signal.throwIfAborted();
  const integrity = await solveChatGptRequirements(prepared, p, signal);
  signal.throwIfAborted();
  const ownership = await call("claim", ownershipSchema, { chatId: input.chatId });

  if (!ownership.owned) throw new Error("Another client holds this chat's editing lease.");
  signal.throwIfAborted();
  let value: RegularChat;

  try {
    value = await call("send", regularChatSchema, { ...input, context, contextSource: source?.title,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, timezoneOffset: new Date().getTimezoneOffset(), ...integrity });
  } catch (error) {
    try { value = await call("read", regularChatSchema, { chatId: input.chatId }); } catch { throw error; }

    if (value.submissionId !== input.submissionId && !value.acceptedSubmissionIds.includes(String(input.submissionId))) throw error;
  }

  if (signal.aborted && value.submissionId === input.submissionId) return cancelAcceptedSubmission(call, value);

  return { chat: value };
}

async function cancelAcceptedSubmission(call: ChatGptCall, accepted: RegularChat): Promise<ChatGptSubmissionResult> {
  try { return { chat: await call("stop", regularChatSchema, { chatId: accepted.id, expectedSubmissionId: accepted.submissionId }) }; }
  catch (reason) {
    const detail = reason instanceof Error ? reason.message : String(reason);

    return { chat: accepted, cancellationError: `Your message was accepted, but cancellation could not be confirmed: ${detail}` };
  }
}
