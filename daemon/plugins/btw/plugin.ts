import index from './index.ts?raw';
import type { BundledPlugin } from '../types';

/** /btw: side chats that copy the chat's history and open in the side pane. */
export const btw: BundledPlugin = {
  id: 'btw',
  name: 'Side chats',
  extension: { after: 'session', files: [['index.ts', index]] },
  commands: { btw: 'immediate' },
};
