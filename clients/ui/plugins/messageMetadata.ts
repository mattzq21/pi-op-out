import { reviewMessageMetadata } from "./review/messageMetadata";
import type { PluginMessageMetadata } from "./messageMetadataTypes";

const metadata = new Map<string, PluginMessageMetadata>();

for (const contribution of [reviewMessageMetadata]) {
  for (const [customType, value] of Object.entries(contribution)) {
    if (metadata.has(customType)) throw new Error(`Duplicate plugin message metadata: ${customType}`);
    metadata.set(customType, value);
  }
}

export const pluginMessageMetadata = (customType?: string) => customType === undefined ? undefined : metadata.get(customType);
