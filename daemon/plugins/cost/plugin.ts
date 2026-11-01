import extension from './index.ts?raw';
import type { BundledPlugin } from '../types';

export const cost: BundledPlugin = {
  id: 'cost',
  name: 'Cost limit',
  extension: { after: 'context-bar', files: [['index.ts', extension]] },
  commands: { cost: 'immediate' },
};
