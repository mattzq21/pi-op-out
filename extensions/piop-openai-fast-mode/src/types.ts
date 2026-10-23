export const PACKAGE_NAME = "piop-openai-fast-mode";

export const STATUS_KEY = PACKAGE_NAME;

/** The session entry that saves the session's fast mode choice. */
export const STATE_ENTRY = "piop-fast-mode-state";

export const DEFAULT_SERVICE_TIER = "priority";

export type SupportedProvider = "openai" | "openai-codex";

/** Providers whose requests this extension knows how to change. This is not a check of model support. */
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

/**
 * The session's saved fast mode choice. setEnabled saves before it resolves; a failed save leaves the choice unchanged.
 * subscribe sends the current choice, then each change, and returns a function that stops the updates.
 */
export interface FastModeSession {
  getEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
  subscribe(listener: (enabled: boolean) => void, onError: (error: Error) => void): () => void;
}

/** Other extensions emit this request to get the fast mode extension's session interface. */
export interface FastModeSessionRequest {
  session?: FastModeSession;
}

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:fast-mode:session", handler: (request: FastModeSessionRequest) => void): () => void;
    emit(channel: "piop:fast-mode:session", request: FastModeSessionRequest): void;
  }
}
