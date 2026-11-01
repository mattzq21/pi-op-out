export type ContextCapSource = "manual" | "config" | "agent_definition";

export type ContextCapSettings = Readonly<{
  contextWindowCap: number;
  contextWindowCapEnabled: boolean;
  modelContextWindowCaps: Readonly<Record<string, number | null>>;
}>;

export type ContextCapState = Readonly<{
  cap: number | null;
  source: ContextCapSource;
  appliedWindow: number | null;
}>;

export interface ContextCapSession {
  getState(): Promise<ContextCapState>;

  setManualCap(cap: number | null): Promise<ContextCapState>;

  resetManualCap(): Promise<ContextCapState>;

  updateSettings(settings: ContextCapSettings): Promise<ContextCapState>;

  subscribe(listener: (state: ContextCapState) => void, onError: (error: Error) => void): () => void;
}

export interface ContextCapSessionRequest { session?: ContextCapSession }

export const CAP_ENTRY = "piop-context-cap";

export const CONTEXT_CAP_STATUS_KEY = "piop-context-cap";


export type ContextCapEntry = { cap: number | null; source: ContextCapSource; clamp?: number };

export const MIN_CAP = 100_000;

export const MAX_CAP = 50_000_000;

export function capRangeError(cap: number, label = "Context cap") {
  if (!Number.isSafeInteger(cap)) return `${label} must be a whole number of tokens`;

  if (cap < MIN_CAP || cap > MAX_CAP) return `${label} must be from ${MIN_CAP.toLocaleString("en-US")} to ${MAX_CAP.toLocaleString("en-US")} tokens`;
}

const multipliers = { "": 1, k: 1_000, m: 1_000_000 } as const;

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
