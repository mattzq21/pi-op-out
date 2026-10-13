import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextCapSessionRequest } from "../../../extensions/piop-context-window-cap/channel.ts";
import type { ContextCapDefaults } from "../../../extensions/piop-context-window-cap/interface.ts";
import type { AgentContextCapRequest, AgentSelectedEvent } from "../../../extensions/piop-define-agents/contracts.ts";

type Model = NonNullable<ExtensionContext["model"]>;

type CapSettings = { contextWindowCap: number; contextWindowCapEnabled: boolean; modelContextWindowCaps: Record<string, number | null> };

type CapSettingsRequest = { settings?: CapSettings };

type SettingsChanged = { ctx: ExtensionContext; ready?: Promise<void> };

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:runtime-settings", handler: (request: CapSettingsRequest) => void): () => void;
    emit(channel: "piop:runtime-settings", request: CapSettingsRequest): void;
    on(channel: "piop:runtime-settings:changed", handler: (event: SettingsChanged) => void): () => void;
    emit(channel: "piop:runtime-settings:changed", event: SettingsChanged): void;
    on(channel: "piop:agents:ready", handler: (event: AgentSelectedEvent) => void): () => void;
    emit(channel: "piop:agents:ready", event: AgentSelectedEvent): void;
  }
}

/** Complete defaults for the current agent and the given model from runtime settings and the agent definition. */
export function contextCapDefaults(pi: ExtensionAPI, model: Model | undefined): ContextCapDefaults {
  const request: CapSettingsRequest = {};
  pi.events.emit("piop:runtime-settings", request);

  if (!request.settings) throw new Error("Runtime settings are unavailable");
  const agent: AgentContextCapRequest = {};
  pi.events.emit("piop:agents:context-cap", agent);
  const caps = request.settings.modelContextWindowCaps;
  const key = model ? model.provider + "/" + model.id : undefined;

  return {
    agentDefinition: agent.cap,
    modelConfig: key !== undefined && Object.hasOwn(caps, key) ? caps[key] : undefined,
    generalConfig: request.settings.contextWindowCapEnabled ? request.settings.contextWindowCap : null,
  };
}

/**
 * Sends complete context cap defaults to the context cap extension after the agent is restored,
 * and again after agent, model, or runtime settings changes.
 */
export function registerContextCapDefaults(pi: ExtensionAPI) {
  let agentsReady = false;
  let closed = false;

  const update = (ctx: ExtensionContext, model = ctx.model) => {
    const request: ContextCapSessionRequest = {};
    pi.events.emit("piop:context-cap:session", request);

    if (!request.session) return Promise.reject(new Error("The context cap extension is not loaded"));

    try { return request.session.updateDefaults(contextCapDefaults(pi, model)); } catch (error) { return Promise.reject(error); }
  };

  /** Reports a failure to the user and rejects, so that a settings request does not succeed with the old cap. */
  const apply = (ctx: ExtensionContext, model?: Model) => update(ctx, model).then(() => undefined, error => {
    if (!closed) ctx.ui.notify("Context cap defaults could not be applied: " + (error instanceof Error ? error.message : String(error)), "error");

    throw error;
  });

  const send = (ctx: ExtensionContext, model?: Model) => { apply(ctx, model).catch(() => undefined); };

  const stops = [
    pi.events.on("piop:agents:ready", ({ ctx }) => { agentsReady = true; send(ctx); }),
    pi.events.on("piop:agents:selected", ({ ctx }) => { send(ctx); }),
    pi.events.on("piop:runtime-settings:changed", event => { if (agentsReady) event.ready = apply(event.ctx); }),
  ];

  pi.on("model_select", (event, ctx) => { if (agentsReady) send(ctx, event.model); });
  pi.on("session_shutdown", () => {
    closed = true;

    for (const stop of stops) stop();
  });
}
