import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { brokerState } from "./state.mjs";

type UsageWindow = { percent: number; status: "ok" | "rate-limited"; resetsAt?: string };
type Usage = { rolling: UsageWindow; weekly: UsageWindow; monthly: UsageWindow };
type Account = { id: string; provider: string; key: string };
type Health = { checked?: number; usage?: Usage; blockedUntil?: number };
type Update = { id: string; checked: number; usage: Usage };
type Source = Provider["streamSimple"];
export type GoBrokerSettings = { enabled: boolean; failover: boolean };
type Request = {
  source: Source; model: Parameters<Source>[0]; messages: Parameters<Source>[1];
  options: NonNullable<Parameters<Source>[2]>; session: string; ctx: ExtensionContext;
  output: ReturnType<typeof createAssistantMessageEventStream>; failover: boolean;
};
const PROVIDER = "opencode-go";
const MARKER = Symbol.for("piop.opencode-go-broker");
const statePath = join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "opencode-go-broker", "state.json");

function goEndpoint(baseUrl: string) {
  try { const url = new URL(baseUrl); return url.origin === "https://opencode.ai" && url.pathname.replace(/\/$/, "") === "/zen/go/v1"; }
  catch { return false; }
}

function validateWindow(window: UsageWindow) {
  if (!window || !Number.isFinite(window.percent) || window.percent < 0 || window.percent > 100) throw new Error("Invalid Go usage");
  if (window.status !== "ok" && window.status !== "rate-limited") throw new Error("Unknown Go usage status");
  if (window.resetsAt && !Number.isFinite(Date.parse(window.resetsAt))) throw new Error("Invalid Go reset time");
}

function parseUsage(value: unknown): Usage {
  const usage = (value as { usage?: Usage })?.usage;
  if (!usage) throw new Error("Missing Go usage");
  for (const name of ["rolling", "weekly", "monthly"] as const) validateWindow(usage[name]);
  return usage;
}

function requestHeaders(request: Request) {
  const headers = Object.fromEntries(Object.entries(request.options.headers || {}).filter(([key]) => !/^(authorization|x-api-key|x-opencode-session)$/i.test(key)));
  headers["x-opencode-session"] = request.session;
  return headers;
}

function errorBackoff(event: AssistantMessageEvent, status: number, signal?: AbortSignal) {
  if (event.type !== "error" || signal?.aborted) return 0;
  return cooldown(status, event.error.errorMessage || "");
}

async function sendAttempt(request: Request, account: Account, lease: string): Promise<AssistantMessageEvent | undefined> {
  const { model, messages, options, output } = request;
  let status = 0, backoff = 0, emitted = false, terminal = false;
  let start: AssistantMessageEvent | undefined;
  const emit = (event: AssistantMessageEvent) => {
    if (!emitted && start) output.push(start);
    emitted = true;
    terminal = event.type === "done" || event.type === "error";
    output.push(event);
  };
  const heartbeat = setInterval(() => { void brokerState(statePath, { action: "renew", lease }).catch(() => {}); }, 30000);
  heartbeat.unref();
  try {
    options.signal?.throwIfAborted();
    const modelHeaders = Object.fromEntries(Object.entries(model.headers || {}).filter(([key]) => !/^(authorization|x-api-key)$/i.test(key)));
    const stream = request.source({ ...model, headers: modelHeaders }, messages, { ...options, apiKey: account.key, headers: requestHeaders(request), maxRetries: 0,
      fetch: async (input, init) => { const response = await (options.fetch || fetch)(input, init); status = response.status; return response; },
    });
    for await (const event of stream) {
      if (event.type === "start") { start = event; continue; }
      backoff = errorBackoff(event, status, options.signal);
      if (!emitted && backoff && request.failover) return event;
      emit(event);
    }
    if (!terminal) throw new Error("OpenCode Go stream ended without a result");
  } finally {
    clearInterval(heartbeat);
    await brokerState(statePath, { action: "release", lease, account: account.id, cooldown: backoff });
  }
}

async function runRequest(request: Request) {
  const { ctx, model, options, session, output } = request;
  const pool = await accounts(ctx, model.id);
  if (!pool.length) throw new Error("No configured OpenCode Go account supports this model");
  const excluded: string[] = [];
  let lastError: AssistantMessageEvent | undefined;
  for (let attempt = 0; attempt < pool.length; attempt++) {
    options.signal?.throwIfAborted();
    const lease = randomUUID();
    const updates = await refreshUsage(pool, options.signal);
    options.signal?.throwIfAborted();
    const selected = await brokerState(statePath, { action: "acquire", session: createHash("sha256").update(session).digest("hex"), lease, accounts: pool.map(account => account.id), updates, excluded }) as { account: string };
    const account = pool.find(item => item.id === selected.account)!;
    ctx.ui.setStatus("piop-opencode-go-broker", `Go: ${ctx.modelRegistry.getProviderDisplayName(account.provider)}`);
    lastError = await sendAttempt(request, account, lease);
    if (!lastError) return;
    excluded.push(account.id);
  }
  if (lastError) output.push(lastError);
}

