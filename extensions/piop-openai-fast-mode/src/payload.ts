import { z } from "zod";
import type { BeforeProviderRequestEvent } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SERVICE_TIER,
  SUPPORTED_PROVIDERS,
  type FastModeConfig,
  type FastTarget,
  type ModelRef,
} from "./types";

const SUPPORTED_PROVIDER_SET = new Set<string>(SUPPORTED_PROVIDERS);

const modelRefSchema = z.object({ provider: z.string().min(1), id: z.string().min(1) });

const payloadSchema = z.record(z.string(), z.json().optional());

export function toModelRef(model: ModelRef | undefined): ModelRef | undefined {
  return modelRefSchema.safeParse(model).data;
}

export function isSupportedProvider(provider: string): boolean {
  return SUPPORTED_PROVIDER_SET.has(provider);
}

export function findMatchingTarget(
  model: ModelRef | undefined,
  targets: FastTarget[],
): FastTarget | undefined {
  if (!model || !isSupportedProvider(model.provider)) return undefined;

  return targets.find(
    (target) =>
      target.provider === model.provider &&
      target.model === model.id &&
      isSupportedProvider(target.provider),
  );
}

export function applyFastModePayload(
  payload: BeforeProviderRequestEvent["payload"],
  serviceTier: string,
) {
  const parsed = payloadSchema.safeParse(payload);

  if (!parsed.success) return undefined;

  return {
    ...parsed.data,
    service_tier: serviceTier || DEFAULT_SERVICE_TIER,
  };
}

export function getFastModePayload(
  config: FastModeConfig,
  model: ModelRef | undefined,
  payload: BeforeProviderRequestEvent["payload"],
) {
  if (!config.enabled) return undefined;

  const target = findMatchingTarget(model, config.targets);

  if (!target) return undefined;

  return applyFastModePayload(
    payload,
    target.serviceTier ?? DEFAULT_SERVICE_TIER,
  );
}
