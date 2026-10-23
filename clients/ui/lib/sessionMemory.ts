import { type Accessor, createMemo } from "solid-js";
import { createMemoFields, createSubscription, type StateUpdate } from "./solid";

import type { AgentState, ChatMessage, Model, RpcEvent, SlashCommand } from "../types";
import type { NativeTransport } from "./nativeTransport";
import { z } from "zod";
import { wireMessageSchema } from "./messageSchemas";
import { pluginMessageMetadata } from "../plugins/messageMetadata";
import { branchMessages } from "./messages";
import { historyViewSchema } from "./responseSchemas";
import { OLDER_HISTORY, olderHistory, olderHistoryMarker } from "./historyWindow";

type SessionResource = Array<RpcEvent | undefined>;

const toolPayloadSchema = wireMessageSchema.pick({ content: true, details: true, toolInput: true, nestedCalls: true });

const stringSchema = z.string();

const SESSION_LIMIT = 256 * 1024 * 1024;

const CACHE_LIMIT = 512 * 1024 * 1024;

const SESSION_COUNT = 20;

const TOOL_PAYLOAD_CONCURRENCY = 2;

type Transport = Pick<NativeTransport, "command" | "subscribe">;

interface CachedSession {
  state: AgentState;
  messages: ChatMessage[];
  models: Model[];
  commands: SlashCommand[];
  thinkingLevels: string[];
  resources: Record<string, SessionResource>;
}

const stores = new WeakMap<Transport, SessionMemory>();

const fifo = new Map<SessionMemory, number>();

const measured = new WeakMap<object, number>();

let activeToolPayloadTransfers = 0;

const waitingToolPayloadTransfers: (() => void)[] = [];

async function transferToolPayload(transfer: () => Promise<void> | undefined) {
  if (activeToolPayloadTransfers >= TOOL_PAYLOAD_CONCURRENCY) await new Promise<void>(resolve => waitingToolPayloadTransfers.push(resolve));
  else activeToolPayloadTransfers++;

  try { await transfer(); }
  finally {
    const next = waitingToolPayloadTransfers.shift();

    if (next) next();
    else activeToolPayloadTransfers--;
  }
}

function bytes<T>(value: T): number {
  const text = stringSchema.safeParse(value);

  if (text.success) return 24 + text.data.length * 2;

  if (!value || Object(value) !== value || value instanceof Function) return 16;
  const object = Object(value);
  const previous = measured.get(object);

  if (previous !== undefined) return previous;
  let size = 64;

  for (const [key, item] of Object.entries(object)) size += 32 + key.length * 2 + bytes(item);
  measured.set(object, size);

  return size;
}

function enforceCacheLimit() {
  let total = [...fifo.values()].reduce((sum, size) => sum + size, 0);

  for (const [store, size] of fifo) {
    if (fifo.size <= SESSION_COUNT && total <= CACHE_LIMIT) break;

    if (store.observed()) continue;
    fifo.delete(store);
    total -= size;
    store.evict();
  }
}

function initialSnapshot(state: AgentState): CachedSession {
  return { state, messages: [], models: [], commands: [], thinkingLevels: ["off"], resources: {} };
}

function stripToolArguments(message: ChatMessage): ChatMessage {
  if (!Array.isArray(message.content)) return message;

  if (!message.content.some((part) => part.type === "toolCall" && (part.partialArgs || Object.keys(part.arguments ?? {}).length))) return message;

  return { ...message, content: message.content.map((part) => part.type === "toolCall"
    ? { type: "toolCall", id: part.id, name: part.name, arguments: {} } : part) };
}

export class SessionMemory {
  private value: CachedSession;
  private listeners = new Set<() => void>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private workLoading = new Map<string, Promise<void>>();
  private olderLoading?: Promise<void>;
  private toolPayloadTransfers: Promise<void> = Promise.resolve();
  private generation = 0;
  private omitted = 0;
  private reserved = 0;
  private batching = 0;
  private resourceReleases = new Map<string, () => void>();
  private decorated = new WeakMap<ChatMessage, ChatMessage>();
  revision?: string;
  constructor(private transport: Transport, private initialState: AgentState) {
    this.value = initialSnapshot(initialState);
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener);

