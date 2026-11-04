import extension from './index.ts?pi-extension' with { type: 'text' };
import { webSearchSettings } from './settings';
import type { BundledPlugin } from '../types';

export const webSearch: BundledPlugin = {
  id: 'web-search',
  name: 'Web search',
  extension: { after: 'context-bar', source: extension },
  agentTools: ['web_search'],
  settings: webSearchSettings,
};
