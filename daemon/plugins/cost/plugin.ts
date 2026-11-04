import extension from './index.ts?pi-extension' with { type: 'text' };
import type { BundledPlugin } from '../types';

export const cost: BundledPlugin = {
  id: 'cost',
  name: 'Cost limit',
  extension: { after: 'context-bar', source: extension },
  commands: { cost: 'immediate' },
};