  return () => { this.listeners.delete(listener); enforceCacheLimit(); }; };
  observed() { return this.listeners.size > 0; }
  private notify() { for (const listener of this.listeners) listener(); }

  evict() {
    this.generation++;
    this.revision = undefined;
    this.loaded.clear();
    this.loading.clear();
    this.omitted = 0;
    this.reserved = 0;
    this.value = initialSnapshot(this.initialState);

    for (const release of this.resourceReleases.values()) release();
    this.resourceReleases.clear();
    this.notify();
  }

  retainResource(key: string, value: SessionResource, release: () => void) {
    this.value = { ...this.value, resources: { ...this.value.resources, [key]: value } };
    this.resourceReleases.set(key, release);
    this.commit();
  }

  private dropResources() {
    for (const release of this.resourceReleases.values()) release();
    this.resourceReleases.clear();
    this.value = { ...this.value, resources: {} };
  }

  private trimToolPayloads(size: number) {
    if (size <= SESSION_LIMIT || !this.loaded.size) return size;
    const messages = [...this.value.messages];
    const positions = new Map<string, number[]>();
    messages.forEach((message, index) => {
      const id = message.deferredToolPayload;

      if (id === undefined || !this.loaded.has(id)) return;
      const indices = positions.get(id) ?? [];
      indices.push(index); positions.set(id, indices);
    });

    for (const id of this.loaded) {
      if (size <= SESSION_LIMIT) break;
      this.loaded.delete(id);

      for (const index of positions.get(id) ?? []) {
        const previous = messages[index];
        const next = { ...previous, content: "", details: undefined, toolInput: undefined, nestedCalls: undefined, toolPayloadLoaded: false, toolPayloadEvicted: true };
        size += bytes(next) - bytes(previous);
        messages[index] = next;
      }
    }

    this.value = { ...this.value, messages };

    return bytes(this.value) + this.reserved;
  }

  private trim() {
    let size = this.trimToolPayloads(bytes(this.value) + this.reserved);

    if (size <= SESSION_LIMIT) return size;
    this.dropResources();
    size = bytes(this.value) + this.reserved;

    if (size <= SESSION_LIMIT) return size;
    const messages = this.value.messages.filter((message) => message.id !== "client-memory-limit");
    let removed = 0;

    while (removed < messages.length && size > SESSION_LIMIT - 1024) {
      size -= bytes(messages[removed]) + 32;
      removed++;
    }

    this.omitted += removed;
    const notice: ChatMessage = { id: "client-memory-limit", role: "system", content: `${this.omitted} older messages were removed from this client's memory. The full conversation remains on the host.` };
    this.value = { ...this.value, messages: [notice, ...messages.slice(removed)] };
    const remaining = new Set(this.value.messages.map((message) => message.deferredToolPayload));

    for (const id of this.loaded) if (!remaining.has(id)) this.loaded.delete(id);
    size = bytes(this.value) + this.reserved;

    if (size > SESSION_LIMIT) { this.value = initialSnapshot(this.initialState); this.revision = undefined; }

    return bytes(this.value) + this.reserved;
  }

  private commit() {
    if (this.batching) return;
    fifo.set(this, this.trim());
    enforceCacheLimit();
    this.notify();
  }

  private decorate(message: ChatMessage): ChatMessage {
    if (message.role !== "tool" && !Array.isArray(message.content)) return message;
    const cached = this.decorated.get(message);

    if (cached) return cached;
    const result = this.decorateMessage(message);
    this.decorated.set(message, result);
    this.decorated.set(result, result);

    return result;
  }

  private decorateMessage(message: ChatMessage): ChatMessage {
    if (pluginMessageMetadata(message.customType)?.retainContent) return message;

    if (message.deferredWork) { const entryId = message.entryId ?? message.id;

    return { ...stripToolArguments(message), loadWork: message.loadWork ?? (() => this.loadWork(entryId)) }; }

    if (message.role !== "tool") return stripToolArguments(message);
    const id = message.deferredToolPayload ?? message.toolCallId ?? message.id;
    const loadToolPayload = message.loadToolPayload ?? (() => this.loadToolPayload(id));

    if (message.toolPayloadLoaded) return { ...message, deferredToolPayload: id, loadToolPayload };

    return { ...message, content: "", details: undefined, toolInput: undefined, nestedCalls: undefined, deferredToolPayload: id, toolPayloadLoaded: false, loadToolPayload };
  }

  markRevision(revision: string) { if (fifo.has(this)) this.revision = revision; }

  batch(update: () => void) {
    this.batching++;

    try { update(); } finally { this.batching--; this.commit(); }
  }

  set<K extends keyof CachedSession>(key: K, update: StateUpdate<CachedSession[K]>) {
    const next = update instanceof Function ? update(this.value[key]) : update;

    if (Object.is(next, this.value[key])) return;
    this.value = { ...this.value, [key]: next };

    if (key === "messages") this.value = { ...this.value, messages: this.value.messages.map(message => this.decorate(message)) };
    this.commit();
  }

  /** Loads the work of a finished turn that the daemon left out, and puts it in front of the turn's final response. */
  private loadWork(entryId: string) {
    const previous = this.workLoading.get(entryId);

    if (previous) return previous;
    const generation = this.generation;
    const request = this.transport.command({ type: "get_turn_work", entryId }, historyViewSchema).then(history => {
      if (generation !== this.generation) return;
      const loaded = branchMessages(history.entries, history.leafId);
      this.set("messages", messages => {
        const index = messages.findIndex(message => (message.entryId ?? message.id) === entryId && message.deferredWork);

        if (index < 0) return messages;
        const present = new Set(messages.map(message => message.entryId ?? message.id));
        const work = loaded.flatMap(message => (message.entryId ?? message.id) === entryId ? [{ ...message, id: messages[index].id }] : present.has(message.entryId ?? message.id) ? [] : [message]);

        return [...messages.slice(0, index), ...work, ...messages.slice(index + 1)];
      });
    }).finally(() => this.workLoading.delete(entryId));
    this.workLoading.set(entryId, request);

    return request;
  }

  /** Loads the part of the history just before the loaded messages. */
  loadOlder() {
    const older = olderHistory(this.value.messages);

    if (!older) return Promise.resolve();

    if (this.olderLoading) return this.olderLoading;
    const generation = this.generation;
    const request = this.transport.command({ type: "get_older_history", before: older.before }, historyViewSchema).then(history => {
      if (generation !== this.generation) return;
      const page = [...olderHistoryMarker(history.before, history.olderUsage), ...branchMessages(history.entries, history.leafId)];
      this.set("messages", messages => olderHistory(messages)?.before === older.before ? [...page, ...messages.filter(message => message.id !== OLDER_HISTORY)] : messages);
    }).finally(() => { this.olderLoading = undefined; });
    this.olderLoading = request;

    return request;
  }

  private toolPayloadVersion(id: string) { return this.value.messages.find((message) => message.deferredToolPayload === id)?.toolPayloadVersion; }

  private async fetchToolPayload(id: string, generation: number) {
    const version = this.toolPayloadVersion(id);
    let serialized = "";
    let revision: string | undefined;

    for (;;) {
      const page = await this.transport.command({ type: "get_tool_payload", toolCallId: id, offset: serialized.length, revision, limit: 2 * 1024 * 1024 }, z.object({ chunk: z.string(), length: z.number(), revision: z.string() }));

      if (generation !== this.generation) return;

      if (page.length * 6 > SESSION_LIMIT) throw new Error("This tool payload exceeds the client memory limit.");
      this.reserved = page.length * 6;
      this.commit();

      if (generation !== this.generation) return;
      revision = page.revision;
      serialized += page.chunk;

      if (serialized.length >= page.length) break;

      if (!page.chunk) throw new Error("Incomplete tool payload");
    }

    const output = toolPayloadSchema.parse(JSON.parse(serialized));

    if (generation !== this.generation) return;
    this.reserved = 0;
    this.loaded.delete(id); this.loaded.add(id);
    this.set("messages", (messages) => messages.map((message) => message.deferredToolPayload === id ? { ...message, ...output, toolPayloadLoaded: true, toolPayloadEvicted: false, loadedToolPayloadVersion: version } : message));

    if (!this.value.messages.some((message) => message.deferredToolPayload === id && message.toolPayloadLoaded)) throw new Error("This tool payload could not fit in the client memory limit.");
  }

  private loadToolPayload(id: string) {
    if (this.value.messages.some((message) => message.deferredToolPayload === id && message.toolPayloadLoaded && message.loadedToolPayloadVersion === message.toolPayloadVersion)) return Promise.resolve();
    const previous = this.loading.get(id);

    if (previous) return previous;
    const generation = this.generation;

    const request = this.toolPayloadTransfers.then(() => transferToolPayload(() => generation === this.generation ? this.fetchToolPayload(id, generation) : undefined)).finally(() => {
      if (this.loading.get(id) === request) this.loading.delete(id);

      if (generation === this.generation) { this.reserved = 0;

      if (fifo.has(this)) this.commit(); }
    });

    this.toolPayloadTransfers = request.catch(() => undefined);
    this.loading.set(id, request);

    return request;
  }
}

