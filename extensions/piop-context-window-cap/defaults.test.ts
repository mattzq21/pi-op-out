import hooksExtended from "../../daemon/resources/hooks-extended/index.ts";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "../../daemon/resources/session-broker/app-settings.cjs";

const budgets = { reserveTokens: 16_384, keepRecentTokens: 20_000 };

mock.module("@earendil-works/pi-coding-agent", () => ({
  SettingsManager: { inMemory: () => ({ getCompactionSettings: () => ({ enabled: true, ...budgets }) }) },
}));

const { default: contextWindowCap } = await import("./index.ts");

const originalSettingsPath = process.env.PIOP_CONTEXT_CAP_SETTINGS_PATH;
const fixtureRoot = mkdtempSync(join(tmpdir(), "piop-context-cap-defaults-"));
const settingsPath = join(fixtureRoot, "present", "context-cap-settings.json");
const absentSettingsPath = join(fixtureRoot, "absent", "context-cap-settings.json");

/** Persists app settings through the app settings store before an event reads them. */
function save(settings: unknown, path = settingsPath) { write(path, JSON.stringify(settings)); }

beforeEach(() => { process.env.PIOP_CONTEXT_CAP_SETTINGS_PATH = settingsPath; });

afterAll(() => {
  if (originalSettingsPath === undefined) delete process.env.PIOP_CONTEXT_CAP_SETTINGS_PATH;
  else process.env.PIOP_CONTEXT_CAP_SETTINGS_PATH = originalSettingsPath;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/** A Pi host for the context cap extension. */
function host() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const bus = new Map<string, Set<(value: any) => void>>();
  const notes: Array<[string, string]> = [];
  const settings = { contextWindowCap: 300_000, contextWindowCapEnabled: true, modelContextWindowCaps: {} as Record<string, number | null> };
  let idle = true;
  const idleWaiters = new Set<() => void>();
  const ctx = {
    model: { provider: "test", id: "large", contextWindow: 1_000_000 },
    isIdle: () => idle,
    [Symbol.for("piop.wait-for-idle")]: () => idle ? Promise.resolve() : new Promise<void>(resolve => idleWaiters.add(resolve)),
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
  save(settings);
  hooksExtended(pi as any);
  contextWindowCap(pi as any);
  pi.events.on("piop:agents:context-cap", () => undefined);
  pi.events.on("piop:runtime-settings", () => { throw new Error("Context settings must not come from runtime-settings"); });

  return {
    ctx, notes, settings, emit,
    setIdle: (value: boolean) => {
      if (idle === value) return;
      idle = value;
      if (!value) { for (const handler of handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, ctx); }
      else { for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); }
    },
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
    save(pi.settings);
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

  test("a settings change received while busy resolves ready only after it applies at idle", async () => {
    const pi = await started();
    pi.setIdle(false);
    pi.settings.contextWindowCap = 400_000;
    const event: any = { command: "context_cap_settings", payload: { settings: pi.settings }, ctx: pi.ctx };
    pi.emit("piop:rpc", event);
    let settled = false;
    event.ready.then(() => { settled = true; }, () => { settled = true; });
    expect(await pi.state()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });
    expect(settled).toBe(false);
    expect(pi.ctx.model.contextWindow).toBe(300_000);

    pi.setIdle(true);
    await pi.fire("agent_settled");
    await event.ready;
    expect(await pi.state()).toEqual({ cap: 400_000, source: "config", appliedWindow: 400_000 });
    expect(pi.ctx.model.contextWindow).toBe(400_000);
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

    const notesBeforeRetry = pi.notes.filter(([type]) => type === "error");
    pi.settings.contextWindowCap = 400_000;
    const retry: any = { command: "context_cap_settings", payload: { settings: pi.settings }, ctx: pi.ctx };
    pi.emit("piop:rpc", retry);
    await retry.ready;
    expect(await pi.state()).toEqual({ cap: 400_000, source: "config", appliedWindow: 400_000 });
    expect(pi.ctx.model.contextWindow).toBe(400_000);
    expect(pi.notes.filter(([type]) => type === "error")).toEqual(notesBeforeRetry);
  });

  test("a queued settings change rejects ready if compaction budgets increase before idle, and a valid retry succeeds", async () => {
    const pi = await started();
    pi.setIdle(false);
    const event: any = { command: "context_cap_settings", payload: { settings: { ...pi.settings, contextWindowCap: 400_000 } }, ctx: pi.ctx };
    pi.emit("piop:rpc", event);
    let outcome: unknown = "pending";
    const settled = event.ready.then(() => { outcome = "resolved"; }, (error: unknown) => { outcome = error; });
    expect(await pi.state()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });
    expect(outcome).toBe("pending");
    expect(pi.notes.filter(([type]) => type === "error")).toEqual([]);

    budgets.keepRecentTokens = 450_000;
    pi.setIdle(true);
    await pi.fire("agent_settled");
    await settled;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("compaction budgets");
    const errors = pi.notes.filter(([type]) => type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toStartWith("Context cap settings could not be applied: ");
    expect(errors[0][1]).toContain("compaction budgets");
    expect(await pi.state()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });
    expect(pi.ctx.model.contextWindow).toBe(300_000);

    const retry: any = { command: "context_cap_settings", payload: { settings: { ...pi.settings, contextWindowCap: 600_000 } }, ctx: pi.ctx };
    pi.emit("piop:rpc", retry);
    await retry.ready;
    expect(await pi.state()).toEqual({ cap: 600_000, source: "config", appliedWindow: 600_000 });
    expect(pi.ctx.model.contextWindow).toBe(600_000);
    expect(pi.notes.filter(([type]) => type === "error")).toEqual(errors);
  });

  test("a model switch checks the model cap against the new model", async () => {
    const pi = host();
    pi.ctx.model = { provider: "test", id: "small", contextWindow: 200_000 };
    pi.settings.contextWindowCap = 100_000;
    pi.settings.modelContextWindowCaps = { "test/large": 500_000 };
    save(pi.settings);
    await pi.fire("session_start", { reason: "startup" });
    pi.emit("piop:agents:ready", { ctx: pi.ctx });
    expect(await pi.state()).toEqual({ cap: 100_000, source: "config", appliedWindow: 100_000 });
    pi.ctx.model = { provider: "test", id: "large", contextWindow: 1_000_000 };
    await pi.fire("model_select", { model: pi.ctx.model });
    expect(await pi.state()).toEqual({ cap: 500_000, source: "config", appliedWindow: 500_000 });
    expect(pi.notes.filter(([type]) => type === "error")).toEqual([]);
  });
});

