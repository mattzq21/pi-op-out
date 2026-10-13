import { beforeEach, describe, expect, mock, test } from "bun:test";

const budgets = { reserveTokens: 16_384, keepRecentTokens: 20_000 };

mock.module("@earendil-works/pi-coding-agent", () => ({
  SettingsManager: { inMemory: () => ({ getCompactionSettings: () => ({ enabled: true, ...budgets }) }) },
}));

const { default: contextWindowCap } = await import("./index.ts");

/** A Pi host for the context cap extension. */
function host() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const bus = new Map<string, Set<(value: any) => void>>();
  const notes: Array<[string, string]> = [];
  let settingsAvailable = true;
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
  contextWindowCap(pi as any);
  pi.events.on("piop:runtime-settings", (request: any) => { if (settingsAvailable) request.settings = settings; });
  pi.events.on("piop:agents:context-cap", () => undefined);

  return {
    ctx, notes, settings, emit,
    hideSettings: () => { settingsAvailable = false; },
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

describe("context cap defaults", () => {
  beforeEach(() => { budgets.keepRecentTokens = 20_000; });

  test("a settings change resolves ready after the cap applies", async () => {
    const pi = await started();
    pi.settings.contextWindowCap = 400_000;
    const event: any = { ctx: pi.ctx };
    pi.emit("piop:runtime-settings:changed", event);
    await event.ready;
    expect(await pi.state()).toEqual({ cap: 400_000, source: "config", appliedWindow: 400_000 });
  });

  test("a failed settings change rejects ready, reports the error, and keeps the old cap", async () => {
    const pi = await started();
    budgets.keepRecentTokens = 200_000;
    pi.settings.contextWindowCap = 100_000;
    const event: any = { ctx: pi.ctx };
    pi.emit("piop:runtime-settings:changed", event);
    await expect(event.ready).rejects.toThrow("compaction budgets");
    expect(pi.notes.some(([type, message]) => type === "error" && message.startsWith("Context cap defaults could not be applied"))).toBe(true);
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


test("defaults received before session start apply when the session loads", async () => {
  const pi = host();
  pi.emit("piop:agents:ready", { ctx: pi.ctx });
  await pi.fire("session_start", { reason: "startup" });
  expect(await pi.state()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });
});

test("missing settings reject the change and report a visible error", async () => {
  const pi = await started();
  pi.hideSettings();
  const event: any = { ctx: pi.ctx };
  pi.emit("piop:runtime-settings:changed", event);
  await expect(event.ready).rejects.toThrow("Runtime settings are unavailable");
  expect(pi.notes.some(([type, message]) => type === "error" && message.includes("Runtime settings are unavailable"))).toBe(true);
  expect((await pi.state()).cap).toBe(300_000);
});

test("shutdown removes the defaults change listeners", async () => {
  const pi = await started();
  await pi.fire("session_shutdown");
  for (const channel of ["piop:agents:ready", "piop:agents:selected", "piop:runtime-settings:changed"]) {
    expect(pi.listenerCount(channel)).toBe(0);
  }
});
