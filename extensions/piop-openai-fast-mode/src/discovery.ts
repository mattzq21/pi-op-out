import { z } from "zod";
import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSupportedProvider } from "./payload";
import { DEFAULT_SERVICE_TIER, type FastTarget } from "./types";

type Model = NonNullable<ExtensionContext["model"]>;

type DiscoveryContext = Pick<ExtensionContext, "modelRegistry" | "model">;

type Catalog = Map<string, boolean>;

type CatalogResult = { catalog: Catalog; error?: string };

type CachedCatalog = { expires: number; pending: Promise<CatalogResult> };

export type FastModeDiscovery = { targets: FastTarget[]; errors: string[] };

const FAST_CATALOG_CLIENT_VERSION = "0.159.3";

const tiersSchema = z.array(z.object({ id: z.string().optional() }).catch({})).nullish().catch(undefined);

const speedsSchema = z.array(z.string().catch("")).nullish().catch(undefined);

const capabilitySchema = z.object({ service_tiers: tiersSchema, serviceTiers: tiersSchema, additional_speed_tiers: speedsSchema, additionalSpeedTiers: speedsSchema });

const catalogModelSchema = capabilitySchema.extend({ slug: z.string().nullish().catch(undefined), id: z.string().nullish().catch(undefined), model: z.string().nullish().catch(undefined) });

const catalogModelsSchema = z.array(catalogModelSchema.optional().catch(undefined));

const catalogSchema = z.object({ models: catalogModelsSchema.nullish(), data: catalogModelsSchema.nullish() });

function fastCapability(value: z.infer<typeof capabilitySchema>): boolean | undefined {
  const tiers = value.service_tiers ?? value.serviceTiers;
  const speeds = value.additional_speed_tiers ?? value.additionalSpeedTiers;

  if (!tiers && !speeds) return undefined;

  return Boolean(tiers?.some(tier => tier.id === DEFAULT_SERVICE_TIER) || speeds?.includes("fast"));
}

function parseCatalog(value: z.infer<typeof catalogSchema>): Catalog {
  const models = value.models ?? value.data;

  if (!models) throw new Error("Invalid model catalog");
  const catalog: Catalog = new Map();

  for (const model of models) {
    if (!model) continue;
    const id = model.slug ?? model.id ?? model.model;
    const supported = fastCapability(capabilitySchema.parse(model));

    if (id !== undefined && id !== null && supported !== undefined) catalog.set(id, supported);
  }

  return catalog;
}

function catalogUrl(model: Model, baseUrl = model.baseUrl): URL {
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/, "").replace(/\/responses$/, "");

  if (model.api === "openai-codex-responses") {
    if (!path.endsWith("/codex")) path += "/codex";
  }

  url.pathname = `${path}/models`;
  url.searchParams.set("client_version", FAST_CATALOG_CLIENT_VERSION);

  return url;
}

function accountId(apiKey: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(apiKey.split(".")[1], "base64url").toString("utf8"));
    const account = z.object({ "https://api.openai.com/auth": z.object({ chatgpt_account_id: z.string().optional() }) }).safeParse(claims).data?.["https://api.openai.com/auth"].chatgpt_account_id;

    return account;
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
  let daemonCatalog: Promise<z.infer<typeof daemonCatalogSchema> | undefined> | undefined;
  const daemonCatalogSchema = z.array(z.object({ provider: z.string(), model: z.string(), supported: z.boolean() }));

  async function startupCatalog(model: Model): Promise<Catalog | undefined> {
    const broker = process.env.PI_DESKTOP_BROKER_URL;
    const token = process.env.PI_DESKTOP_BROKER_TOKEN;

    if (!broker || !token) return undefined;
    daemonCatalog ??= fetch(`${broker}/fast-capabilities`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: process.env.PI_DESKTOP_HOST_ID || "local" }), signal: AbortSignal.timeout(30_000),
    }).then(async response => {
      if (!response.ok) throw new Error("Fast mode startup catalog unavailable");
      const body = z.object({ data: z.object({ clientVersion: z.literal(FAST_CATALOG_CLIENT_VERSION), models: daemonCatalogSchema }) }).parse(await response.json());

      return body.data.models;
    }).catch(() => undefined);
    const entries = await daemonCatalog;

    if (!entries) return undefined;

    return new Map(entries.filter(entry => entry.provider === model.provider).map(entry => [entry.model, entry.supported]));
  }

  async function catalog(ctx: DiscoveryContext, model: Model): Promise<CatalogResult> {
    const startup = await startupCatalog(model);

    if (startup?.size) return { catalog: startup };
    const failure = (cause: unknown): CatalogResult => ({ catalog: new Map(), error: `Fast mode could not load the ${model.provider} model list: ${cause instanceof Error ? cause.message : String(cause)}` });

    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);

      if (!auth.ok) return failure(auth.error);
      const url = catalogUrl(model, auth.baseUrl ?? model.baseUrl);
      const headers = requestHeaders(model, auth.apiKey, auth.headers);
      const identity = createHash("sha256").update(JSON.stringify([...headers.entries()])).digest("hex");
      const key = `${model.provider}:${url}:${identity}`;
      const cached = cache.get(key);

      if (cached && cached.expires > Date.now()) return cached.pending;

      for (const [key, entry] of cache) if (entry.expires <= Date.now()) cache.delete(key);

      const entry: CachedCatalog = {
        expires: process.env.PI_DESKTOP_BROKER_URL ? Infinity : Date.now() + 300_000,
        pending: fetch(url, { headers, signal: AbortSignal.timeout(5_000), redirect: "error" })
          .then(async response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            return { catalog: parseCatalog(catalogSchema.parse(await response.json())) };
          }).catch((cause: unknown) => { entry.expires = Date.now() + 30_000;

          return failure(cause); }),
      };

      cache.set(key, entry);

      return entry.pending;
    } catch (cause) { return failure(cause); }
  }

  return async (ctx: DiscoveryContext, configured: FastTarget[], previous: FastTarget[]): Promise<FastModeDiscovery> => {
    const models = ctx.modelRegistry.getAvailable().filter(model => isSupportedProvider(model.provider));

    const currentModel = ctx.model;

    if (currentModel && isSupportedProvider(currentModel.provider) && !models.some(model => model.provider === currentModel.provider && model.id === currentModel.id)) models.push(currentModel);
    const groups = new Map<string, Model[]>();

    for (const model of models) {
      const key = `${model.provider}:${model.baseUrl}:${model.api}`;
      groups.set(key, [...groups.get(key) ?? [], model]);
    }

    const errors: string[] = [];
    const targets = await Promise.all([...groups.values()].map(async group => {
      const { catalog: remote, error } = await catalog(ctx, group[0]);

      if (error) errors.push(error);

      return group.flatMap(model => {
        const supported = remote.get(model.id) ?? fastCapability(capabilitySchema.parse(model));
        const explicit = configured.find(target => target.provider === model.provider && target.model === model.id);
        const known = error && previous.some(target => target.provider === model.provider && target.model === model.id) ? true : undefined;

        if (!(supported ?? known ?? (model.api !== "openai-codex-responses" && !!explicit))) return [];

        return [{ provider: model.provider, model: model.id, serviceTier: DEFAULT_SERVICE_TIER }];
      });
    }));

    return { targets: targets.flat(), errors };
  };
}
