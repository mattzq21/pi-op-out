import { type Accessor, batch, createComputed, createMemo, onCleanup } from "solid-js";
import { $RAW, createStore, reconcile, unwrap, type SetStoreFunction } from "solid-js/store";
import type { StateUpdate } from "./solid";

import type { AgentState, ChatMessage, Model, RpcEvent, SlashCommand } from "../types";
import type { NativeTransport } from "./nativeTransport";
import { z } from "zod";
import { wireMessageSchema } from "./messageSchemas";
import { branchMessages } from "./messages";
import { historyOutlineSchema, historyViewSchema } from "./responseSchemas";
import { isDaemonRefusal } from "./commandRejected";
import { OLDER_HISTORY, olderHistory, olderHistoryMarker } from "./historyWindow";

type SessionResource = Array<RpcEvent | undefined>;

export type HistoryOutline = z.infer<typeof historyOutlineSchema>["responses"];

function outlineBefore(listed: { before: string; items: HistoryOutline } | undefined, before: string) {
  if (!listed) return undefined;

  if (listed.before === before) return listed.items;
  const end = listed.items.findIndex(item => item.start === before);

  return end < 0 ? undefined : listed.items.slice(0, end);
}

const toolPayloadSchema = wireMessageSchema.pick({ content: true, details: true, toolInput: true, nestedCalls: true });

const stringSchema = z.string();

const SESSION_LIMIT = 256 * 1024 * 1024;

const CACHE_LIMIT = 512 * 1024 * 1024;

const SESSION_COUNT = 20;

const TOOL_PAYLOAD_CONCURRENCY = 2;

type Transport = Pick<NativeTransport, "command" | "subscribe"> & Partial<Pick<NativeTransport, "isConnected">>;

interface CachedSession {
  state: AgentState;
  messages: ChatMessage[];
  models: Model[];
  commands: SlashCommand[];
  thinkingLevels: string[];
  resources: Record<string, SessionResource>;
  outline?: { before: string; items: HistoryOutline };
}

const stores = new WeakMap<Transport, SessionMemory>();

const fifo = new Map<SessionMemory, number>();

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

// About how much memory a value takes. Store values change in place, so no size is kept between calls.
function bytes<T>(value: T): number {
  const text = stringSchema.safeParse(value);

  if (text.success) return 24 + text.data.length * 2;

  if (!value || Object(value) !== value || value instanceof Function) return 16;
  let size = 64;

  for (const [key, item] of Object.entries(Object(value))) size += 32 + key.length * 2 + bytes(item);

  return size;
}

// True for a value that is already in a session store, so it is unchanged since it was measured and decorated.
const stored = (value: object) => (value as { [$RAW]?: object })[$RAW] !== undefined;

// Copies the parts of a value that come from outside the store. The store changes its objects in place,
// so it must not share them with event payloads or other owners. Parts already in the store stay as they are.
function adopt<T>(value: T): T {
  if (!value || typeof value !== "object" || stored(value)) return value;

  if (Array.isArray(value)) return value.map(adopt) as T;

  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, adopt(item)])) as T;
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

// A fresh copy: the store changes its objects in place, so they must not be shared.
function initialSnapshot(state: AgentState): CachedSession {
  return { state: structuredClone(unwrap(state)), messages: [], models: [], commands: [], thinkingLevels: ["off"], resources: {} };
}

function stripToolArguments(message: ChatMessage): ChatMessage {
  if (!Array.isArray(message.content)) return message;

  if (!message.content.some((part) => part.type === "toolCall" && (part.partialArgs || Object.keys(part.arguments ?? {}).length))) return message;

  return { ...message, content: message.content.map((part) => part.type === "toolCall"
    ? { type: "toolCall", id: part.id, name: part.name, arguments: {} } : part) };
}

