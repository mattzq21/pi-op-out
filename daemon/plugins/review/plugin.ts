import extension from './index.ts?pi-extension' with { type: 'text' };
import { reviewSettings } from './settings';
import type { BundledPlugin } from '../types';

export const review: BundledPlugin = {
  id: 'review',
  name: 'Review',
  extension: { after: 'session', source: extension },
  commands: { review: 'queued' },
  settings: reviewSettings,
};
