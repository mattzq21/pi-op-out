import hooksExtended from "../../daemon/resources/hooks-extended/index.ts";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const budgets = { reserveTokens: 16_384, keepRecentTokens: 20_000 };

mock.module("@earendil-works/pi-coding-agent", () => ({
  SettingsManager: { inMemory: () => ({ getCompactionSettings: () => ({ enabled: true, ...budgets }) }) },
}));

const { default: contextWindowCap } = await import("./index.ts");
const { parseCap, parseCapCommand, CAP_ENTRY } = await import("./interface.ts");

type Model = { provider: string; id: string; contextWindow: number };
type Entry = { type: "custom"; customType: string; data: any; id: string };

class Host {
  handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  bus = new Map<string, Set<(value: any) => void>>();
  commands = new Map<string, any>();
  notes: Array<[string, string]> = [];
  statuses: Array<[string, string | undefined]> = [];
  private idleState = true;
  private idleWaiters = new Set<() => void>();
  get idle() { return this.idleState; }
  set idle(value: boolean) {
    const changed = value !== this.idleState;
    this.idleState = value;
    if (!changed) return;
    if (!value) void this.fire("agent_start");
    else { for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear(); }
  }
  agentCap: number | null | undefined;
  model: Model | undefined;
  ctx: any;
  savedCap: Entry | undefined;

  constructor(public branch: Entry[], model?: Model) {
    this.model = model;
    this.savedCap = branch.findLast(entry => entry.customType === CAP_ENTRY);
    const host = this;
    this.ctx = {
      get model() { return host.model; },
      isIdle: () => host.idle,
      [Symbol.for("piop.wait-for-idle")]: () => host.idle ? Promise.resolve() : new Promise<void>(resolve => host.idleWaiters.add(resolve)),
      sessionManager: { getBranch: () => host.savedCap ? [host.savedCap] : [] },
      ui: { notify: (message: string, type: string) => host.notes.push([type, message]), setStatus: (key: string, text?: string) => host.statuses.push([key, text]) },
    };
    hooksExtended(this.api() as any);
    contextWindowCap(this.api() as any);
    this.api().events.on("piop:agents:context-cap", request => { request.cap = this.agentCap; });
  }

  api() {
    return {
      on: (name: string, handler: any) => { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); },
      registerCommand: (name: string, options: any) => { this.commands.set(name, options); },
      appendEntry: (customType: string, data: unknown) => { const entry: Entry = { type: "custom", customType, data: structuredClone(data), id: crypto.randomUUID() }; this.branch.push(entry); this.savedCap = entry; },
      getSettings: () => ({}),
      events: {
        on: (channel: string, handler: (value: any) => void) => {
          const set = this.bus.get(channel) ?? new Set();
          set.add(handler); this.bus.set(channel, set);

          return () => { set.delete(handler); };
        },
        emit: (channel: string, value: any) => { for (const handler of this.bus.get(channel) ?? []) handler(value); },
      },
    };
  }

  async fire(name: string, event: any = {}) {
    let result;

    for (const handler of this.handlers.get(name) ?? []) result = await handler({ type: name, ...event }, this.ctx);

    return result;
  }

  session() {
    const request: any = {};
    this.bus.get("piop:context-cap:session")?.forEach(handler => handler(request));

    return request.session;
  }

  updateDefaults(defaults: { agentDefinition: number | null | undefined; modelConfig: number | null | undefined; generalConfig: number | null }) {
    this.agentCap = defaults.agentDefinition;
    return this.session().updateSettings({
      contextWindowCap: defaults.generalConfig ?? 300_000,
      contextWindowCapEnabled: defaults.generalConfig !== null,
      modelContextWindowCaps: defaults.modelConfig === undefined || !this.model ? {} : { [this.model.provider + "/" + this.model.id]: defaults.modelConfig },
    });
  }

  async selectModel(model: Model) { this.model = model; await this.fire("model_select", { model }); }

  caps() { return this.branch.filter(entry => entry.customType === CAP_ENTRY).map(entry => entry.data); }
}

const model = (id: string, contextWindow: number): Model => ({ provider: "test", id, contextWindow });

