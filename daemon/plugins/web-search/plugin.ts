import extension from './index.ts?raw';
import face from './interface.ts?raw';
import openai from './openai.ts?raw';
import anthropic from './anthropic.ts?raw';
import { webSearchSettings } from './settings';
import type { BundledPlugin } from '../types';

export const webSearch: BundledPlugin = {
  id: 'web-search',
  name: 'Web search',
  extension: { after: 'context-bar', files: [['interface.ts', face], ['openai.ts', openai], ['anthropic.ts', anthropic], ['index.ts', extension]] },
  agentTools: ['web_search'],
  settings: webSearchSettings,
};
