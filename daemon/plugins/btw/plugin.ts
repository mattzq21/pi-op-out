import extension from './index.ts?pi-extension' with { type: 'text' };
import type { BundledPlugin } from '../types';

export const btw: BundledPlugin = {
  id: 'btw',
  name: 'Side chats',
  extension: { after: 'session', source: extension },
  commands: { btw: 'immediate' },
};