async function accounts(ctx: ExtensionContext, modelId: string): Promise<Account[]> {
  const providers = new Set(ctx.modelRegistry.getAll().filter(model => model.id === modelId && goEndpoint(model.baseUrl) && /^opencode-go(?:--piop-account-\d+)?$/.test(model.provider)).map(model => model.provider));
  const results = await Promise.allSettled([...providers].map(async provider => {
    const key = await ctx.modelRegistry.getApiKeyForProvider(provider);
    return key ? { provider, key, id: createHash("sha256").update(key).digest("hex") } : undefined;
  }));
  const found = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  return [...new Map(found.filter((account): account is Account => !!account).map(account => [account.id, account])).values()];
}

async function refreshUsage(pool: Account[], signal?: AbortSignal): Promise<Update[]> {
  const snapshot = await brokerState(statePath, { action: "snapshot" }) as Record<string, Health>;
  const updates = await Promise.all(pool.map(async account => {
    if ((snapshot[account.id]?.checked || 0) > Date.now() - 30000) return;
    const timeout = AbortSignal.timeout(5000);
    try {
      const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
        headers: { Authorization: `Bearer ${account.key}`, "User-Agent": "piop-go-broker/1.0" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) return;
      return { id: account.id, checked: Date.now(), usage: parseUsage(await response.json()) };
    } catch { return; }
  }));
  return updates.filter((update): update is Update => !!update);
}

function cooldown(status: number, error: string): number {
  if (status === 401 || /(?:\b401\b|AuthError)/.test(error)) return 300000;
  if (status === 429 || /(?:\b429\b|GoUsageLimitError)/.test(error)) return 60000;
  if (status >= 500 || /(?:\b50[0234]\b|fetch failed|ECONNRESET|ETIMEDOUT)/i.test(error)) return 15000;
  return 0;
}

function failure(model: Parameters<Provider["streamSimple"]>[0], error: unknown, aborted: boolean): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
    stopReason: aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : "OpenCode Go broker failed", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

export default function opencodeGoBroker(pi: ExtensionAPI) {
  let context: ExtensionContext;
  const settings = (): GoBrokerSettings => {
    const request: { settings?: { plugins?: { opencodeGoBroker?: GoBrokerSettings } } } = {};
    pi.events.emit("piop:runtime-settings", request);
    return request.settings?.plugins?.opencodeGoBroker ?? { enabled: false, failover: true };
  };
  const wrap = (source: Provider["streamSimple"]): Provider["streamSimple"] => (model, messages, options = {}) => {
    const config = settings();
    if (!config.enabled || !goEndpoint(model.baseUrl)) return source(model, messages, options);
    const output = createAssistantMessageEventStream();
    const headerSession = Object.entries(options.headers || {}).find(([key]) => key.toLowerCase() === "x-opencode-session")?.[1];
    const session = headerSession || options.sessionId || context.sessionManager.getSessionId();
    void runRequest({ source, model, messages, options, session, ctx: context, output, failover: config.failover }).catch(error => {
      const message = failure(model, error, options.signal?.aborted === true);
      output.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
    }).finally(() => output.end());
    return output;
  };
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    const registered = ctx.modelRegistry.getRegisteredNativeProvider(PROVIDER) as (Provider & { [MARKER]?: boolean }) | undefined;
    if (registered?.[MARKER]) return;
    const base = ctx.modelRegistry.getProvider(PROVIDER);
    if (!base) return;
    const provider = { ...base,
      getModels: () => base.getModels().map(model => settings().enabled ? { ...model, name: `${model.name} (automatic)` } : model),
      streamSimple: wrap(base.streamSimple), stream: wrap(base.stream as Provider["streamSimple"]) as Provider["stream"], [MARKER]: true };
    pi.registerProvider(provider);
  });
  pi.on("model_select", (event, ctx) => { if (event.model.provider !== PROVIDER) ctx.ui.setStatus("piop-opencode-go-broker", undefined); });
  const unsubscribe = pi.events.on("piop:plugins:refresh", value => {
    const request = value as { ctx: ExtensionContext; ready?: Promise<void> };
    if (!settings().enabled) request.ctx.ui.setStatus("piop-opencode-go-broker", undefined);
    request.ready = request.ctx.modelRegistry.refresh({ allowNetwork: false }).then(() => undefined);
  });
  pi.on("session_shutdown", () => unsubscribe());
}