const general = (generalConfig: number | null) => ({ agentDefinition: undefined, modelConfig: undefined, generalConfig });

async function start(branch: Entry[] = [], current: Model | undefined = model("large", 1_000_000), defaults = general(300_000)) {
  const host = new Host(branch, current);
  await host.fire("session_start", { reason: "startup" });
  await host.updateDefaults(defaults);

  return host;
}

beforeEach(() => { budgets.reserveTokens = 16_384; budgets.keepRecentTokens = 20_000; });

describe("cap parsing", () => {
  test("accepts decimal multipliers and up to two decimals", () => {
    expect(parseCap("500k")).toBe(500_000);
    expect(parseCap("0.75m")).toBe(750_000);
    expect(parseCap("1.25M")).toBe(1_250_000);
    expect(parseCap("100000")).toBe(100_000);
    expect(parseCap("50m")).toBe(50_000_000);
  });

  test("rejects malformed, fractional, and out-of-range values", () => {
    for (const text of ["99999", "50.01m", "1.5", "1,000k", "1.234m", "-500k", "500 k", "k", ""]) expect(() => parseCap(text)).toThrow();
  });

  test("reads reset and model_default as operations", () => {
    expect(parseCapCommand("reset")).toEqual({ kind: "reset" });
    expect(parseCapCommand(" model_default ")).toEqual({ kind: "manual", cap: null });
    expect(parseCapCommand("")).toEqual({ kind: "show" });
  });
});