export function loadOlderHistory(transport: Transport) {
  return memoryFor(transport).loadOlder();
}

export function forgetSession(transport: Transport) {
  const store = stores.get(transport);

  if (store) { fifo.delete(store); store.evict(); }
}

const emptyState: AgentState = { model: null, thinkingLevel: "off", isStreaming: false, sessionId: "", messageCount: 0, pendingMessageCount: 0 };

function memoryFor(transport: Transport, initialState = emptyState) {
  let store = stores.get(transport);

  if (!store) { store = new SessionMemory(transport, initialState); stores.set(transport, store); }

  return store;
}

export function retainSubmittedMessage(transport: Transport, message: ChatMessage) {
  memoryFor(transport).set("messages", current => current.some(item => item.id === message.id) ? current : [...current, { ...message, submissionId: message.id }]);
}

export function discardSubmittedMessage(transport: Transport, id: string) {
  memoryFor(transport).set("messages", current => current.some(item => item.submissionId === id) ? current.filter(item => item.submissionId !== id) : current);
}

export function moveSubmittedMessage(source: Transport, destination: Transport, id: string) {
  const message = memoryFor(source).getSnapshot().messages.find(item => item.submissionId === id);

  if (!message) return;
  retainSubmittedMessage(destination, message);
  discardSubmittedMessage(source, id);
}

