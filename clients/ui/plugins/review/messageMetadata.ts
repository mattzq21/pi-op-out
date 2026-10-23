import type { PluginMessageMetadata } from "../messageMetadataTypes";

export const reviewMessageMetadata: Readonly<Record<string, PluginMessageMetadata>> = {
  "piop-review-link": { customRole: "system", contextInjection: false },
  "piop-review-feedback": { customRole: "tool", toolName: "review_feedback", toolStatus: "done", retainContent: true },
};