// The client copy of one conversation. It is a Solid store: a change notifies only what reads the changed field or message.
export class SessionMemory {
  readonly data: CachedSession;
  private setData: SetStoreFunction<CachedSession>;
  private observers = 0;
  // The size of each stored message object, which stays the same object while the store changes it in place.
  private messageSizes = new WeakMap<object, number>();
  private messagesSize = 0;
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private workLoading = new Map<string, Promise<void>>();
  private olderLoading?: Promise<void>;
  private outlineLoading?: { before: string; stop: () => void };
  private toolPayloadTransfers: Promise<void> = Promise.resolve();
  private generation = 0;
  private omitted = 0;
  private reserved = 0;
  private batching = 0;
  private resourceReleases = new Map<string, () => void>();
  revision?: string;
  constructor(private transport: Transport, private initialState: AgentState) {
    [this.data, this.setData] = createStore(initialSnapshot(initialState));
  }
  // Marks the conversation as shown, so the cache limit does not evict it.
  observe() { this.observers++;

  return () => { this.observers--; enforceCacheLimit(); }; }
  observed() { return this.observers > 0; }

  private reset() {
    this.messageSizes = new WeakMap();
    this.messagesSize = 0;
    this.setData(reconcile(initialSnapshot(this.initialState)));
  }

  // Changes the messages to match the next list. Messages with the same ID keep their store object, and only their changed fields notify.
  private applyMessages(next: ChatMessage[]) {
    const adopted = next.map(adopt);
    const sizes = adopted.map(message => stored(message) ? undefined : bytes(message));
    this.setData("messages", reconcile(adopted, { key: "id" }));
    const saved = unwrap(this.data.messages);
    let total = 0;

    saved.forEach((message, index) => {
      const measured = sizes[index];
      const size = measured ?? this.messageSizes.get(message) ?? bytes(message);

      if (measured !== undefined || !this.messageSizes.has(message)) this.messageSizes.set(message, size);
      total += size;
    });
    this.messagesSize = total;
  }

  private size() {
    const { messages: _messages, ...rest } = unwrap(this.data);

    return bytes(rest) + this.messagesSize + this.reserved;
  }

  evict() {
    this.generation++;
    this.outlineLoading?.stop(); this.outlineLoading = undefined;
    this.revision = undefined;
    this.loaded.clear();
    this.loading.clear();
    this.omitted = 0;
    this.reserved = 0;
    this.reset();

    for (const release of this.resourceReleases.values()) release();
    this.resourceReleases.clear();
  }

  retainResource(key: string, value: SessionResource, release: () => void) {
    this.setData("resources", key, adopt(value));
    this.resourceReleases.set(key, release);
    this.commit();
  }

  private dropResources() {
    for (const release of this.resourceReleases.values()) release();
    this.resourceReleases.clear();
    this.setData("resources", reconcile({}));
  }

  private trimToolPayloads(size: number) {
    if (size <= SESSION_LIMIT || !this.loaded.size) return size;
    const messages = [...this.data.messages];
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

    this.applyMessages(messages);

    return this.size();
  }

  private trim() {
    let size = this.trimToolPayloads(this.size());

    if (size <= SESSION_LIMIT) return size;
    this.dropResources();
    size = this.size();

    if (size <= SESSION_LIMIT) return size;
    const messages = this.data.messages.filter((message) => message.id !== "client-memory-limit");
    let removed = 0;

    while (removed < messages.length && size > SESSION_LIMIT - 1024) {
      size -= bytes(messages[removed]) + 32;
      removed++;
    }

    this.omitted += removed;
    const notice: ChatMessage = { id: "client-memory-limit", role: "system", content: `${this.omitted} older messages were removed from this client's memory. The full conversation remains on the host.` };
    this.applyMessages([notice, ...messages.slice(removed)]);
    const remaining = new Set(this.data.messages.map((message) => message.deferredToolPayload));

    for (const id of this.loaded) if (!remaining.has(id)) this.loaded.delete(id);
    size = this.size();

    if (size > SESSION_LIMIT) { this.reset(); this.revision = undefined; }

    return this.size();
  }

  private commit() {
    if (this.batching) return;
    fifo.set(this, this.trim());
    enforceCacheLimit();
  }

