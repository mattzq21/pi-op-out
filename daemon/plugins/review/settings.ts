import prompt from './review-prompt.txt?raw';
import { stringSetting, type SettingsContribution } from '../settings';

/** Settings → Review: the agent that runs reviews and the prompt it gets. */
export interface ReviewSettings {
  reviewAgent: string;
  reviewPrompt: string;
}

const defaultAgent = () => 'general';
const defaultPrompt = () => prompt.trim();

export const reviewSettings: SettingsContribution<ReviewSettings> = {
  fields: ['reviewAgent', 'reviewPrompt'],
  defaults: () => ({ reviewAgent: defaultAgent(), reviewPrompt: defaultPrompt() }),
  parse: value => ({
    reviewAgent: stringSetting(value.reviewAgent, 'reviewAgent', defaultAgent),
    reviewPrompt: stringSetting(value.reviewPrompt, 'reviewPrompt', defaultPrompt),
  }),
};
