import { ExtensionRunner, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Counts = { completed: number; failed: number };
type Snapshot = { other: Counts; messages: Record<string, Counts> };
type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Runner = { extensions: { handlers: Map<string, Handler[]> }[] };
const KEY = "pi-desktop-hook-stats";
const PATCH = Symbol.for("piop.hook-stats.adapter");
const observers = Symbol.for("piop.hook-stats.observers");
const empty = (): Counts => ({ completed: 0, failed: 0 });

// Pi has no public per-handler observer. Keep the runner compatibility seam here.
function observe(marker: Handler, wrap: (handler: Handler, event: string) => Handler) {
  const prototype = ExtensionRunner.prototype as unknown as Runner & {
    createContext: (...args: unknown[]) => ExtensionContext;
    [PATCH]?: boolean;
    [observers]?: Map<Handler, typeof wrap>;
  };
  const registry = prototype[observers] ??= new Map();
  registry.set(marker, wrap);
  if (!prototype[PATCH]) {
    const original = prototype.createContext;
    if (typeof original !== "function") throw new Error("This Pi version cannot observe extension hooks");
    prototype.createContext = function (...args) {
      const ctx = original.apply(this, args);
      if (!Array.isArray(this.extensions)) return ctx;
      for (const [sentinel, decorate] of registry) {
        if (!this.extensions.some((extension) => extension.handlers.get("session_start")?.includes(sentinel))) continue;
        for (const extension of this.extensions) for (const [event, handlers] of extension.handlers) {
          extension.handlers.set(event, handlers.map((handler) => handler === sentinel ? handler : decorate(handler, event)));
        }
      }
      return ctx;
    };
    prototype[PATCH] = true;
  }
  return () => registry.delete(marker);
}

export default function hookStats(pi: ExtensionAPI) {
  let sessionId: string | undefined;
  let context: ExtensionContext | undefined;
  let snapshot: Snapshot = { other: empty(), messages: {} };
  let prompt: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let persistPending = false;
  const dirty = new Set<string>();
  const wrapped = new WeakSet<Handler>();
  const publish = () => {
    timer = undefined;
    if (!context) return;
    try {
      if (persistPending) {
        for (const key of dirty) pi.appendEntry(KEY, { sessionId, key, counts: key === "other" ? snapshot.other : snapshot.messages[key] });
        dirty.clear(); persistPending = false;
      }
      context.ui.setStatus(KEY, `json:${JSON.stringify(snapshot)}`);
    } catch { /* Telemetry must not change hook execution or errors. */ }
  };
  const initialize = (ctx: ExtensionContext) => {
    context = ctx;
    const id = ctx.sessionManager.getSessionId();
    if (id === sessionId) return;
    if (timer) clearTimeout(timer);
    timer = undefined; dirty.clear(); persistPending = false; sessionId = id; prompt = undefined;
    snapshot = { other: empty(), messages: {} };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "user") prompt = String(entry.message.timestamp);
      if (entry.type !== "custom" || entry.customType !== KEY) continue;
      const data = entry.data as { key?: string; counts?: Counts };
      if (!data || typeof data.key !== "string" || !data.counts || !Number.isSafeInteger(data.counts.completed) || !Number.isSafeInteger(data.counts.failed) || data.counts.failed < 0 || data.counts.completed < data.counts.failed) continue;
      if (data.key !== "other") snapshot.messages[data.key] = { ...data.counts };
    }
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== KEY) continue;
      const data = entry.data as { sessionId?: string; key?: string; counts?: Counts };
      if (data?.sessionId === id && data.key === "other" && data.counts && Number.isSafeInteger(data.counts.completed) && Number.isSafeInteger(data.counts.failed) && data.counts.failed >= 0 && data.counts.completed >= data.counts.failed) snapshot.other = { ...data.counts };
    }
  };
  const start = (_event: unknown, ctx: ExtensionContext) => { initialize(ctx); publish(); };
  pi.on("session_start", start);
  const messageStart = (event: { message: { role: string; timestamp?: number } }, ctx: ExtensionContext) => {
    initialize(ctx);
    if (event.message?.role === "user") {
      prompt = String(event.message.timestamp);
      snapshot.messages[prompt] ??= empty();
      dirty.add(prompt);
      persistPending = true;
      timer ??= setTimeout(publish, 100);
    }
  };
  pi.on("message_start", messageStart);
  const stop = () => { if (timer) clearTimeout(timer); persistPending = true; publish(); dispose(); };
  pi.on("session_shutdown", stop);
  const dispose = observe(start, (handler, eventName) => {
    if (wrapped.has(handler) || handler === stop || handler === messageStart) return handler;
    const replacement: Handler = async (event, ctx) => {
      initialize(ctx);
      const owner = sessionId;
      if (eventName === "message_start" && event.message?.role === "user") prompt = String(event.message.timestamp);
      const key = eventName.startsWith("message_") ? prompt : "other";
      const bucket = key === "other" ? snapshot.other : key ? snapshot.messages[key] ??= empty() : undefined;
      let failed = false;
      try {
        const result = await handler(event, ctx);
        if (eventName === "message_end") {
          const replacement = (result as { message?: { role?: unknown } } | null | undefined)?.message;
          // Match emitMessageEnd's rejection while leaving error reporting to Pi.
          failed = Boolean(replacement && replacement.role !== event.message.role);
        }
        return result;
      }
      catch (error) { failed = true; throw error; }
      finally {
        if (bucket && owner === sessionId && owner === ctx.sessionManager.getSessionId()) {
          bucket.completed += 1; bucket.failed += Number(failed); dirty.add(key!);
          persistPending ||= eventName !== "message_update";
          if (eventName === "session_shutdown") publish();
          else timer ??= setTimeout(publish, 100);
        }
      }
    };
    wrapped.add(replacement);
    return replacement;
  });
}
