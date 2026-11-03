import index from './index.ts?raw';
import type { BundledPlugin } from '../types';

export const btw: BundledPlugin = {
  id: 'btw',
  name: 'Side chats',
  extension: { after: 'session', files: [['index.ts', index]] },
  commands: { btw: 'queuedWithPrompt' },
};
