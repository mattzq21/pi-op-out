export type ContextCapSource = "manual" | "config" | "agent_definition";

export type ContextCapSettings = Readonly<{
  contextWindowCap: number;
  contextWindowCapEnabled: boolean;
  modelContextWindowCaps: Readonly<Record<string, number | null>>;
}>;

export type ContextCapState = Readonly<{
  /** Resolved choice before model clamping; null means use the model default. */
  cap: number | null;
  source: ContextCapSource;
  /** Window applied to Pi; null when no model is selected. */
  appliedWindow: number | null;
}>;

/** One instance per Pi session. Pi owns the current model. */
export interface ContextCapSession {
  /** Wait for initialization, then read applied state without waiting for idle. */
  getState(): Promise<ContextCapState>;

  /**
   * Set a manual choice. null implements /cap model_default.
   * New numeric choices must be in range, fit the current model window, and exceed Pi's
   * reserve plus recent-history budgets. A numeric choice requires a model.
   */
  setManualCap(cap: number | null): Promise<ContextCapState>;

  /** Implement /cap reset: resolve agent definition, model config, general config, then model default. */
  resetManualCap(): Promise<ContextCapState>;

  updateSettings(settings: ContextCapSettings): Promise<ContextCapState>;

  /** Receive initial state and later effective changes. Returns unsubscribe; listeners must not throw. */
  subscribe(listener: (state: ContextCapState) => void, onError: (error: Error) => void): () => void;
}

// Change operations share one session queue in receipt order. Each applies at idle, before queued
// follow-ups or goals start, and finishes after saving and applying. A failed operation rejects and
// leaves state unchanged. Shutdown rejects unfinished operations.

/** Other extensions emit this request on "piop:context-cap:session" to get the session interface. */
export interface ContextCapSessionRequest { session?: ContextCapSession }

/** Session log entry type. */
export const CAP_ENTRY = "piop-context-cap";

/** Status key the extension sets with its JSON state when the applied window may have changed. */
export const CONTEXT_CAP_STATUS_KEY = "piop-context-cap";


export type ContextCapEntry = { cap: number | null; source: ContextCapSource; clamp?: number };

export const MIN_CAP = 100_000;

export const MAX_CAP = 50_000_000;

/** Returns an error for a numeric cap outside the accepted range, or undefined. */
export function capRangeError(cap: number, label = "Context cap") {
  if (!Number.isSafeInteger(cap)) return `${label} must be a whole number of tokens`;

  if (cap < MIN_CAP || cap > MAX_CAP) return `${label} must be from ${MIN_CAP.toLocaleString("en-US")} to ${MAX_CAP.toLocaleString("en-US")} tokens`;
}

const multipliers = { "": 1, k: 1_000, m: 1_000_000 } as const;

/**
 * Parses a token count with up to two decimal places and an optional k or m suffix.
 * "0.75m" is 750000. Throws when the text is malformed, is not whole, or is out of range.
 */
export function parseCap(text: string) {
  const match = /^(\d+)(?:\.(\d{1,2}))?([kKmM]?)$/.exec(text.trim());

  if (!match) throw new Error(`Invalid context cap "${text.trim()}". Use a token count such as 500000, 500k, or 0.75m.`);
  const multiplier = multipliers[match[3].toLowerCase() as keyof typeof multipliers];
  const fraction = match[2] ?? "";
  const scaled = Number(match[1] + fraction.padEnd(2, "0")) * multiplier;

  if (!Number.isSafeInteger(scaled) || scaled % 100 !== 0) throw new Error(`Context cap "${text.trim()}" is not a whole number of tokens`);
  const cap = scaled / 100;
  const error = capRangeError(cap);

  if (error) throw new Error(error);

  return cap;
}

export type CapCommand = { kind: "show" } | { kind: "reset" } | { kind: "manual"; cap: number | null };

/** Parses /cap arguments: empty, reset, model_default, or a token count. */
export function parseCapCommand(args: string): CapCommand {
  const value = args.trim();

  if (!value) return { kind: "show" };

  if (value === "reset") return { kind: "reset" };

  if (value === "model_default") return { kind: "manual", cap: null };

  return { kind: "manual", cap: parseCap(value) };
}

export function formatTokens(value: number) {
  return value.toLocaleString("en-US");
}
