export const PACKAGE_NAME = "piop-openai-fast-mode";

export const STATUS_KEY = PACKAGE_NAME;

export const STATE_ENTRY = "piop-fast-mode-state";

export const DEFAULT_SERVICE_TIER = "priority";

export type SupportedProvider = "openai" | "openai-codex";

export const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = ["openai", "openai-codex"];

export type FastModeConfig = {
  enabled: boolean;
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

export interface FastModeSession {
  getEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
  subscribe(listener: (enabled: boolean) => void, onError: (error: Error) => void): () => void;
}

export interface FastModeSessionRequest {
  session?: FastModeSession;
}

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:fast-mode:session", handler: (request: FastModeSessionRequest) => void): () => void;
    emit(channel: "piop:fast-mode:session", request: FastModeSessionRequest): void;
  }
}