  // Stored messages were decorated when they entered the store.
  private decorate(message: ChatMessage): ChatMessage {
    if (stored(message) || (message.role !== "tool" && !Array.isArray(message.content))) return message;

    return this.decorateMessage(message);
  }

  private decorateMessage(message: ChatMessage): ChatMessage {
    if (message.pluginMessage?.retainContent) return message;

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

    try { batch(update); } finally { this.batching--; this.commit(); }
  }

  // Changes single messages: change sets a message at an index of the list, or adds one at its end. Each changed
  // message is merged into the store at its place, so no new list is built and only the changed fields update.
  // Gives true when something changed.
  changeMessages(change: (messages: ChatMessage[]) => boolean): boolean {
    const current = this.data.messages;
    const written = new Map<number, ChatMessage>();
    const added: ChatMessage[] = [];
    const at = (index: number) => written.get(index) ?? (index < current.length ? current[index] : added[index - current.length]);
    const view = new Proxy({} as ChatMessage[], {
      get: (_target, key) => {
        if (key === "length") return current.length + added.length;
        if (key === "push") return (...values: ChatMessage[]) => added.push(...values) + current.length;
        if (typeof key === "string" && /^\d+$/.test(key)) return at(Number(key));
        return undefined;
      },
      set: (_target, key, value: ChatMessage) => {
        if (typeof key !== "string" || !/^\d+$/.test(key)) return false;
        const index = Number(key);
        if (index < current.length) written.set(index, value); else added[index - current.length] = value;
        return true;
      },
    });

    if (!change(view) || (!written.size && !added.length)) return false;
    batch(() => {
      for (const [index, message] of written) {
        const saved = unwrap(this.data.messages)[index];
        this.setData("messages", index, reconcile(adopt(this.decorate(message)), { key: "id" }));
        this.resize(saved, unwrap(this.data.messages)[index]);
      }
      for (const message of added) {
        this.setData("messages", this.data.messages.length, adopt(this.decorate(message)));
        this.resize(undefined, unwrap(this.data.messages)[this.data.messages.length - 1]);
      }
    });
    this.commit();

    return true;
  }

  // Keeps the total size of the messages right after one message changed.
  private resize(previous: ChatMessage | undefined, next: ChatMessage) {
    if (previous) this.messagesSize -= this.messageSizes.get(previous) ?? 0;
    const size = bytes(next);
    this.messageSizes.set(next, size);
    this.messagesSize += size;
  }

  set<K extends keyof CachedSession>(key: K, update: StateUpdate<CachedSession[K]>) {
    const current = this.data[key];
    const next = update instanceof Function ? update(current) : update;

    if (Object.is(next, current)) return;

    if (key === "messages") this.applyMessages((next as ChatMessage[]).map(message => this.decorate(message)));
    else if (key === "state") this.setData("state", reconcile(adopt(next as AgentState), { key: "id" }));
    else this.setData(key, adopt(next) as never);
    this.commit();
  }

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
        const key = (message: ChatMessage) => message.entryId ?? message.id;
        const later = new Set(messages.slice(index + 1).map(key));
        const work = loaded.flatMap(message => key(message) === entryId ? [{ ...message, id: messages[index].id }] : later.has(key(message)) ? [] : [message]);
        const moved = new Set(work.map(key));

