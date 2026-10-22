import { extendedHooks } from "../../daemon/resources/hooks-extended/interface.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextCapSettings } from "./defaults.ts";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ContextCapSessionRequest } from "./channel.ts";
import type { AgentContextCapRequest } from "../piop-define-agents/contracts.ts";
import {
  CAP_ENTRY, CONTEXT_CAP_STATUS_KEY, capRangeError, formatTokens, parseCapCommand,
  type ContextCapSettings, type ContextCapEntry, type ContextCapSession, type ContextCapSource, type ContextCapState,
} from "./interface.ts";

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:models-refreshed", handler: (event: { ctx: ExtensionContext }) => void): () => void;
    emit(channel: "piop:models-refreshed", event: { ctx: ExtensionContext }): void;
  }
}

type ContextCapDefaults = { agentDefinition: number | null | undefined; modelConfig: number | null | undefined; generalConfig: number | null };

type Model = NonNullable<ExtensionContext["model"]>;

/** Set on every model object whose window this extension changed, to the model's true window. A copy of that object keeps it. */
const NATIVE_WINDOW = Symbol("piop-context-cap-native-window");

type Marked = Model & { [NATIVE_WINDOW]?: number };

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

type Choice = { cap: number | null; source: ContextCapSource };


type Logged = { choice?: Choice; clamp?: number };

type Operation = { kind: "manual"; cap: number | null } | { kind: "reset" } | { kind: "settings"; settings: ContextCapSettings } | { kind: "refresh" };

type Pending = { operation: Operation; resolve: (state: ContextCapState) => void; reject: (error: Error) => void };

type Subscriber = { listener: (state: ContextCapState) => void; onError: (error: Error) => void; delivered: boolean };

const entrySchema = Type.Object({
  cap: Type.Union([Type.Null(), Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })]),
  source: Type.Union([Type.Literal("manual"), Type.Literal("config"), Type.Literal("agent_definition")]),
  clamp: Type.Optional(Type.Integer({ minimum: 1 })),
});

const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

const sameChoice = (left: Choice | undefined, right: Choice | undefined) => left?.cap === right?.cap && left?.source === right?.source;

const sameState = (left: ContextCapState | undefined, right: ContextCapState) => left?.cap === right.cap && left.source === right.source && left.appliedWindow === right.appliedWindow;

export function readLog(entries: Branch): Logged {
  const entry = entries.findLast(entry => entry.type === "custom" && entry.customType === CAP_ENTRY);
  if (!entry || entry.type !== "custom") return {};
  if (!Check(entrySchema, entry.data)) throw new Error("Saved context cap is invalid");
  const data: ContextCapEntry = entry.data;
  const error = data.cap === null ? undefined : capRangeError(data.cap);
  if (error) throw new Error("Saved context cap is invalid: " + error);
  return { choice: { cap: data.cap, source: data.source }, clamp: data.clamp };
}

/** Resolves agent definition, provider/model config, general config, then the model default. */
export function resolveDefaults(defaults: ContextCapDefaults): Choice {
  if (defaults.agentDefinition !== undefined) return { cap: defaults.agentDefinition, source: "agent_definition" };

  if (defaults.modelConfig !== undefined) return { cap: defaults.modelConfig, source: "config" };

  return { cap: defaults.generalConfig ?? null, source: "config" };
}

