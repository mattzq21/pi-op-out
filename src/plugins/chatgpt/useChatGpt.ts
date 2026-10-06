import { z } from "zod";
import { regularChatSchema, chatModelsSchema, chatRequirementsSchema, type RegularChat } from "./chatSchemas";
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { createDependencyEffect } from "../../lib/solid";
import { invoke } from "../../lib/platform";
import { chatGptContext, type ChatGptContextSource } from "./context";
import { chatGptPrepareToken, solveChatGptRequirements } from "./chatGptIntegrity";
import { createModelSelection, type ChatModel } from "./modelSelection";

export type { RegularChat } from "./chatSchemas";

export interface QuickChatRequest { id: string; source: Accessor<ChatGptContextSource>; hostId: string; onAccepted?: () => void }

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
  const [cancellationError, setCancellationError] = createSignal<string>();
  const [reload, setReload] = createSignal(0);
  const host = () => request()?.hostId ?? "local";
  let generation = 0;
  let submission: AbortController | undefined;
  let selection = 0;
  let pending: { key: string; id: string } | undefined;
  const call = <S extends z.ZodType,>(action: string, schema: S, args: Record<string, import("zod").JSONType | undefined> = {}) => invoke("plugin_call", { hostId: host(), pluginId: "chatgpt", request: { action, providerId: provider, ...args } }, schema);

  const fresh = () => {
    selection++; setLoading(false); setDraftId(crypto.randomUUID()); setChat(undefined); setPrompt(""); setError(undefined); setCancellationError(undefined);
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
  }, () => [host(), reload()]);

  const remember = (value: RegularChat) => {
    setChats(previous => [value, ...previous.filter(item => item.id !== value.id)].sort((a, b) => b.updatedAt - a.updatedAt));
  };

  const select = async (id: string) => {
    const version = ++selection; const current = generation;
    setLoading(true); setError(undefined); setCancellationError(undefined);

    try {
      const value = await call("read", regularChatSchema, { chatId: id });

      if (generation === current && selection === version) { setChat(value); modelSelection.restore(value); setPrompt(""); }
    } catch (reason) { if (generation === current && selection === version) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (generation === current && selection === version) setLoading(false); }
  };

  createDependencyEffect(() => {
    const id = chat()?.id;

    if (!open() || !id || !responding()) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const current = generation;

    const poll = async () => {
      try {
        const value = await call("read", regularChatSchema, { chatId: id });

        if (cancelled || current !== generation || chat()?.id !== id) return;
        setChat(value); remember(value); setError(undefined);

        if (isResponding(value)) timer = setTimeout(() => void poll(), 400);
      } catch (reason) {
        if (cancelled || current !== generation) return;
        setError(reason instanceof Error ? reason.message : String(reason)); timer = setTimeout(() => void poll(), 2000);
      }
    };

    timer = setTimeout(() => void poll(), 200);

    return () => { cancelled = true; clearTimeout(timer); };
  }, () => [chat()?.id, responding(), open()]);

  const canSend = () => !busy() && !loading() && models().length > 0 && !responding() && Boolean(prompt().trim());
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

  const send = async () => {
    if (!canSend()) return;
    const current = generation; const selected = selection; const text = prompt(); const currentRequest = request();
    const id = targetChatId(); const chosenModel = modelSelection.selection(); const capturedSource = contextSource();
    const targetHost = host(); const targetProvider = provider;
    const submissionKey = JSON.stringify([targetHost, targetProvider, id, text, chosenModel, capturedSource?.sessionId]);
    const attemptId = submissionId(submissionKey);
    const sendCall: ChatGptCall = (action, schema, args) => invoke("plugin_call", { hostId: targetHost, pluginId: "chatgpt", request: { action, providerId: targetProvider, ...args } }, schema);
    const controller = new AbortController(); submission = controller;
    setBusy(true); setError(undefined); setCancellationError(undefined);

    try {
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
    } finally { if (generation === current) { setBusy(false); submission = undefined; } }
  };

  const finishStop = (current: number) => { if (generation === current) setBusy(false); };

  const stop = async () => {
    if (submission) { submission.abort();

    return; }

    const id = chat()?.id;

    if (!id) return;
    const current = generation; setError(undefined); setCancellationError(undefined); setBusy(true);
    setChat(value => value && { ...value, status: "stopping" });

    try { const value = await call("stop", regularChatSchema, { chatId: id });

    if (generation === current && chat()?.id === id) { setChat(value); remember(value); } }
    catch (reason) { if (generation === current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { finishStop(current); }
  };

  onCleanup(() => { generation++; submission?.abort(); });

  return { models, modelSelection, chats, chat, prompt, setPrompt, source, responding,
    busy, loading, error: () => error() ?? cancellationError(), fresh, select, send, stop, refresh: () => setReload(value => value + 1) };
}

type ChatGptCall = <S extends z.ZodType>(action: string, schema: S, args: Record<string, import("zod").JSONType | undefined>) => Promise<z.output<S>>;

function isResponding(chat: RegularChat | undefined) { return chat?.status === "streaming" || chat?.status === "stopping"; }

interface ChatGptSubmissionResult { chat: RegularChat; cancellationError?: string }

async function submitChatGpt(call: ChatGptCall, input: Record<string, import("zod").JSONType | undefined>, source: ChatGptContextSource | undefined, signal: AbortSignal): Promise<ChatGptSubmissionResult> {
  const context = source ? await chatGptContext(source, signal) : undefined;
  signal.throwIfAborted();
  const p = chatGptPrepareToken();
  const prepared = await call("prepare", chatRequirementsSchema, { p });
  signal.throwIfAborted();
  const integrity = await solveChatGptRequirements(prepared, p, signal);
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
