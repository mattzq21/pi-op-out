import index from './index.ts?raw';
import face from './interface.ts?raw';
import reviews from './reviews.ts?raw';
import commands from './commands.ts?raw';
import prompt from './review-prompt.txt?raw';
import { reviewSettings } from './settings';
import type { BundledPlugin } from '../types';

/** Code reviews in linked review conversations, with /review and /rs. */
export const review: BundledPlugin = {
  id: 'review',
  name: 'Code review',
  extension: {
    after: 'goals',
    files: [['interface.ts', face], ['review-prompt.txt', prompt], ['reviews.ts', reviews], ['commands.ts', commands], ['index.ts', index]],
  },
  commands: { review: 'queued', rs: 'queued' },
  requests: { open_review: 'open reviews', review_feedback: 'send review feedback' },
  settings: reviewSettings,
};
