// Proposed contract. Not connected to the running extension yet.

export type FastModeModel = Readonly<{
  provider: string;
  id: string;
}>;

export type FastModeState = Readonly<{
  /** The session's saved choice, including when its model is unsupported. */
  enabled: boolean;
  /** enabled && supportedModels contains Pi's current model. */
  active: boolean;
  /** Unique by the pair (provider, id). */
  supportedModels: readonly FastModeModel[];
}>;

/**
 * Bound to one session. Pi owns the current model.
 * Fast mode owns saving and restoring enabled, model discovery, and request changes.
 * Returned state is an immutable snapshot. Callers cannot change internal state.
 * Reads and writes wait for session initialization and run in call order.
 * A failed operation rejects with an Error; it does not report success.
 * When the session ends, operations reject and subscriptions are removed.
 */
export interface FastMode {
  /** Return the latest state after earlier writes finish. */
  getState(): Promise<FastModeState>;

  /**
   * Save the choice before publishing the resulting state.
   * An unchanged choice does not cause another save or notification.
   * An unsupported current model does not prevent saving the choice.
   * A failed save leaves the choice unchanged.
   */
  setEnabled(enabled: boolean): Promise<FastModeState>;

  /**
   * Receive the initial state once ready, then each changed state in order.
   * Changes include Pi model changes and supported-model changes.
   * No callback runs after unsubscribe returns. Listeners must not throw.
   * Background failures are reported through Pi's error display or log.
   */
  subscribe(listener: (state: FastModeState) => void): () => void;
}