describe("context cap session", () => {
  test("resolves defaults in priority order and logs the initial choice", async () => {
    const host = await start();
    expect(await host.session().getState()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });
    expect(host.model!.contextWindow).toBe(300_000);
    await host.updateDefaults({ agentDefinition: undefined, modelConfig: 400_000, generalConfig: 300_000 });
    await host.updateDefaults({ agentDefinition: null, modelConfig: 400_000, generalConfig: 300_000 });
    expect(await host.session().getState()).toEqual({ cap: null, source: "agent_definition", appliedWindow: 1_000_000 });
    expect(host.caps()).toEqual([{ cap: 300_000, source: "config" }, { cap: 400_000, source: "config" }, { cap: null, source: "agent_definition" }]);
  });

  test("owns a copy of all model settings and resolves missing and null entries on model changes", async () => {
    const host = await start();
    const settings = { contextWindowCap: 300_000, contextWindowCapEnabled: true, modelContextWindowCaps: { "test/large": 400_000, "test/native": null } };
    await host.session().updateSettings(settings);
    settings.modelContextWindowCaps["test/large"] = 900_000;
    await host.selectModel(model("native", 1_000_000));
    expect(await host.session().getState()).toMatchObject({ cap: null, appliedWindow: 1_000_000 });
    await host.selectModel(model("missing", 1_000_000));
    expect(await host.session().getState()).toMatchObject({ cap: 300_000 });
    await host.selectModel(model("large", 1_000_000));
    expect(await host.session().getState()).toMatchObject({ cap: 400_000 });
    await host.session().updateSettings({ ...settings, contextWindowCapEnabled: false, modelContextWindowCaps: {} });
    expect(await host.session().getState()).toMatchObject({ cap: null });
  });

  test("agent changes use the extension's received settings and preserve manual priority", async () => {
    const host = await start();
    const selected = () => host.api().events.emit("piop:agents:selected", { ctx: host.ctx });
    host.agentCap = 500_000;
    selected();
    expect(await host.session().getState()).toMatchObject({ cap: 500_000, source: "agent_definition" });
    await host.session().setManualCap(null);
    host.agentCap = null;
    selected();
    expect(await host.session().getState()).toMatchObject({ cap: null, source: "manual" });
    await host.session().resetManualCap();
    expect(await host.session().getState()).toMatchObject({ cap: null, source: "agent_definition" });
    host.agentCap = undefined;
    selected();
    expect(await host.session().getState()).toMatchObject({ cap: 300_000, source: "config" });
  });

  test("queued settings resolve for the model selected when the session becomes idle", async () => {
    const host = await start();
    host.idle = false;
    const settings = { contextWindowCap: 400_000, contextWindowCapEnabled: true, modelContextWindowCaps: { "test/other": 200_000 } };
    const change = host.session().updateSettings(settings);
    settings.modelContextWindowCaps["test/other"] = 700_000;
    await host.selectModel(model("other", 1_000_000));
    expect(host.model!.contextWindow).toBe(300_000);
    host.idle = true;
    await host.fire("agent_settled");
    expect(await change).toMatchObject({ cap: 200_000 });
    expect(await host.session().getState()).toMatchObject({ cap: 200_000 });
  });

  test("failed settings leave the received settings available for reset and model changes", async () => {
    const host = await start();
    budgets.keepRecentTokens = 200_000;
    await expect(host.session().updateSettings({ contextWindowCap: 100_000, contextWindowCapEnabled: true, modelContextWindowCaps: { "test/other": 100_000 } })).rejects.toThrow("compaction budgets");
    await host.session().setManualCap(500_000);
    await host.session().resetManualCap();
    await host.selectModel(model("other", 1_000_000));
    expect(await host.session().getState()).toMatchObject({ cap: 300_000 });
  });

  test("a failed history write does not replace the received settings", async () => {
    const host = await start();
    const received: unknown[] = [];
    host.session().subscribe((state: unknown) => received.push(state), () => undefined);
    await host.session().getState();
    await Promise.resolve();
    const settings = { contextWindowCap: 400_000, contextWindowCapEnabled: true, modelContextWindowCaps: {} };
    const push = host.branch.push;
    host.branch.push = () => { throw new Error("disk failure"); };

    try {
      await expect(host.session().updateSettings(settings)).rejects.toThrow("disk failure");
    } finally { host.branch.push = push; }
    expect(await host.session().getState()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });
    expect(host.model!.contextWindow).toBe(300_000);
    expect(received).toEqual([{ cap: 300_000, source: "config", appliedWindow: 300_000 }]);
    await host.session().setManualCap(500_000);
    await host.session().resetManualCap();
    expect(await host.session().getState()).toMatchObject({ cap: 300_000 });
    await host.session().updateSettings(settings);
    expect(received.at(-1)).toEqual({ cap: 400_000, source: "config", appliedWindow: 400_000 });
  });

  test("keeps the manual choice across model switches and logs only effective changes", async () => {
    const large = model("large", 1_000_000);
    const host = await start([], large);
    await host.session().setManualCap(500_000);
    await host.selectModel(model("small", 200_000));
    expect(await host.session().getState()).toEqual({ cap: 500_000, source: "manual", appliedWindow: 200_000 });
    await host.selectModel(large);
    expect(await host.session().getState()).toEqual({ cap: 500_000, source: "manual", appliedWindow: 500_000 });
    expect(large.contextWindow).toBe(500_000);
    expect(host.caps()).toEqual([
      { cap: 300_000, source: "config" }, { cap: 500_000, source: "manual" },
      { cap: 500_000, source: "manual", clamp: 200_000 }, { cap: 500_000, source: "manual" },
    ]);
  });

  test("restores the chosen cap and its clamp from one current record on reopen", async () => {
    const first = await start();
    await first.session().setManualCap(500_000);
    await first.selectModel(model("small", 200_000));
    await first.fire("session_shutdown");
    const reopened = await start(first.branch, model("small", 200_000), general(400_000));
    expect(await reopened.session().getState()).toEqual({ cap: 500_000, source: "manual", appliedWindow: 200_000 });
    expect(reopened.caps().length).toBe(first.caps().length);
  });

  test("restores a manual choice clamped below the numeric cap range and returns to it on a larger model", async () => {
    const first = await start();
    await first.session().setManualCap(300_000);
    await first.selectModel(model("small", 64_000));
    expect(await first.session().getState()).toEqual({ cap: 300_000, source: "manual", appliedWindow: 64_000 });
    await first.fire("session_shutdown");
    const reopened = await start(first.branch, model("small", 64_000));
    expect(await reopened.session().getState()).toEqual({ cap: 300_000, source: "manual", appliedWindow: 64_000 });
    await reopened.selectModel(model("large", 1_000_000));
    expect(await reopened.session().getState()).toEqual({ cap: 300_000, source: "manual", appliedWindow: 300_000 });
    expect(reopened.notes.filter(([type]) => type === "error")).toEqual([]);
    expect(reopened.caps()).toEqual([
      { cap: 300_000, source: "config" }, { cap: 300_000, source: "manual" },
      { cap: 300_000, source: "manual", clamp: 64_000 }, { cap: 300_000, source: "manual" },
    ]);
  });

  test("records reset and source changes that keep the same window, and restores them", async () => {
    const host = await start();
    await host.session().setManualCap(300_000);
    await host.session().resetManualCap();
    expect(host.caps()).toEqual([{ cap: 300_000, source: "config" }, { cap: 300_000, source: "manual" }, { cap: 300_000, source: "config" }]);
    await host.fire("session_shutdown");
    const reloaded = await start(host.branch, model("large", 1_000_000), general(400_000));
    expect(await reloaded.session().getState()).toEqual({ cap: 400_000, source: "config", appliedWindow: 400_000 });
  });

  test("subscribers see source changes that keep the same window, but not a repeated choice", async () => {
    const host = await start();
    const received: unknown[] = [];
    host.session().subscribe((state: unknown) => received.push(state), () => undefined);
    await host.session().getState();
    await Promise.resolve();
    await host.session().setManualCap(300_000);
    await host.session().setManualCap(300_000);
    await host.session().resetManualCap();
    expect(received).toEqual([
      { cap: 300_000, source: "config", appliedWindow: 300_000 },
      { cap: 300_000, source: "manual", appliedWindow: 300_000 },
      { cap: 300_000, source: "config", appliedWindow: 300_000 },
    ]);
  });

  test("keeps the current setting on tree navigation", async () => {
    const host = await start();
    const received: unknown[] = [];
    host.session().subscribe((state: unknown) => received.push(state), error => { throw error; });
    await host.session().getState();
    await Promise.resolve();
    const config = { cap: 300_000, source: "config", appliedWindow: 300_000 };
    const manual = { cap: 500_000, source: "manual", appliedWindow: 500_000 };
    expect(received).toEqual([config]);
    expect(host.model!.contextWindow).toBe(300_000);
    const root = [...host.branch];
    await host.session().setManualCap(500_000);
    expect(received).toEqual([config, manual]);
    expect(host.model!.contextWindow).toBe(500_000);
    const manualBranch = [...host.branch];
    host.branch = root;
    await host.fire("session_tree");
    expect(await host.session().getState()).toEqual(manual);
    expect(received.at(-1)).toEqual(manual);
    expect(host.model!.contextWindow).toBe(500_000);
    host.branch = manualBranch;
    await host.fire("session_tree");
    expect(await host.session().getState()).toEqual({ cap: 500_000, source: "manual", appliedWindow: 500_000 });
    expect(received.at(-1)).toEqual(manual);
    expect(received.slice(1).every(value => JSON.stringify(value) === JSON.stringify(manual))).toBe(true);
    expect(host.model!.contextWindow).toBe(500_000);
  });

  test("corrupt current settings reject pending changes and report the error", async () => {
    const host = await start();
    await host.session().setManualCap(500_000);
    const valid = [...host.branch];
    const failure = "Saved context cap is invalid";
    host.idle = false;
    const pending = Promise.allSettled([host.session().setManualCap(400_000), host.session().resetManualCap()]);
    const corrupt: Entry[] = [...valid, { type: "custom", customType: CAP_ENTRY, data: { cap: -1, source: "manual" }, id: "corrupt-cap" }];
    const corruptHistory = structuredClone(corrupt);
    host.branch = corrupt;
    host.savedCap = corrupt.at(-1);
    await host.fire("session_tree");
    const rejected = { status: "rejected", reason: expect.objectContaining({ message: failure }) };
    expect(await pending).toEqual([rejected, rejected]);
    expect(host.branch).toEqual(corruptHistory);
    await expect(host.session().getState()).rejects.toThrow(failure);
    await expect(host.session().setManualCap(400_000)).rejects.toThrow(failure);
    await expect(host.session().updateSettings({ contextWindowCap: 400_000, contextWindowCapEnabled: true, modelContextWindowCaps: {} })).rejects.toThrow(failure);
    expect(host.notes).toContainEqual(["error", expect.stringContaining(failure)]);
    host.idle = true;
    host.branch = valid;
    host.savedCap = valid.at(-1);
    await host.fire("session_tree");
    expect(await host.session().getState()).toEqual({ cap: 500_000, source: "manual", appliedWindow: 500_000 });
    expect(await host.session().setManualCap(400_000)).toEqual({ cap: 400_000, source: "manual", appliedWindow: 400_000 });
  });

  test("rejects invalid choices without changing state or the log", async () => {
    const host = await start();
    const before = host.caps().length;
    await expect(host.session().setManualCap(2_000_000)).rejects.toThrow("exceeds");
    await expect(host.session().setManualCap(50_000)).rejects.toThrow("from 100,000");
    budgets.keepRecentTokens = 600_000;
    await expect(host.session().setManualCap(500_000)).rejects.toThrow("compaction budgets");
    await expect(host.updateDefaults(general(10))).rejects.toThrow("General context cap setting");
    expect(await host.session().getState()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });
    expect(host.caps().length).toBe(before);
  });

  test("applies queued changes at idle in receipt order and continues after a failure", async () => {
    const host = await start();
    host.idle = false;
    const results = [
      host.session().setManualCap(400_000),
      host.updateDefaults(general(250_000)),
      host.session().resetManualCap(),
      host.session().setManualCap(600_000),
      host.session().setManualCap(450_000),
    ];
    await host.selectModel(model("medium", 500_000));
    expect(host.caps().at(-1)).toEqual({ cap: 300_000, source: "config" });
    host.idle = true;
    await host.fire("agent_settled", { aborted: false });
    expect(await results[2]).toEqual({ cap: 250_000, source: "config", appliedWindow: 250_000 });
    const settled = await Promise.allSettled(results);
    expect(settled.map(result => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled"]);
    expect(await results[4]).toEqual({ cap: 450_000, source: "manual", appliedWindow: 450_000 });
    expect(await host.session().getState()).toEqual({ cap: 450_000, source: "manual", appliedWindow: 450_000 });
    expect(host.caps()).toEqual([
      { cap: 300_000, source: "config" }, { cap: 400_000, source: "manual" },
      { cap: 250_000, source: "config" }, { cap: 450_000, source: "manual" },
    ]);
  });

  test("applies pending changes before a prompt starts", async () => {
    const host = await start();
    host.idle = false;
    const change = host.session().setManualCap(500_000);
    host.idle = true;
    await host.fire("input", { text: "hello", source: "interactive" });
    expect(await change).toEqual({ cap: 500_000, source: "manual", appliedWindow: 500_000 });
  });

  test("a queued choice is validated again against compaction budgets that changed while it waited", async () => {
    const host = await start([], model("large", 1_000_000), general(500_000));
    const received: unknown[] = [];
    host.session().subscribe((state: unknown) => received.push(state), () => undefined);
    await host.session().getState();
    await Promise.resolve();
    const log = host.caps();
    host.idle = false;
    const outcome = host.session().setManualCap(400_000).catch((error: Error) => error);

    try {
      budgets.keepRecentTokens = 450_000;
      host.idle = true;
      await host.fire("agent_settled", { aborted: false });
      const result = await outcome;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("compaction budgets");
      expect(await host.session().getState()).toEqual({ cap: 500_000, source: "config", appliedWindow: 500_000 });
      expect(host.model!.contextWindow).toBe(500_000);
      expect(host.caps()).toEqual(log);
      expect(received).toEqual([{ cap: 500_000, source: "config", appliedWindow: 500_000 }]);
    } finally { budgets.keepRecentTokens = 20_000; }
    expect(await host.session().setManualCap(400_000)).toEqual({ cap: 400_000, source: "manual", appliedWindow: 400_000 });
  });

  test("model default bypasses defaults and the numeric range", async () => {
    const host = await start();
    await host.session().setManualCap(null);
    expect(await host.session().getState()).toEqual({ cap: null, source: "manual", appliedWindow: 1_000_000 });
    await host.updateDefaults(general(200_000));
    expect((await host.session().getState()).cap).toBeNull();
    const savedCaps = host.caps();
    await host.fire("session_shutdown");
    const reopened = await start(host.branch, model("small", 64_000), general(400_000));
    expect(await reopened.session().getState()).toEqual({ cap: null, source: "manual", appliedWindow: 64_000 });
    expect(reopened.notes.filter(([type]) => type === "error")).toEqual([]);
    expect(reopened.caps()).toEqual(savedCaps);
    await reopened.session().resetManualCap();
    expect(await reopened.session().getState()).toEqual({ cap: 400_000, source: "config", appliedWindow: 64_000 });
  });

  test("reports and blocks prompts when a model switch cannot fit the compaction budgets", async () => {
    const host = await start();
    await host.selectModel(model("tiny", 32_000));
    expect(host.notes.some(([type, message]) => type === "error" && message.includes("compaction budgets"))).toBe(true);
    expect(await host.fire("input", { text: "hello", source: "interactive" })).toEqual({ action: "handled" });
    expect(await host.fire("input", { text: "/skill:review check this", source: "interactive" })).toEqual({ action: "handled" });

    const errors = host.notes.filter(([type]) => type === "error").length;
    await host.selectModel(model("large", 1_000_000));
    expect(await host.session().getState()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });
    expect(host.model?.contextWindow).toBe(300_000);
    expect(await host.fire("input", { text: "hello", source: "interactive" })).toBeUndefined();
    expect(await host.fire("input", { text: "/skill:review check this", source: "interactive" })).toBeUndefined();
    expect(host.notes.filter(([type]) => type === "error")).toHaveLength(errors);
  });

  test("a provider refresh can lower the true window to the applied cap", async () => {
    const host = await start([], model("large", 1_000_000));
    host.model = model("large", 300_000);
    host.bus.get("piop:models-refreshed")?.forEach(handler => handler({ ctx: host.ctx }));
    expect(await host.session().setManualCap(null)).toEqual({ cap: null, source: "manual", appliedWindow: 300_000 });
    expect(host.model.contextWindow).toBe(300_000);
  });

  test("an unchanged model cap stays valid after a provider refresh lowers the window", async () => {
    const defaults = { agentDefinition: undefined, modelConfig: 500_000, generalConfig: 300_000 };
    const host = await start([], model("large", 1_000_000), defaults);
    host.model = model("large", 200_000);
    host.bus.get("piop:models-refreshed")?.forEach(handler => handler({ ctx: host.ctx }));
    expect(await host.updateDefaults(defaults)).toEqual({ cap: 500_000, source: "config", appliedWindow: 200_000 });
    await expect(host.updateDefaults({ ...defaults, modelConfig: 400_000 })).rejects.toThrow("exceeds the 200,000-token context window");
    await host.selectModel(model("other", 200_000));
    await expect(host.updateDefaults(defaults)).rejects.toThrow("exceeds the 200,000-token context window of test/other");
  });

  test("subscribers see provider refreshes that change only the applied window", async () => {
    const host = await start([], model("large", 1_000_000));
    await host.session().setManualCap(500_000);
    const received: unknown[] = [];
    host.session().subscribe((state: unknown) => received.push(state), () => undefined);
    await host.session().getState();
    await Promise.resolve();
    host.model = model("large", 200_000);
    host.bus.get("piop:models-refreshed")?.forEach(handler => handler({ ctx: host.ctx }));
    expect(await host.session().getState()).toEqual({ cap: 500_000, source: "manual", appliedWindow: 200_000 });
    host.model = model("large", 1_000_000);
    host.bus.get("piop:models-refreshed")?.forEach(handler => handler({ ctx: host.ctx }));
    expect(await host.session().getState()).toEqual({ cap: 500_000, source: "manual", appliedWindow: 500_000 });
    await Promise.resolve();
    expect(received).toEqual([
      { cap: 500_000, source: "manual", appliedWindow: 500_000 },
      { cap: 500_000, source: "manual", appliedWindow: 200_000 },
      { cap: 500_000, source: "manual", appliedWindow: 500_000 },
    ]);
  });

  for (const announced of [true, false]) test("keeps the true window when Pi replaces the model object with a capped copy" + (announced ? " and announces it" : ""), async () => {
    const host = await start([], model("codex", 272_000));
    await host.session().setManualCap(100_000);
    host.model = { ...host.model! };
    expect(host.model.contextWindow).toBe(100_000);

    if (announced) host.bus.get("piop:models-refreshed")?.forEach(handler => handler({ ctx: host.ctx }));
    expect(await host.session().setManualCap(null)).toEqual({ cap: null, source: "manual", appliedWindow: 272_000 });
    expect(host.model.contextWindow).toBe(272_000);
  });

  test("rejects new default caps above the current model window and clamps existing ones after a model switch", async () => {
    const host = await start([], model("large", 1_000_000));
    await host.selectModel(model("small", 200_000));
    expect(await host.session().getState()).toEqual({ cap: 300_000, source: "config", appliedWindow: 200_000 });
    const log = host.caps();
    await expect(host.updateDefaults(general(500_000))).rejects.toThrow("exceeds the 200,000-token context window");
    await expect(host.updateDefaults({ agentDefinition: 400_000, modelConfig: undefined, generalConfig: 300_000 })).rejects.toThrow("agent definition");
    await expect(host.updateDefaults({ agentDefinition: undefined, modelConfig: 250_000, generalConfig: 300_000 })).rejects.toThrow("exceeds");
    expect(await host.session().getState()).toEqual({ cap: 300_000, source: "config", appliedWindow: 200_000 });
    expect(host.caps()).toEqual(log);
    await host.session().resetManualCap();
    expect(await host.session().getState()).toEqual({ cap: 300_000, source: "config", appliedWindow: 200_000 });
  });

  test("shutdown rejects every unfinished change, a later idle cannot apply them, and new changes are refused", async () => {
    const large = model("large", 1_000_000);
    const host = await start([], large);
    const session = host.session();
    const received: unknown[] = [];
    session.subscribe((state: unknown) => received.push(state), () => undefined);
    await session.getState();
    await Promise.resolve();
    const log = host.caps();
    host.idle = false;
    const changes = Promise.allSettled([
      session.setManualCap(500_000),
      session.updateSettings({ contextWindowCap: 400_000, contextWindowCapEnabled: true, modelContextWindowCaps: {} }),
      session.resetManualCap(),
    ]);
    await host.fire("session_shutdown");
    const settled = await changes;
    expect(settled.map(result => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    for (const result of settled) expect((result as PromiseRejectedResult).reason.message).toBe("The session ended before the context cap change was applied");
    expect(large.contextWindow).toBe(1_000_000);
    host.idle = true;
    await host.fire("agent_settled", { aborted: false });
    expect(large.contextWindow).toBe(1_000_000);
    expect(host.caps()).toEqual(log);
    expect(received).toEqual([{ cap: 300_000, source: "config", appliedWindow: 300_000 }]);
    await expect(session.setManualCap(600_000)).rejects.toThrow("The session has ended");
    expect(host.caps()).toEqual(log);
  }, 1_000);

  test("shutdown before initialization rejects the waiting state and later changes without touching the model or history", async () => {
    const large = model("large", 1_000_000);
    const host = new Host([], large);
    const session = host.session();
    const received: unknown[] = [];
    const state = Promise.allSettled([session.getState()]);
    session.subscribe((value: unknown) => received.push(value), () => undefined);
    await host.fire("session_shutdown");
    expect(await state).toEqual([{ status: "rejected", reason: expect.objectContaining({ message: "The session ended before the context cap was initialized" }) }]);
    await expect(session.setManualCap(500_000)).rejects.toThrow("The session has ended");
    await Promise.resolve();
    expect(received).toEqual([]);
    expect(host.statuses).toEqual([]);
    expect(large.contextWindow).toBe(1_000_000);
    expect(host.branch).toEqual([]);
  }, 1_000);

  test("a subscriber added before the session starts gets the first state once", async () => {
    const host = new Host([], model("large", 1_000_000));
    const received: unknown[] = [];
    host.session().subscribe((state: unknown) => received.push(state), () => undefined);
    await host.fire("session_start", { reason: "startup" });
    await host.updateDefaults(general(300_000));
    await Promise.resolve();
    expect(received).toEqual([{ cap: 300_000, source: "config", appliedWindow: 300_000 }]);
  });

  test("a subscriber that unsubscribes before the session starts gets no state or error", async () => {
    const host = new Host([], model("large", 1_000_000));
    const session = host.session();
    const stale: unknown[] = [];
    const staleErrors: Error[] = [];
    const healthy: unknown[] = [];
    const stopStale = session.subscribe((state: unknown) => stale.push(state), (error: Error) => staleErrors.push(error));
    session.subscribe((state: unknown) => healthy.push(state), () => undefined);
    stopStale();
    await host.fire("session_start", { reason: "startup" });
    await host.updateDefaults(general(300_000));
    await Promise.resolve();
    await session.setManualCap(500_000);
    expect(healthy).toEqual([
      { cap: 300_000, source: "config", appliedWindow: 300_000 },
      { cap: 500_000, source: "manual", appliedWindow: 500_000 },
    ]);
    expect(stale).toEqual([]);
    expect(staleErrors).toEqual([]);
  });

  test("a corrupt saved entry at session start rejects the waiting first state and reports to subscribers", async () => {
    const failure = "Saved context cap is invalid";
    const host = new Host([{ type: "custom", customType: CAP_ENTRY, data: { cap: -1, source: "manual" }, id: "corrupt-cap" }], model("large", 1_000_000));
    const session = host.session();
    const received: unknown[] = [];
    const errors: Error[] = [];
    const first = Promise.allSettled([session.getState()]);
    session.subscribe((state: unknown) => received.push(state), (error: Error) => errors.push(error));
    await host.fire("session_start", { reason: "startup" });
    expect(await first).toEqual([{ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining(failure) }) }]);
    expect(received).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) expect(error.message).toContain(failure);
  });

  test("a failing subscriber reports its error without stopping changes or other subscribers", async () => {
    const host = await start();
    const errors: Error[] = [];
    const healthy: unknown[] = [];
    const stopFailing = host.session().subscribe((state: any) => { if (state.source === "manual") throw new Error("view failed"); }, (error: Error) => errors.push(error));
    host.session().subscribe((state: unknown) => healthy.push(state), () => undefined);
    await host.session().getState();
    await Promise.resolve();
    await expect(host.session().setManualCap(500_000)).resolves.toEqual({ cap: 500_000, source: "manual", appliedWindow: 500_000 });
    expect(errors.map(error => error.message)).toEqual(["view failed"]);
    stopFailing();
    await host.session().setManualCap(400_000);
    expect(errors).toHaveLength(1);
    expect(healthy).toEqual([
      { cap: 300_000, source: "config", appliedWindow: 300_000 },
      { cap: 500_000, source: "manual", appliedWindow: 500_000 },
      { cap: 400_000, source: "manual", appliedWindow: 400_000 },
    ]);
  });

  test("the /cap command applies at idle and reports parse errors", async () => {
    const host = await start();
    const handler = host.commands.get("cap").handler;
    await handler("0.75m", host.ctx);
    expect(await host.session().getState()).toEqual({ cap: 750_000, source: "manual", appliedWindow: 750_000 });
    expect(host.statuses.at(-1)).toEqual(["piop-context-cap", 'json:{"cap":750000,"source":"manual","appliedWindow":750000}']);
    await handler("lots", host.ctx);
    await handler("900m", host.ctx);
    expect(host.notes.filter(([type]) => type === "error").map(([, message]) => message)).toEqual([
      expect.stringContaining("Invalid context cap"), expect.stringContaining("from 100,000 to 50,000,000"),
    ]);
    expect(await host.session().getState()).toEqual({ cap: 750_000, source: "manual", appliedWindow: 750_000 });
  });
});