        return [...messages.slice(0, index).filter(message => !moved.has(key(message))), ...work, ...messages.slice(index + 1)];
      });
    }).finally(() => this.workLoading.delete(entryId));
    this.workLoading.set(entryId, request);

    return request;
  }

  loadOlder(through?: string) {
    const older = olderHistory(this.data.messages);

    if (!older) return Promise.resolve();

    if (this.olderLoading) return this.olderLoading;
    const generation = this.generation;
    const request = this.transport.command({ type: "get_older_history", before: older.before, ...(through ? { through } : {}) }, historyViewSchema).then(history => {
      if (generation !== this.generation) return;
      const page = [...olderHistoryMarker(history.before, history.olderUsage), ...branchMessages(history.entries, history.leafId)];
      this.set("messages", messages => olderHistory(messages)?.before === older.before ? [...page, ...messages.filter(message => message.id !== OLDER_HISTORY)] : messages);
    }).finally(() => { this.olderLoading = undefined; });
    this.olderLoading = request;

    return request;
  }

  loadOutline(before: string, onError: (reason: unknown) => void) {
    if (outlineBefore(this.data.outline, before) || this.outlineLoading?.before === before) return;
    this.outlineLoading?.stop();
    const generation = this.generation; let stopped = false; let stopRetry: (() => void) | undefined;
    const loading = { before, stop: () => { stopped = true; stopRetry?.(); } };
    this.outlineLoading = loading;
    const load = () => this.transport.command({ type: "get_history_outline", before }, historyOutlineSchema).then(({ responses }) => {
      if (stopped || generation !== this.generation) return;
      this.outlineLoading = undefined;
      this.set("outline", { before, items: responses });
    }, reason => {
      if (stopped || generation !== this.generation) return;

      if (this.transport.isConnected?.() === false || isDaemonRefusal(reason)) stopRetry = this.transport.subscribe(event => { if (event.type === "connection_restored" || event.type === "pi_started") { stopRetry?.(); stopRetry = undefined; if (!stopped) void load(); } });
      else { this.outlineLoading = undefined; onError(reason); }
    });
    void load();
  }

  private toolPayloadVersion(id: string) { return this.data.messages.find((message) => message.deferredToolPayload === id)?.toolPayloadVersion; }

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

    if (!this.data.messages.some((message) => message.deferredToolPayload === id && message.toolPayloadLoaded)) throw new Error("This tool payload could not fit in the client memory limit.");
  }

  private loadToolPayload(id: string) {
    if (this.data.messages.some((message) => message.deferredToolPayload === id && message.toolPayloadLoaded && message.loadedToolPayloadVersion === message.toolPayloadVersion)) return Promise.resolve();
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

export function loadOlderHistory(transport: Transport, through?: string) {
  return memoryFor(transport).loadOlder(through);
}

export function loadHistoryOutline(transport: Transport, before: string, onError: (reason: unknown) => void) {
  memoryFor(transport).loadOutline(before, onError);
}

export function useHistoryOutline(transport: Accessor<Transport | undefined>, before: Accessor<string | undefined>): Accessor<HistoryOutline> {
  return createMemo(() => { const last = before(); const current = transport();

  return last && current ? outlineBefore(memoryFor(current).data.outline, last) ?? [] : []; });
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
  const message = memoryFor(source).data.messages.find(item => item.submissionId === id);

  if (!message) return;
  retainSubmittedMessage(destination, { ...unwrap(message) });
  discardSubmittedMessage(source, id);
}

export function retainSessionResource(transport: Transport, key: string, value: SessionResource, release: () => void) {
  memoryFor(transport).retainResource(key, value, release);
}

export function useSessionMemory(transport: Accessor<Transport>, initialState: Accessor<AgentState>) {
  const memory = createMemo(() => (memoryFor(transport(), initialState())));
  createComputed(() => onCleanup(memory().observe()));
  const snapshot = () => memory().data;
  const setState = (update: StateUpdate<AgentState>) => memory().set("state", update);
  const setMessages = (update: StateUpdate<ChatMessage[]>) => memory().set("messages", update);
  const setModels = (update: StateUpdate<Model[]>) => memory().set("models", update);
  const setCommands = (update: StateUpdate<SlashCommand[]>) => memory().set("commands", update);
  const setThinkingLevels = (update: StateUpdate<string[]>) => memory().set("thinkingLevels", update);

  return { get state() { return snapshot().state; }, get messages() { return snapshot().messages; }, get models() { return snapshot().models; }, get commands() { return snapshot().commands; }, get thinkingLevels() { return snapshot().thinkingLevels; }, get resources() { return snapshot().resources; }, get memory() { return memory(); }, setState, setMessages, setModels, setCommands, setThinkingLevels };
}
