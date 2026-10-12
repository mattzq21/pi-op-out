// Proposed contract, not connected to runtime code.

export type FastModelScanResult =
  | Readonly<{
      provider: string;
      status: "ok";
      supportedModelIds: readonly string[];
    }>
  | Readonly<{
      provider: string;
      status: "error";
      message: string;
    }>;

/**
 * Created with access to one host's model runtime and authentication.
 * Owns discovery rules and provider requests, not scheduling or saved results.
 */
export interface FastModelDiscovery {
  /**
   * Omit provider to scan all registered providers that this module supports.
   * Supply provider to scan only that provider, for example after adding it.
   * An unsupported provider produces no result; an unknown provider is an error.
   * Each attempted provider produces one result; model IDs are unique per provider.
   * A successful empty list means no supported models were found.
   * A failed scan returns an error result, never an empty success.
   * Failures that prevent the whole operation reject with an Error.
   * Every call attempts discovery; the host applies the shared refresh limit.
   * The host retains old results for failures within the same account/config
   * context and discards results from a context that changed during the scan.
   */
  scan(provider?: string): Promise<readonly FastModelScanResult[]>;
}
