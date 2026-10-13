/** Tool names from Piop settings. Pi and extensions implement and register the tools; agent definitions select them by name. */
export type ToolLists = Readonly<{
  /** Tools the user allows. A session may use only these, plus tools from agent extensions, MCP servers and required tools. */
  enabledTools: readonly string[];
  /** Every tool name in Piop settings, enabled or not. */
  registeredTools: readonly string[];
}>;

/** One store per Pi process. Every enabled tool is also registered. */
export interface ToolStore {
  lists(): ToolLists;
  /** Replaces both lists. Throws and keeps the old lists when value is invalid. Returns true when the lists changed. */
  replace(value: unknown): boolean;
}

/** Other extensions emit this request on "piop:tool-store" to get the store. */
export interface ToolStoreRequest { store?: ToolStore }

declare module "@earendil-works/pi-coding-agent" {
  interface EventBus {
    on(channel: "piop:tool-store", handler: (request: ToolStoreRequest) => void): () => void;
    emit(channel: "piop:tool-store", request: ToolStoreRequest): void;
  }
}
