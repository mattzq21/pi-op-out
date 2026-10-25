import { z } from "zod";
import type { BeforeProviderRequestEvent } from "@earendil-works/pi-coding-agent";
import anthropicFastModels from "./anthropic-fast-models.json";
import { DEFAULT_SERVICE_TIER, OPENAI_PROVIDERS, type ModelRef } from "./types";

const OPENAI_PROVIDER_SET = new Set<string>(OPENAI_PROVIDERS);

/** Anthropic models with fast mode, and the beta that a research preview model also needs. */
const ANTHROPIC_FAST_MODELS = new Map(anthropicFastModels.models.map(model => [model.id, "beta" in model ? model.beta : undefined]));

const modelRefSchema = z.object({ provider: z.string().min(1), id: z.string().min(1) });

const payloadSchema = z.record(z.string(), z.json().optional());

export function toModelRef(model: ModelRef | undefined): ModelRef | undefined {
  return modelRefSchema.safeParse(model).data;
}

/** True when this extension can turn on fast mode for the model's requests. OpenAI providers report model support in their model list; Anthropic models are a fixed list. */
export function appliesFastMode(model: ModelRef): boolean {
  return OPENAI_PROVIDER_SET.has(model.provider) || (model.provider === "anthropic" && ANTHROPIC_FAST_MODELS.has(model.id));
}

/** Adds the provider's fast mode fields when fast mode is on and applies to the model. */
export function getFastModePayload(enabled: boolean, model: ModelRef | undefined, payload: BeforeProviderRequestEvent["payload"]) {
  if (!enabled || !model || !appliesFastMode(model)) return undefined;
  const parsed = payloadSchema.safeParse(payload);

  if (!parsed.success) return undefined;

  if (model.provider !== "anthropic") return { ...parsed.data, service_tier: DEFAULT_SERVICE_TIER };
  const beta = ANTHROPIC_FAST_MODELS.get(model.id);
  const betas = Array.isArray(parsed.data.betas) ? parsed.data.betas : [];

  return { ...parsed.data, speed: "fast", ...(beta ? { betas: [...new Set([...betas, beta])] } : {}) };
}
