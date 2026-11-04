import extension from './index.ts?pi-extension' with { type: 'text' };
import type { BundledPlugin } from '../types';

export const backgroundCompaction: BundledPlugin = {
  id: 'background-compaction',
  name: 'Background compaction',
  extension: { after: 'context-bar', source: extension },
  enabledByDefault: false,
};
