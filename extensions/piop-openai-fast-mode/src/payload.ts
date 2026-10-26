import { z } from "zod";
import type { BeforeProviderRequestEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SERVICE_TIER, SUPPORTED_PROVIDERS, type ModelRef } from "./types";

const SUPPORTED_PROVIDER_SET = new Set<string>(SUPPORTED_PROVIDERS);

const modelRefSchema = z.object({ provider: z.string().min(1), id: z.string().min(1) });

const payloadSchema = z.record(z.string(), z.json().optional());

export function toModelRef(model: ModelRef | undefined): ModelRef | undefined {
  return modelRefSchema.safeParse(model).data;
}

export function isSupportedProvider(provider: string): boolean {
  return SUPPORTED_PROVIDER_SET.has(provider);
}

/** Adds the priority service tier when fast mode is on and the request goes to a provider that this extension can change. */
export function getFastModePayload(enabled: boolean, model: ModelRef | undefined, payload: BeforeProviderRequestEvent["payload"]) {
  if (!enabled || !model || !isSupportedProvider(model.provider)) return undefined;
  const parsed = payloadSchema.safeParse(payload);

  if (!parsed.success) return undefined;

  return { ...parsed.data, service_tier: DEFAULT_SERVICE_TIER };
}
