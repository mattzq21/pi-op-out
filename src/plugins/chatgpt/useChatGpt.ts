import { z } from "zod";
import { regularChatSchema, chatModelsSchema, chatRequirementsSchema, type RegularChat } from "./chatSchemas";
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { createDependencyEffect } from "../../lib/solid";
import { invoke } from "../../lib/platform";
import { chatGptContext, type ChatGptContextSource } from "./context";
import { chatGptPrepareToken, solveChatGptRequirements } from "./chatGptIntegrity";
import { createModelSelection, type ChatModel } from "./modelSelection";
import { ownershipSchema, type PluginOwnership } from "../ownership";

export type { RegularChat } from "./chatSchemas";

export interface QuickChatRequest { id: string; source: Accessor<ChatGptContextSource>; onAccepted?: () => void }

export function useChatGpt(request: Accessor<QuickChatRequest | undefined>, open: Accessor<boolean>) {
  const provider = "openai-codex";
  const [models, setModels] = createSignal<ChatModel[]>([]);
  const [chats, setChats] = createSignal<RegularChat[]>([]);
  const [chat, setChat] = createSignal<RegularChat>();
  const [prompt, setPrompt] = createSignal("");
  const modelSelection = createModelSelection(models);
  const source = () => request()?.source();
  const responding = () => isResponding(chat());
  const [draftId, setDraftId] = createSignal(crypto.randomUUID());
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [pollError, setPollError] = createSignal<string>();
  const [cancellationError, setCancellationError] = createSignal<string>();
  const [reload, setReload] = createSignal(0);
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
  const call = <S extends z.ZodType,>(action: string, schema: S, args: Record<string, import("zod").JSONType | undefined> = {}) => invoke("plugin_call", { hostId: "local", pluginId: "chatgpt", request: { ...args, action, providerId: provider, leaseId } }, schema);

  const release = (id?: string) => {
    const targets = id ? [id] : [...leasedChats];
    clearTimeout(leaseTimer);
    setChat(value => value && targets.includes(value.id) ? observingChat(value) : value);

    for (const chatId of targets) { leasedChats.delete(chatId); void call("release", ownershipSchema, { chatId }).catch(() => undefined); }
  };

  const claim = async (id: string) => {
    const ownership = await call("claim", ownershipSchema, { chatId: id });

    if (disposed || desiredChat !== id) { if (ownership.owned) release(id);

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
  createDependencyEffect(() => {
    const current = ++generation; submission?.abort(); setBusy(false); fresh(); setLoading(true);
    setChats([]); setModels([]);
    void Promise.all([call("list", z.array(regularChatSchema)), call("models", chatModelsSchema)]).then(([history, catalog]) => {
      if (generation !== current) return;
      setChats(history); setModels(catalog);
    }).catch(reason => { if (generation === current) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (generation === current) setLoading(false); });

    return () => { generation++; };
  }, () => [reload()]);

  const remember = (value: RegularChat) => {
    setChats(previous => [value, ...previous.filter(item => item.id !== value.id)].sort((a, b) => b.updatedAt - a.updatedAt));
  };

  const receiveChat = (value: RegularChat, acquired = false) => {
    const previous = chat();
    const wasOwned = hasLease(previous);

    if (previous && value.updatedAt < previous.updatedAt) return;

    if (!wasOwned || value.updatedAt !== previous?.updatedAt) modelSelection.restore(value);

    if (!acquired && !wasOwned) value = observingChat(value);
    setChat(value); remember(value);
  };

  const select = async (id: string) => {
    release();
    desiredChat = id;
    const version = ++selection; const current = generation;
    setLoading(true); setError(undefined); setPollError(undefined); setCancellationError(undefined);

    try {
      await claim(id);
      const value = await call("read", regularChatSchema, { chatId: id });

      if (generation === current && selection === version) { setChat(value); modelSelection.restore(value); setPrompt(""); }
    } catch (reason) { if (generation === current && selection === version) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (generation === current && selection === version) setLoading(false); }
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
  const canSend = () => editable() && !busy() && !loading() && models().length > 0 && !responding() && Boolean(prompt().trim());
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
      setCancellationError(result.cancellationError);

      if (selection === selected) { setChat(value); setPrompt(""); }
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
    const ownership = await claim(id);
    const refreshed = chat()?.id === id ? await call("read", regularChatSchema, { chatId: id }) : undefined;

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

      try {
        if (id) {
          const { ownership, refreshed } = await refreshLease(id);

          if (cancelled || desiredChat !== id || selected !== selection) { if (!busy() && !responding()) release(id);

          return; }

          receiveLease(id, ownership, refreshed);
        }
      } catch {}
      finally { if (!cancelled) timer = setTimeout(() => void renew(), 8000); }
    };

    void renew();

    return () => { cancelled = true; clearTimeout(timer); };
  }, () => [open()]);

  onCleanup(() => { disposed = true; desiredChat = undefined; generation++; submission?.abort(); release(); });

  return { models, modelSelection, chats, chat, prompt, setPrompt, source, responding,
    busy, loading, editable, error: () => error() ?? cancellationError() ?? pollError(), fresh, select, send, stop, refresh: () => setReload(value => value + 1) };
}

type ChatGptCall = <S extends z.ZodType>(action: string, schema: S, args: Record<string, import("zod").JSONType | undefined>) => Promise<z.output<S>>;

function isResponding(chat: RegularChat | undefined) { return chat?.status === "streaming" || chat?.status === "stopping"; }

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