function validateSettings(settings: ContextCapSettings) {
  if (!settings || typeof settings.contextWindowCapEnabled !== "boolean" || !settings.modelContextWindowCaps || typeof settings.modelContextWindowCaps !== "object" || Array.isArray(settings.modelContextWindowCaps)) throw new Error("Invalid context cap settings");
  const generalError = capRangeError(settings.contextWindowCap, "General context cap setting");
  if (generalError) throw new Error(generalError);
  for (const value of Object.values(settings.modelContextWindowCaps)) {
    const error = value === null ? undefined : capRangeError(value, "Model context cap setting");
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
  /** True model windows by provider/model key. */
  const natives = new Map<string, number>();
  /** The window this extension last wrote, by provider/model key. */
  const written = new Map<string, number>();
  /** Every model object this extension has seen. */
  const objects = new Set<Model>();
  const pending: Pending[] = [];
  const subscribers = new Set<Subscriber>();
  let context: ExtensionContext | undefined;
  let model: Model | undefined;
  let choice: Choice | undefined;
  let settings: ContextCapSettings | undefined;
  let defaults: ContextCapDefaults | undefined;
  /** The provider/model key of the model when the current defaults were accepted. Its model cap belongs to that model. */
  let defaultsModel: string | undefined;
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

  const keyOf = (target: Model) => target.provider + "/" + target.id;

  /**
   * Pi can build a replacement model object by copying the object this extension changed, so the copy carries the applied window and its mark.
   * Use the marked true window in that case. A fresh object, such as one from a provider refresh, has no mark: its window is the true window.
   */
  const track = (next: Model | undefined) => {
    if (next && !objects.has(next)) {
      const key = keyOf(next);
      const carried = (next as Marked)[NATIVE_WINDOW];

      natives.set(key, carried !== undefined && written.get(key) === next.contextWindow ? carried : next.contextWindow);
      objects.add(next);
    }
    model = next;
  };

  const nativeWindow = (target: Model) => natives.get(keyOf(target)) ?? target.contextWindow;

  const restoreNative = (target: Model) => {
    target.contextWindow = nativeWindow(target);
    delete (target as Marked)[NATIVE_WINDOW];
  };

  const appliedFor = (next: Choice, target: Model | undefined) => {
    if (!target) return null;
    const native = nativeWindow(target);

    return next.cap === null ? native : Math.min(native, next.cap);
  };

  const clampFor = (next: Choice) => {
    const native = model && nativeWindow(model);
    return native !== undefined && Number.isSafeInteger(native) && native > 0 && next.cap !== null && native < next.cap ? native : undefined;
  };

  const budgetError = (window: number, target: Model) => {
    const budgets = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(target);
    const minimum = budgets.reserveTokens + budgets.keepRecentTokens + 1;

    if (window >= minimum) return undefined;

    return "A " + formatTokens(window) + "-token context window for " + target.provider + "/" + target.id + " is too small for Pi's compaction budgets. Use at least "
      + formatTokens(minimum) + " tokens, or reduce Pi's reserve and recent-history budgets.";
  };

  const state = (): ContextCapState | undefined => choice && { cap: choice.cap, source: choice.source, appliedWindow: appliedFor(choice, model) };

  const send = (subscriber: Subscriber, value: ContextCapState) => {
    subscriber.delivered = true;
    try { subscriber.listener(value); } catch (error) { subscriber.onError(asError(error)); }
  };

  const report = (error: Error) => {
    for (const subscriber of [...subscribers]) subscriber.onError(error);
    context?.ui.notify(error.message, "error");
  };

  /** Tells clients that the applied window may have changed, so they can read context usage again. */
  const announce = (value: ContextCapState) => { context?.ui.setStatus(CONTEXT_CAP_STATUS_KEY, "json:" + JSON.stringify(value)); };

  const publish = () => {
    const current = state();

    if (!current || sameState(published, current)) return;
    published = current;

    if (!initialized) return;
    announce(current);
    for (const subscriber of [...subscribers]) send(subscriber, current);
  };

  const initialize = () => {
    if (initialized || !restored || !choice || !defaults) return;
    initialized = true;
    published = state();
    settle.resolve();

    if (published) announce(published);
    for (const subscriber of [...subscribers]) if (published) send(subscriber, published);
  };

  const append = (data: ContextCapEntry) => { pi.appendEntry(CAP_ENTRY, data); };

  const record = (next: Choice) => {
    const clamp = clampFor(next);
    if (sameChoice(logged.choice, next) && logged.clamp === clamp) return;
    append({ cap: next.cap, source: next.source, ...(clamp === undefined ? {} : { clamp }) });
    logged = { choice: next, clamp };
  };

  /** Writes the effective window to the current model and restores every other model this extension changed. */
  const apply = () => {
    for (const target of objects) if (target !== model && (target.contextWindow !== nativeWindow(target) || NATIVE_WINDOW in target)) restoreNative(target);

    for (const key of [...written.keys()]) if (!model || key !== keyOf(model)) written.delete(key);

    if (!model || !choice) return;
    const window = appliedFor(choice, model);

    if (window === null) return;

    if (model.contextWindow !== window) model.contextWindow = window;
    (model as Marked)[NATIVE_WINDOW] = nativeWindow(model);
    written.set(keyOf(model), window);
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

  /** A new numeric choice must fit the true window of the current model. An existing choice is clamped after a model change instead. */
  const requireFit = (cap: number, label: string) => {
    if (!model) throw new Error("Select a model before setting a numeric context cap");

    if (cap > nativeWindow(model)) throw new Error(label + " of " + formatTokens(cap) + " tokens exceeds the " + formatTokens(nativeWindow(model)) + "-token context window of " + model.provider + "/" + model.id);
  };

  const validateManual = (cap: number | null) => {
    if (cap !== null) {
      const error = capRangeError(cap);

      if (error) throw new Error(error);
      requireFit(cap, "The context cap");
    }

    requireBudgets({ cap, source: "manual" });
  };

  const sourceLabel = (source: ContextCapSource) => source === "agent_definition" ? "The agent definition context cap" : "The context cap setting";

  /**
   * A default cap is a new choice when its value changed: an edited agent, model, or general cap. A model cap also changes when the model changes.
   * New choices must fit the current model. The first defaults of a session are existing settings and are clamped.
   */
  const validateNewDefaults = (next: ContextCapDefaults) => {
    if (!choice || !defaults) return;
    const resolved = resolveDefaults(next);
    const changed = resolved.source === "agent_definition" ? defaults.agentDefinition !== next.agentDefinition
      : next.modelConfig !== undefined ? defaults.modelConfig !== next.modelConfig || defaultsModel !== (model && keyOf(model))
        : defaults.generalConfig !== next.generalConfig;

    if (changed && resolved.cap !== null) requireFit(resolved.cap, sourceLabel(resolved.source));
  };

  const receivedDefaults = (next: ContextCapSettings): ContextCapDefaults => {
    const agent: AgentContextCapRequest = {};
    pi.events.emit("piop:agents:context-cap", agent);
    const error = agent.cap === undefined || agent.cap === null ? undefined : capRangeError(agent.cap, "Agent definition context cap");
    if (error) throw new Error(error);
    const key = model && keyOf(model);

    return {
      agentDefinition: agent.cap,
      modelConfig: key !== undefined && Object.hasOwn(next.modelContextWindowCaps, key) ? next.modelContextWindowCaps[key] : undefined,
      generalConfig: next.contextWindowCapEnabled ? next.contextWindowCap : null,
    };
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

    const received = operation.kind === "settings" ? operation.settings : settings;
    if (!received) return;
    const nextDefaults = receivedDefaults(received);
    const next = choice?.source === "manual" ? choice : resolveDefaults(nextDefaults);
    validateNewDefaults(nextDefaults);

    if (choice && !sameChoice(choice, next)) requireBudgets(next);
    const first = !choice;
    commit(next);
    settings = received;
    defaults = nextDefaults;
    defaultsModel = model && keyOf(model);

    if (!first) return;
    const window = appliedFor(next, model);
    const error = model && window !== null ? budgetError(window, model) : undefined;

    if (error) report(new Error(error));
  };

  const drain = () => {
    if (draining || closed || !restored || !context?.isIdle()) return;
    sync();
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

    // Another handler of the same model_select event can send this request before this extension sees the new model.
    sync();

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
      sync();

      return state()!;
    },
    setManualCap: cap => enqueue({ kind: "manual", cap }, () => validateManual(cap)),
    resetManualCap: () => enqueue({ kind: "reset" }, () => undefined),
    updateSettings: next => {
      try { validateSettings(next); } catch (error) { return Promise.reject(asError(error)); }
      return enqueue({ kind: "settings", settings: structuredClone(next) }, () => undefined);
    },
    subscribe(listener, onError) {
      const subscriber: Subscriber = { listener, onError, delivered: false };
      subscribers.add(subscriber);
      // initialize() delivers the first state to subscribers that exist then; this covers later subscribers.
      ready.then(() => {
        const current = state();

        if (subscribers.has(subscriber) && !subscriber.delivered && initialized && current) send(subscriber, current);
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
    const previousKey = model && keyOf(model);
    track(next);

    if (!restored || !choice) { apply();

    return; }

    try { record(choice); } catch (error) { report(asError(error)); }
    apply();
    publish();
    const window = appliedFor(choice, model);
    const error = model && window !== null ? budgetError(window, model) : undefined;

    if (error) report(new Error(error));
    if (settings && previousKey !== (model && keyOf(model))) refresh();
  };

  const refresh = () => {
    if (settings) enqueue({ kind: "refresh" }, () => undefined).catch(error => report(asError(error)));
  };

  /** Pi replaces the session model object after provider changes without an event. Apply to the new object before Pi reads its window. */
  function sync() {
    if (!closed && context && context.model !== model) modelChanged(context.model);
  }

  const stopSession = pi.events.on("piop:context-cap:session", (request: ContextCapSessionRequest) => { request.session = session; });
  const stopAgent = pi.events.on("piop:agents:selected", () => refresh());
  const stopModels = pi.events.on("piop:models-refreshed", ({ ctx }) => { if (!closed) modelChanged(ctx.model); });

  pi.registerCommand("cap", {
    description: "Set this conversation's context cap. Usage: /cap [500k | 0.75m | reset | model_default]",
    getArgumentCompletions: prefix => [...(prefix.trim() ? [] : [{ value: "", label: "[500k | 0.75m | reset | model_default]" }]), ...["reset", "model_default"].filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value }))],
    // Report errors to the user here. A thrown error is an extension failure, and the client then treats the command as a failed message.
    handler: async (args, ctx) => {
      try {
        const command = parseCapCommand(args);

        if (command.kind === "show") { ctx.ui.notify(describe(await session.getState()), "info");

        return; }

        const change = command.kind === "reset" ? session.resetManualCap() : session.setManualCap(command.cap);

        if (ctx.isIdle()) { ctx.ui.notify(describe(await change), "info");

        return; }

        ctx.ui.notify("The context cap change will apply when the current response finishes.", "info");
        change.then(next => context?.ui.notify(describe(next), "info"), error => context?.ui.notify("Context cap change failed: " + asError(error).message, "error"));
      } catch (error) { ctx.ui.notify("Context cap change failed: " + asError(error).message, "error"); }
    },
  });

  registerContextCapSettings(pi, next => session.updateSettings(next));

  extendedHooks(pi).on("session_restore", (_event, ctx) => restore(ctx));
  pi.on("model_select", event => modelChanged(event.model));
  pi.on("before_agent_start", () => sync());
  pi.on("turn_start", () => sync());
  pi.on("turn_end", () => sync());
  pi.on("session_before_compact", () => sync());
  extendedHooks(pi).on("session_available", () => drain());
  pi.on("input", (event, ctx) => {
    if (!ctx.isIdle()) return;
    drain();
    const window = choice ? appliedFor(choice, model) : null;
    const error = model && window !== null ? budgetError(window, model) : undefined;

    // Pi runs extension commands such as /cap before this event, so slash text here is a prompt, skill, or template.
    if (!error) return;
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
    stopAgent();

    for (const target of objects) restoreNative(target);
    objects.clear();
    natives.clear();
    written.clear();
  });
}
