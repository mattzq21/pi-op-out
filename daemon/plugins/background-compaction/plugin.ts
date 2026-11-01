import extension from './index.ts?raw';
import type { BundledPlugin } from '../types';

export const backgroundCompaction: BundledPlugin = {
  id: 'background-compaction',
  name: 'Background compaction',
  extension: { after: 'context-bar', files: [['index.ts', extension]] },
  enabledByDefault: false,
};
