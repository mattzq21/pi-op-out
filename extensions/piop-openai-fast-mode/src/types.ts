import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PACKAGE_NAME = "piop-openai-fast-mode";

export const STATUS_KEY = PACKAGE_NAME;

export const DEFAULT_SERVICE_TIER = "priority";

export type SupportedProvider = "openai" | "openai-codex";

export const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = ["openai", "openai-codex"];

export type FastTarget = {
  provider: string;
  model: string;
  serviceTier?: string;
};

export type FastModeConfig = {
  enabled: boolean;
  targets: FastTarget[];
};

export type ModelRef = {
  provider: string;
  id: string;
};

export type ConfigScope = "user" | "project";

export type ResolvedConfigPath = {
  scope: ConfigScope;
  path: string;
};

export interface FastModeRequest {
  models?: string[]; ready?: Promise<void>; refresh?: boolean; apply?: boolean;
  enabled?: boolean; restore?: boolean; ctx?: ExtensionContext;
}

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:fast-mode", handler: (request: FastModeRequest) => void): () => void;
    emit(channel: "piop:fast-mode", request: FastModeRequest): void;
  }
}