test("missing settings report a visible error, preserve the current cap, and recover when saved", async () => {
  const pi = await started();
  process.env.PIOP_CONTEXT_CAP_SETTINGS_PATH = absentSettingsPath;
  pi.emit("piop:agents:ready", { ctx: pi.ctx });
  await Promise.resolve();
  expect(pi.notes.some(([type, message]) => type === "error" && message.includes("Invalid context cap settings"))).toBe(true);
  expect((await pi.state()).cap).toBe(300_000);

  save({ ...pi.settings, contextWindowCap: 400_000 }, absentSettingsPath);
  pi.emit("piop:agents:ready", { ctx: pi.ctx });
  await Promise.resolve();
  expect(await pi.state()).toEqual({ cap: 400_000, source: "config", appliedWindow: 400_000 });
});

test("shutdown removes the settings listeners", async () => {
  const pi = await started();
  await pi.fire("session_shutdown");
  expect(pi.ctx.model.contextWindow).toBe(1_000_000);
  const notesAtShutdown = [...pi.notes];

  pi.settings.contextWindowCap = 400_000;
  save(pi.settings);
  pi.emit("piop:agents:ready", { ctx: pi.ctx });
  const request: any = { command: "context_cap_settings", payload: { settings: pi.settings }, ctx: pi.ctx };
  pi.emit("piop:rpc", request);
  request.ready?.catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(request.ready).toBeUndefined();
  expect(pi.ctx.model.contextWindow).toBe(1_000_000);
  expect(pi.notes).toEqual(notesAtShutdown);
});

test("shutdown rejects a settings change received while busy, without an error report, and idle does not apply it later", async () => {
  const pi = await started();
  pi.setIdle(false);
  const request: any = { command: "context_cap_settings", payload: { settings: { ...pi.settings, contextWindowCap: 400_000 } }, ctx: pi.ctx };
  pi.emit("piop:rpc", request);
  const outcome = Promise.allSettled([request.ready]);
  let settled = false;
  outcome.then(() => { settled = true; });
  expect(await pi.state()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });
  expect(settled).toBe(false);
  const notesBeforeShutdown = [...pi.notes];

  await pi.fire("session_shutdown");
  const [result] = await outcome;
  expect(result.status).toBe("rejected");
  expect(((result as PromiseRejectedResult).reason as Error).message).toContain("session ended");
  expect(pi.ctx.model.contextWindow).toBe(1_000_000);
  expect(pi.notes).toEqual(notesBeforeShutdown);

  pi.setIdle(true);
  await pi.fire("agent_settled");
  expect(pi.ctx.model.contextWindow).toBe(1_000_000);
  expect(pi.notes).toEqual(notesBeforeShutdown);
}, 1000);