export function retainSessionResource(transport: Transport, key: string, value: SessionResource, release: () => void) {
  memoryFor(transport).retainResource(key, value, release);
}

export function useSessionMemory(transport: Accessor<Transport>, initialState: Accessor<AgentState>) {
  const memory = createMemo(() => (memoryFor(transport(), initialState())));
  const subscription = createSubscription(() => memory().subscribe, () => memory().getSnapshot);
  const fields = createMemoFields(subscription);
  const snapshot = () => fields;
  const setState = (update: StateUpdate<AgentState>) => memory().set("state", update);
  const setMessages = (update: StateUpdate<ChatMessage[]>) => memory().set("messages", update);
  const setModels = (update: StateUpdate<Model[]>) => memory().set("models", update);
  const setCommands = (update: StateUpdate<SlashCommand[]>) => memory().set("commands", update);
  const setThinkingLevels = (update: StateUpdate<string[]>) => memory().set("thinkingLevels", update);

  return { get state() { return snapshot().state; }, get messages() { return snapshot().messages; }, get models() { return snapshot().models; }, get commands() { return snapshot().commands; }, get thinkingLevels() { return snapshot().thinkingLevels; }, get resources() { return snapshot().resources; }, get memory() { return memory(); }, setState, setMessages, setModels, setCommands, setThinkingLevels };
}
