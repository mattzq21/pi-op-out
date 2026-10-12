// Proposed contract. Not connected to the running extension yet.

export type FastModeModel = Readonly<{
  provider: string;
  id: string;
}>;

export type FastModeState = Readonly<{
  /** The session's saved choice, including when its model is unsupported. */
  enabled: boolean;
  /** Whether Pi's current model supports fast mode; false if no model is selected. */
  supported: boolean;
  /** enabled && supported. */
  active: boolean;
}>;

/**
 * Available without a session. Bound to a host and its applicable provider,
 * account, and config context; never a single global list across hosts.
 * Models are unique by (provider, id). Returned lists are immutable snapshots.
 * Discovery and refresh failures reject with an Error, not an empty success.
 * Subscribe receives the initial list once ready, then changed lists only.
 * Subscription failures go to onError; they do not publish an empty list.
 * Updates follow relevant source changes; refresh supports an explicit retry.
 * Unsubscribe prevents further callbacks. Callbacks must not throw.
 */
export interface FastModeModels {
  getModels(): Promise<readonly FastModeModel[]>;
  refresh(): Promise<readonly FastModeModel[]>;
  subscribe(
    listener: (models: readonly FastModeModel[]) => void,
    onError: (error: Error) => void,
  ): () => void;
}

/**
 * Bound to one session. Pi owns the current model.
 * Owns saving and restoring enabled and changing provider requests.
 * Uses FastModeModels for model support and Pi for the current model.
 * Returned state is an immutable snapshot. Callers cannot change internal state.
 * Reads and writes wait for session initialization and run in call order.
 * A failed operation rejects with an Error; it does not report success.
 * When the session ends, operations reject and subscriptions are removed.
 */
export interface FastModeSession {
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
   * Initialization and background failures go to onError.
   */
  subscribe(
    listener: (state: FastModeState) => void,
    onError: (error: Error) => void,
  ): () => void;
}
