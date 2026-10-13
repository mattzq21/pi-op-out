// Proposed consumer interface. Not implemented or connected to Pi yet.

export type ContextCapSource = "manual" | "config" | "agent_definition";

/** Complete defaults for the current agent and provider/model pair. */
export type ContextCapDefaults = Readonly<{
  /** undefined inherits; null selects the model default and stops fallback. */
  agentDefinition: number | null | undefined;
  modelConfig: number | null | undefined;
  generalConfig: number | null | undefined;
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
   * Numeric values are whole safe integers from 100000 through 50000000.
   * New numeric choices must fit the current model window and exceed Pi's
   * reserve plus recent-history budgets. A numeric choice requires a model.
   * Validate on receipt and again at idle before saving and applying.
   */
  setManualCap(cap: number | null): Promise<ContextCapState>;

  /**
   * Implement /cap reset: resolve agent definition, model config, general
   * config, then model default. Validate the resolved choice before applying.
   */
  resetManualCap(): Promise<ContextCapState>;

  /**
   * Replace defaults supplied by the session broker after settings, agent, or
   * model changes. Preserve any manual override. Otherwise resolve in priority
   * order and validate, save, apply, and publish effective changes at idle.
   * Numeric defaults follow the same validation rules as manual choices.
   */
  updateDefaults(defaults: ContextCapDefaults): Promise<ContextCapState>;

  /**
   * Receive initial state and subsequent effective cap/source/window changes.
   * Report initialization and background failures through onError.
   * Returns unsubscribe; listeners must not throw.
   */
  subscribe(
    listener: (state: ContextCapState) => void,
    onError: (error: Error) => void,
  ): () => void;
}

// Change operations complete after saving and applying at idle, before queued
// follow-ups or goals start. Failures reject and retain the previous choice.
// All change operations share one session queue in extension receipt order,
// independent of client timestamps. Apply each in order; do not collapse changes.
// Resolve reset against defaults from earlier successful queue operations.
// A rejected operation leaves state unchanged; continue with later operations.
// Deferred operations belong to this session; shutdown rejects unfinished work.
// Every effective change is appended to the session log before publication.
// Existing manual choices survive model changes; clamp appliedWindow only.
// /cap text parsing and Pi hooks are integration details outside this interface.
// The complete log schema remains open.
