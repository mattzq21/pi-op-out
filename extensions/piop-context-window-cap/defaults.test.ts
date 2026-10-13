import { beforeEach, describe, expect, mock, test } from "bun:test";

const budgets = { reserveTokens: 16_384, keepRecentTokens: 20_000 };

mock.module("@earendil-works/pi-coding-agent", () => ({
  SettingsManager: { inMemory: () => ({ getCompactionSettings: () => ({ enabled: true, ...budgets }) }) },
}));

const { default: contextWindowCap } = await import("./index.ts");
let currentSettings: any;
process.env.PIOP_CONTEXT_CAP_SETTINGS_PATH = "/test/context-cap-settings.json";
mock.module("../../daemon/resources/session-broker/app-settings.cjs", () => ({ readFile: () => { if (!currentSettings) throw new Error("Context cap settings are unavailable"); return currentSettings; } }));

/** A Pi host for the context cap extension. */
function host() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const bus = new Map<string, Set<(value: any) => void>>();
  const notes: Array<[string, string]> = [];
  const settings = { contextWindowCap: 300_000, contextWindowCapEnabled: true, modelContextWindowCaps: {} as Record<string, number | null> };
  const ctx = {
    model: { provider: "test", id: "large", contextWindow: 1_000_000 },
    isIdle: () => true,
    sessionManager: { getBranch: () => [] },
    ui: { notify: (message: string, type: string) => notes.push([type, message]), setStatus: () => undefined },
  };
  const emit = (channel: string, value: any) => { for (const handler of bus.get(channel) ?? []) handler(value); };
  const pi = {
    on: (name: string, handler: any) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerCommand: () => undefined,
    appendEntry: () => undefined,
    getSettings: () => ({}),
    events: {
      on: (channel: string, handler: (value: any) => void) => {
        const set = bus.get(channel) ?? new Set();
        set.add(handler); bus.set(channel, set);

        return () => { set.delete(handler); };
      },
      emit,
    },
  };
  currentSettings = settings;
  contextWindowCap(pi as any);
  pi.events.on("piop:agents:context-cap", () => undefined);
  pi.events.on("piop:runtime-settings", () => { throw new Error("Context settings must not come from runtime-settings"); });

  return {
    ctx, notes, settings, emit,
    listenerCount: (name: string) => bus.get(name)?.size ?? 0,
    fire: async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx); },
    state: () => { const request: any = {}; emit("piop:context-cap:session", request); return request.session.getState(); },
  };
}

async function started() {
  const pi = host();
  await pi.fire("session_start", { reason: "startup" });
  pi.emit("piop:agents:ready", { ctx: pi.ctx });
  expect(await pi.state()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });

  return pi;
}

describe("context cap settings transport", () => {
  beforeEach(() => { budgets.keepRecentTokens = 20_000; });

  test("settings received before restoration apply after startup", async () => {
    const pi = host();
    pi.emit("piop:agents:ready", { ctx: pi.ctx });
    await pi.fire("session_start");
    expect(await pi.state()).toMatchObject({ cap: 300_000 });
  });

  test("restoration receives current app settings without runtime-settings", async () => {
    const pi = await started();
    pi.settings.contextWindowCap = 400_000;
    await pi.fire("session_tree");
    pi.emit("piop:agents:ready", { ctx: pi.ctx });
    expect(await pi.state()).toMatchObject({ cap: 400_000 });
  });

  test("a settings change resolves ready after the cap applies", async () => {
    const pi = await started();
    pi.settings.contextWindowCap = 400_000;
    const event: any = { command: "context_cap_settings", payload: { settings: pi.settings }, ctx: pi.ctx };
    pi.emit("piop:rpc", event);
    await event.ready;
    expect(await pi.state()).toEqual({ cap: 400_000, source: "config", appliedWindow: 400_000 });
  });

  test("a failed settings change rejects ready, reports the error, and keeps the old cap", async () => {
    const pi = await started();
    budgets.keepRecentTokens = 200_000;
    pi.settings.contextWindowCap = 100_000;
    const event: any = { command: "context_cap_settings", payload: { settings: pi.settings }, ctx: pi.ctx };
    pi.emit("piop:rpc", event);
    await expect(event.ready).rejects.toThrow("compaction budgets");
    expect(pi.notes.some(([type, message]) => type === "error" && message.startsWith("Context cap settings could not be applied"))).toBe(true);
    expect(await pi.state()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });
    expect(pi.ctx.model.contextWindow).toBe(300_000);
  });

  test("a model switch checks the model cap against the new model", async () => {
    const pi = host();
    pi.ctx.model = { provider: "test", id: "small", contextWindow: 200_000 };
    pi.settings.contextWindowCap = 100_000;
    pi.settings.modelContextWindowCaps = { "test/large": 500_000 };
    await pi.fire("session_start", { reason: "startup" });
    pi.emit("piop:agents:ready", { ctx: pi.ctx });
    expect(await pi.state()).toEqual({ cap: 100_000, source: "config", appliedWindow: 100_000 });
    pi.ctx.model = { provider: "test", id: "large", contextWindow: 1_000_000 };
    await pi.fire("model_select", { model: pi.ctx.model });
    expect(await pi.state()).toEqual({ cap: 500_000, source: "config", appliedWindow: 500_000 });
    expect(pi.notes.filter(([type]) => type === "error")).toEqual([]);
  });
});

test("missing settings report a visible error and preserve the current cap", async () => {
  const pi = await started();
  currentSettings = undefined;
  pi.emit("piop:agents:ready", { ctx: pi.ctx });
  await Promise.resolve();
  expect(pi.notes.some(([type, message]) => type === "error" && message.includes("Context cap settings are unavailable"))).toBe(true);
  expect((await pi.state()).cap).toBe(300_000);
});

test("shutdown removes the settings listeners", async () => {
  const pi = await started();
  await pi.fire("session_shutdown");
  for (const channel of ["piop:agents:ready", "piop:rpc"]) expect(pi.listenerCount(channel)).toBe(0);
});
