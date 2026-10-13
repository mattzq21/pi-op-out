import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ContextCapSessionRequest } from "./channel.ts";
import {
  CAP_ENTRY, capRangeError, formatTokens, parseCapCommand,
  type ContextCapDefaults, type ContextCapEntry, type ContextCapSession, type ContextCapSource, type ContextCapState,
} from "./interface.ts";

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:models-refreshed", handler: (event: { ctx: ExtensionContext }) => void): () => void;
    emit(channel: "piop:models-refreshed", event: { ctx: ExtensionContext }): void;
  }
}

type Model = NonNullable<ExtensionContext["model"]>;

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

type Choice = { cap: number | null; source: ContextCapSource };

/** The latest choice entry on the branch and the clamped window recorded after it, if any. */
type Logged = { choice?: Choice; clamp?: number };

type Operation = { kind: "manual"; cap: number | null } | { kind: "reset" } | { kind: "defaults"; defaults: ContextCapDefaults };

type Pending = { operation: Operation; resolve: (state: ContextCapState) => void; reject: (error: Error) => void };

type Subscriber = { listener: (state: ContextCapState) => void; onError: (error: Error) => void };

const entrySchema = Type.Object({
  cap: Type.Union([Type.Null(), Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })]),
  source: Type.Union([Type.Literal("manual"), Type.Literal("config"), Type.Literal("agent_definition"), Type.Literal("modelMax")]),
});

const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

const sameChoice = (left: Choice | undefined, right: Choice | undefined) => left?.cap === right?.cap && left?.source === right?.source;

const sameState = (left: ContextCapState | undefined, right: ContextCapState) => left?.cap === right.cap && left.source === right.source && left.appliedWindow === right.appliedWindow;

/** Reads the chosen cap from the branch. A trailing modelMax entry is a clamp; the choice is the entry before it. */
export function readLog(branch: Branch): Logged {
  let clamp: number | undefined;

  for (const entry of [...branch].reverse()) {
    if (entry.type !== "custom" || entry.customType !== CAP_ENTRY) continue;

    if (!Check(entrySchema, entry.data)) throw new Error("Saved context cap entry " + entry.id + " is invalid");
    const data: ContextCapEntry = entry.data;

    if (data.source === "modelMax") {
      if (data.cap === null) throw new Error("Saved context cap entry " + entry.id + " has no clamped window");
      clamp ??= data.cap;
      continue;
    }

    const error = data.cap === null ? undefined : capRangeError(data.cap);

    if (error) throw new Error("Saved context cap entry " + entry.id + " is invalid: " + error);

    return { choice: { cap: data.cap, source: data.source }, clamp };
  }

  if (clamp !== undefined) throw new Error("Saved context cap history has a clamped window without a chosen cap");

  return {};
}

/** Resolves agent definition, provider/model config, general config, then the model default. */
export function resolveDefaults(defaults: ContextCapDefaults): Choice {
  if (defaults.agentDefinition !== undefined) return { cap: defaults.agentDefinition, source: "agent_definition" };

  if (defaults.modelConfig !== undefined) return { cap: defaults.modelConfig, source: "config" };

  return { cap: defaults.generalConfig ?? null, source: "config" };
}

function validateDefaults(defaults: ContextCapDefaults) {
  for (const [value, label] of [[defaults.agentDefinition, "Agent definition context cap"], [defaults.modelConfig, "Model context cap setting"], [defaults.generalConfig, "General context cap setting"]] as const) {
    const error = typeof value === "number" ? capRangeError(value, label) : undefined;

    if (error) throw new Error(error);
  }
}

function describe(state: ContextCapState) {
  const source = state.source === "agent_definition" ? "agent definition" : state.source;
  const choice = state.cap === null ? "model default" : formatTokens(state.cap) + " tokens";
  const applied = state.appliedWindow === null ? "no model selected" : "applied window " + formatTokens(state.appliedWindow) + " tokens";

  return "Context cap: " + choice + " (" + source + "); " + applied;
}

