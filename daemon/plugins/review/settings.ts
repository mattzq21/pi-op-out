import { stringSetting, type SettingsContribution } from '../settings';

export interface ReviewSettings {
  reviewAgent: string;
}

const defaultAgent = () => 'reviewer';

export const reviewSettings: SettingsContribution<ReviewSettings> = {
  fields: ['reviewAgent'],
  defaults: () => ({ reviewAgent: defaultAgent() }),
  parse: value => ({ reviewAgent: stringSetting(value.reviewAgent, 'reviewAgent', defaultAgent) }),
};
