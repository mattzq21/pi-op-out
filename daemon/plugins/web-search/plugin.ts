import extension from './index.ts?raw';
import { webSearchSettings } from './settings';
import type { BundledPlugin } from '../types';

export const webSearch: BundledPlugin = {
  id: 'web-search',
  name: 'Web search',
  extension: { after: 'context-bar', files: [['index.ts', extension]] },
  agentTools: ['web_search'],
  settings: webSearchSettings,
};
