import extension from './index.ts?raw';
import type { BundledPlugin } from '../types';

/** The web_search tool, answered by an OpenAI model through the host's ChatGPT sign-in. */
export const webSearch: BundledPlugin = {
  id: 'web-search',
  name: 'Web search',
  extension: { after: 'context-bar', files: [['index.ts', extension]] },
  agentTools: ['web_search'],
};
