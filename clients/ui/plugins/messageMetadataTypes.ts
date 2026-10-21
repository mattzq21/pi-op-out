import type { ChatMessage } from "../types";

export interface PluginMessageMetadata {
  customRole?: ChatMessage["role"];
  contextInjection?: boolean;
  toolName?: string;
  toolStatus?: ChatMessage["toolStatus"];
  retainContent?: boolean;
}
