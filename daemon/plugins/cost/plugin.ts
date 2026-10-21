import extension from './index.ts?raw';
import type { BundledPlugin } from '../types';

/** Per-conversation API cost limit and its /cost command. */
export const cost: BundledPlugin = {
  id: 'cost',
  name: 'Cost limit',
  extension: { after: 'context-bar', files: [['index.ts', extension]] },
  commands: { cost: 'immediate' },
};
