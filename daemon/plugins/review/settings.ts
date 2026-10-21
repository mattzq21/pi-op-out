import { stringSetting, type SettingsContribution } from '../settings';

/** The agent that runs /review, chosen in Settings → Agents. */
export interface ReviewSettings {
  reviewAgent: string;
}

const defaultAgent = () => 'general';

export const reviewSettings: SettingsContribution<ReviewSettings> = {
  fields: ['reviewAgent'],
  defaults: () => ({ reviewAgent: defaultAgent() }),
  parse: value => ({ reviewAgent: stringSetting(value.reviewAgent, 'reviewAgent', defaultAgent) }),
};
