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
  idle = true;
  agentCap: number | null | undefined;
  model: Model | undefined;
  ctx: any;

  constructor(public branch: Entry[], model?: Model) {
    this.model = model;
    const host = this;
    this.ctx = {
      get model() { return host.model; },
      isIdle: () => host.idle,
      sessionManager: { getBranch: () => host.branch },
      ui: { notify: (message: string, type: string) => host.notes.push([type, message]), setStatus: (key: string, text?: string) => host.statuses.push([key, text]) },
    };
    contextWindowCap(this.api() as any);
    this.api().events.on("piop:agents:context-cap", request => { request.cap = this.agentCap; });
  }

  api() {
    return {
      on: (name: string, handler: any) => { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); },
      registerCommand: (name: string, options: any) => { this.commands.set(name, options); },
      appendEntry: (customType: string, data: unknown) => { this.branch.push({ type: "custom", customType, data: structuredClone(data), id: crypto.randomUUID() }); },
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
    const push = host.branch.push;
    host.branch.push = () => { throw new Error("disk failure"); };
    await expect(host.session().updateSettings({ contextWindowCap: 400_000, contextWindowCapEnabled: true, modelContextWindowCaps: {} })).rejects.toThrow("disk failure");
    host.branch.push = push;
    await host.session().setManualCap(500_000);
    await host.session().resetManualCap();
    expect(await host.session().getState()).toMatchObject({ cap: 300_000 });
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
      { cap: 200_000, source: "modelMax" }, { cap: 500_000, source: "manual" },
    ]);
  });

  test("restores the choice before a trailing modelMax entry on reopen", async () => {
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
      { cap: 64_000, source: "modelMax" }, { cap: 300_000, source: "manual" },
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

  test("restores each branch on tree navigation", async () => {
    const host = await start();
    const root = [...host.branch];
    await host.session().setManualCap(500_000);
    const manualBranch = [...host.branch];
    host.branch = root;
    await host.fire("session_tree");
    expect(await host.session().getState()).toEqual({ cap: 300_000, source: "config", appliedWindow: 300_000 });
    host.branch = manualBranch;
    await host.fire("session_tree");
    expect(await host.session().getState()).toEqual({ cap: 500_000, source: "manual", appliedWindow: 500_000 });
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
    ];
    await host.selectModel(model("medium", 500_000));
    expect(host.caps().at(-1)).toEqual({ cap: 300_000, source: "config" });
    host.idle = true;
    await host.fire("agent_settled", { aborted: false });
    const settled = await Promise.allSettled(results);
    expect(settled.map(result => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "rejected"]);
    expect(await host.session().getState()).toEqual({ cap: 250_000, source: "config", appliedWindow: 250_000 });
    expect(host.caps()).toEqual([{ cap: 300_000, source: "config" }, { cap: 400_000, source: "manual" }, { cap: 250_000, source: "config" }]);
  });

  test("applies pending changes before a prompt starts", async () => {
    const host = await start();
    host.idle = false;
    const change = host.session().setManualCap(500_000);
    host.idle = true;
    await host.fire("input", { text: "hello", source: "interactive" });
    expect(await change).toEqual({ cap: 500_000, source: "manual", appliedWindow: 500_000 });
  });

  test("model default bypasses defaults and the numeric range", async () => {
    const host = await start();
    await host.session().setManualCap(null);
    expect(await host.session().getState()).toEqual({ cap: null, source: "manual", appliedWindow: 1_000_000 });
    await host.updateDefaults(general(200_000));
    expect((await host.session().getState()).cap).toBeNull();
  });

  test("reports and blocks prompts when a model switch cannot fit the compaction budgets", async () => {
    const host = await start();
    await host.selectModel(model("tiny", 32_000));
    expect(host.notes.some(([type, message]) => type === "error" && message.includes("compaction budgets"))).toBe(true);
    expect(await host.fire("input", { text: "hello", source: "interactive" })).toEqual({ action: "handled" });
    expect(await host.fire("input", { text: "/skill:review check this", source: "interactive" })).toEqual({ action: "handled" });
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

  test("shutdown rejects unfinished changes and restores original windows", async () => {
    const large = model("large", 1_000_000);
    const host = await start([], large);
    host.idle = false;
    const change = host.session().setManualCap(500_000);
    await host.fire("session_shutdown");
    await expect(change).rejects.toThrow("session ended");
    expect(large.contextWindow).toBe(1_000_000);
  });

  test("a subscriber added before the session starts gets the first state once", async () => {
    const host = new Host([], model("large", 1_000_000));
    const received: unknown[] = [];
    host.session().subscribe((state: unknown) => received.push(state), () => undefined);
    await host.fire("session_start", { reason: "startup" });
    await host.updateDefaults(general(300_000));
    await Promise.resolve();
    expect(received).toEqual([{ cap: 300_000, source: "config", appliedWindow: 300_000 }]);
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
