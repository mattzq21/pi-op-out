import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, isSupportedProvider } from "./payload";
import { DEFAULT_SERVICE_TIER, type FastTarget } from "./types";

type Model = NonNullable<ExtensionContext["model"]>;
type Catalog = Map<string, boolean>;
type CachedCatalog = { expires: number; pending: Promise<Catalog> };

function fastCapability(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const tiers = value.service_tiers ?? value.serviceTiers;
  const speeds = value.additional_speed_tiers ?? value.additionalSpeedTiers;
  if (!Array.isArray(tiers) && !Array.isArray(speeds)) return undefined;
  return (Array.isArray(tiers) && tiers.some(tier => isRecord(tier) && tier.id === DEFAULT_SERVICE_TIER))
    || (Array.isArray(speeds) && speeds.includes("fast"));
}

function parseCatalog(value: unknown): Catalog {
  if (!isRecord(value)) throw new Error("Invalid model catalog");
  const models = value.models ?? value.data;
  if (!Array.isArray(models)) throw new Error("Invalid model catalog");
  const catalog: Catalog = new Map();
  for (const model of models) {
    if (!isRecord(model)) continue;
    const id = model.slug ?? model.id ?? model.model;
    const supported = fastCapability(model);
    if (typeof id === "string" && supported !== undefined) catalog.set(id, supported);
  }
  return catalog;
}

function catalogUrl(model: Model, baseUrl = model.baseUrl): URL {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/, "").replace(/\/responses$/, "");
  if (model.api === "openai-codex-responses") {
    if (!path.endsWith("/codex")) path += "/codex";
    url.searchParams.set("client_version", "0.142.2");
  }
  url.pathname = `${path}/models`;
  return url;
}

function accountId(apiKey: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(apiKey.split(".")[1], "base64url").toString("utf8"));
    const account = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof account === "string" ? account : undefined;
  } catch { return undefined; }
}

function requestHeaders(model: Model, apiKey: string | undefined, extra: Record<string, string | null> = {}): Headers {
  const headers = new Headers(model.headers);
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) headers.delete(key); else headers.set(key, value);
  }
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  if (model.api === "openai-codex-responses" && apiKey) {
    const account = accountId(apiKey);
    if (account) headers.set("chatgpt-account-id", account);
    headers.set("originator", "pi");
  }
  headers.set("Accept", "application/json");
  return headers;
}

export function createFastModeDiscovery() {
  const cache = new Map<string, CachedCatalog>();
  async function catalog(ctx: ExtensionContext, model: Model): Promise<Catalog> {
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return new Map();
      const url = catalogUrl(model, auth.baseUrl ?? model.baseUrl);
      const headers = requestHeaders(model, auth.apiKey, auth.headers);
      const identity = createHash("sha256").update(JSON.stringify([...headers.entries()])).digest("hex");
      const key = `${model.provider}:${url}:${identity}`;
      const cached = cache.get(key);
      if (cached && cached.expires > Date.now()) return cached.pending;
      for (const [key, entry] of cache) if (entry.expires <= Date.now()) cache.delete(key);
      const entry: CachedCatalog = {
        expires: Date.now() + 300_000,
        pending: fetch(url, { headers, signal: AbortSignal.timeout(5_000), redirect: "error" })
          .then(async response => {
            if (!response.ok) throw new Error("Model catalog unavailable");
            return parseCatalog(await response.json());
          }).catch(() => { entry.expires = Date.now() + 30_000; return new Map<string, boolean>(); }),
      };
      cache.set(key, entry);
      return entry.pending;
    } catch { return new Map(); }
  }

  return async (ctx: ExtensionContext, configured: FastTarget[]): Promise<FastTarget[]> => {
    const models = ctx.modelRegistry.getAvailable().filter(model => isSupportedProvider(model.provider));
    if (ctx.model && isSupportedProvider(ctx.model.provider) && !models.some(model => model.provider === ctx.model!.provider && model.id === ctx.model!.id)) models.push(ctx.model);
    const groups = new Map<string, Model[]>();
    for (const model of models) {
      const key = `${model.provider}:${model.baseUrl}:${model.api}`;
      groups.set(key, [...groups.get(key) ?? [], model]);
    }
    const targets = await Promise.all([...groups.values()].map(async group => {
      const remote = await catalog(ctx, group[0]);
      return group.flatMap(model => {
        const supported = remote.get(model.id) ?? fastCapability(model);
        const explicit = configured.find(target => target.provider === model.provider && target.model === model.id);
        if (!(supported ?? (model.api !== "openai-codex-responses" && !!explicit))) return [];
        return [{ provider: model.provider, model: model.id, serviceTier: DEFAULT_SERVICE_TIER }];
      });
    }));
    return targets.flat();
  };
}