export default function contextWindowCap(pi: ExtensionAPI) {
  const originals = new Map<Model, number>();
  const pending: Pending[] = [];
  const subscribers = new Set<Subscriber>();
  let context: ExtensionContext | undefined;
  let model: Model | undefined;
  let choice: Choice | undefined;
  let defaults: ContextCapDefaults | undefined;
  let logged: Logged = {};
  let restored = false;
  let closed = false;
  let broken: Error | undefined;
  let published: ContextCapState | undefined;
  let draining = false;
  let settle!: { resolve: () => void; reject: (error: Error) => void };
  let initialized = false;
  const ready = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
  ready.catch(() => undefined);

  const track = (next: Model | undefined) => {
    if (next && !originals.has(next)) originals.set(next, next.contextWindow);
    model = next;
  };

  const nativeWindow = (target: Model) => originals.get(target) ?? target.contextWindow;

  const appliedFor = (next: Choice, target: Model | undefined) => {
    if (!target) return null;
    const native = nativeWindow(target);

    return next.cap === null ? native : Math.min(native, next.cap);
  };

  const clampFor = (next: Choice) => model && next.cap !== null && nativeWindow(model) < next.cap ? nativeWindow(model) : undefined;

  const budgetError = (window: number, target: Model) => {
    const budgets = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(target);
    const minimum = budgets.reserveTokens + budgets.keepRecentTokens + 1;

    if (window >= minimum) return undefined;

    return "A " + formatTokens(window) + "-token context window for " + target.provider + "/" + target.id + " is too small for Pi's compaction budgets. Use at least "
      + formatTokens(minimum) + " tokens, or reduce Pi's reserve and recent-history budgets.";
  };

  const state = (): ContextCapState | undefined => choice && { cap: choice.cap, source: choice.source, appliedWindow: appliedFor(choice, model) };

  const send = (subscriber: Subscriber, value: ContextCapState) => {
    try { subscriber.listener(value); } catch (error) { subscriber.onError(asError(error)); }
  };

  const report = (error: Error) => {
    for (const subscriber of [...subscribers]) subscriber.onError(error);
    context?.ui.notify(error.message, "error");
  };

  const publish = () => {
    const current = state();

    if (!current || sameState(published, current)) return;
    published = current;

    if (initialized) for (const subscriber of [...subscribers]) send(subscriber, current);
  };

  const initialize = () => {
    if (initialized || !restored || !choice || !defaults) return;
    initialized = true;
    published = state();
    settle.resolve();

    for (const subscriber of [...subscribers]) if (published) send(subscriber, published);
  };

  const append = (data: ContextCapEntry) => { pi.appendEntry(CAP_ENTRY, data); };

  /** Appends the entries that bring the branch history to the effective choice and clamp. */
  const record = (next: Choice) => {
    const clamp = clampFor(next);

    if (!sameChoice(logged.choice, next)) {
      append({ cap: next.cap, source: next.source });
      logged = { choice: next };
    }

    if (logged.clamp === clamp) return;

    append(clamp === undefined ? { cap: next.cap, source: next.source } : { cap: clamp, source: "modelMax" });
    logged = { choice: next, clamp };
  };

  /** Writes the effective window to the current model and restores every other model this extension changed. */
  const apply = () => {
    for (const [target, original] of originals) if (target !== model && target.contextWindow !== original) target.contextWindow = original;

    if (!model || !choice) return;
    const window = appliedFor(choice, model);

    if (window !== null && model.contextWindow !== window) model.contextWindow = window;
  };

  const commit = (next: Choice) => {
    record(next);
    choice = next;
    apply();
    publish();
  };

  const requireBudgets = (next: Choice) => {
    const window = appliedFor(next, model);
    const error = model && window !== null ? budgetError(window, model) : undefined;

    if (error) throw new Error(error);
  };

  const validateManual = (cap: number | null) => {
    if (cap !== null) {
      const error = capRangeError(cap);

      if (error) throw new Error(error);

      if (!model) throw new Error("Select a model before setting a numeric context cap");

      if (cap > nativeWindow(model)) throw new Error(formatTokens(cap) + " tokens exceeds the " + formatTokens(nativeWindow(model)) + "-token context window of " + model.provider + "/" + model.id);
    }

    requireBudgets({ cap, source: "manual" });
  };

  const run = (operation: Operation) => {
    if (operation.kind === "manual") {
      validateManual(operation.cap);
      commit({ cap: operation.cap, source: "manual" });

      return;
    }

    if (operation.kind === "reset") {
      if (!defaults) throw new Error("Context cap defaults are not available yet");
      const next = resolveDefaults(defaults);
      requireBudgets(next);
      commit(next);

      return;
    }

    const next = choice?.source === "manual" ? choice : resolveDefaults(operation.defaults);

    if (choice && !sameChoice(choice, next)) requireBudgets(next);
    const first = !choice;
    defaults = operation.defaults;
    commit(next);

    if (!first) return;
    const window = appliedFor(next, model);
    const error = model && window !== null ? budgetError(window, model) : undefined;

    if (error) report(new Error(error));
  };

  const drain = () => {
    if (draining || closed || !restored || !context?.isIdle()) return;
    draining = true;

    try {
      while (pending.length && !closed && !broken && context.isIdle()) {
        const item = pending.shift()!;

        try {
          run(item.operation);
          initialize();
          item.resolve(state()!);
        } catch (error) { item.reject(asError(error)); }
      }

      if (broken) for (const item of pending.splice(0)) item.reject(broken);
    } finally { draining = false; }
  };

  const enqueue = (operation: Operation, validate: () => void) => {
    if (closed) return Promise.reject(new Error("The session has ended"));

    if (broken) return Promise.reject(broken);

    try { validate(); } catch (error) { return Promise.reject(asError(error)); }

    return new Promise<ContextCapState>((resolve, reject) => {
      pending.push({ operation, resolve, reject });
      drain();
    });
  };

  const session: ContextCapSession = {
    async getState() {
      await ready;

      if (broken) throw broken;

      return state()!;
    },
    setManualCap: cap => enqueue({ kind: "manual", cap }, () => validateManual(cap)),
    resetManualCap: () => enqueue({ kind: "reset" }, () => undefined),
    updateDefaults: next => enqueue({ kind: "defaults", defaults: { ...next } }, () => validateDefaults(next)),
    subscribe(listener, onError) {
      const subscriber = { listener, onError };
      subscribers.add(subscriber);
      ready.then(() => {
        const current = state();

        if (subscribers.has(subscriber) && initialized && current) send(subscriber, current);
      }, error => { if (subscribers.has(subscriber)) onError(asError(error)); });

      return () => { subscribers.delete(subscriber); };
    },
  };

  const restore = (ctx: ExtensionContext) => {
    context = ctx;
    track(ctx.model);

    try {
      logged = readLog(ctx.sessionManager.getBranch());
      const saved = logged.choice;
      const next = saved?.source === "manual" ? saved : defaults ? resolveDefaults(defaults) : saved;

      if (next) record(next);
      choice = next;
      broken = undefined;
      restored = true;
      apply();
      publish();
      initialize();
      drain();
    } catch (error) {
      broken = asError(error);
      restored = false;

      if (!initialized) settle.reject(broken);
      for (const item of pending.splice(0)) item.reject(broken);
      report(broken);
    }
  };

  const modelChanged = (next: Model | undefined) => {
    track(next);

    if (!restored || !choice) { apply();

    return; }

    try { record(choice); } catch (error) { report(asError(error)); }
    apply();
    publish();
    const window = appliedFor(choice, model);
    const error = model && window !== null ? budgetError(window, model) : undefined;

    if (error) report(new Error(error));
  };

  const stopSession = pi.events.on("piop:context-cap:session", (request: ContextCapSessionRequest) => { request.session = session; });
  const stopModels = pi.events.on("piop:models-refreshed", ({ ctx }) => modelChanged(ctx.model));

  pi.registerCommand("cap", {
    description: "Set this conversation's context cap. Usage: /cap [500k|0.75m|reset|model_default]",
    getArgumentCompletions: prefix => ["reset", "model_default"].filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const command = parseCapCommand(args);

      if (command.kind === "show") { ctx.ui.notify(describe(await session.getState()), "info");

      return; }

      const change = command.kind === "reset" ? session.resetManualCap() : session.setManualCap(command.cap);

      if (ctx.isIdle()) { ctx.ui.notify(describe(await change), "info");

      return; }

      ctx.ui.notify("The context cap change will apply when the current response finishes.", "info");
      change.then(next => context?.ui.notify(describe(next), "info"), error => context?.ui.notify("Context cap change failed: " + asError(error).message, "error"));
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", event => modelChanged(event.model));
  pi.on("agent_settled", () => drain());
  pi.on("session_compact", () => { setTimeout(drain, 0); });
  pi.on("session_compact_failed", () => drain());
  pi.on("input", (event, ctx) => {
    if (!ctx.isIdle()) return;
    drain();
    const window = choice ? appliedFor(choice, model) : null;
    const error = model && window !== null ? budgetError(window, model) : undefined;

    if (!error || event.text.startsWith("/")) return;
    ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error }));
    ctx.ui.notify(error, "error");

    return { action: "handled" };
  });
  pi.on("session_shutdown", () => {
    closed = true;
    const error = new Error("The session ended before the context cap change was applied");

    for (const item of pending.splice(0)) item.reject(error);

    if (!initialized) settle.reject(new Error("The session ended before the context cap was initialized"));
    subscribers.clear();
    stopSession();
    stopModels();

    for (const [target, original] of originals) target.contextWindow = original;
    originals.clear();
  });
}
