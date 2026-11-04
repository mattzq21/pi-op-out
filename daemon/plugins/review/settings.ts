import { stringSetting, type SettingsContribution } from '../settings';

export type ReviewSettings = {
  reviewAgent: string;
};

const defaultAgent = () => 'reviewer';

export const reviewSettings: SettingsContribution<ReviewSettings> = {
  defaults: () => ({ reviewAgent: defaultAgent() }),
  parse: value => ({ reviewAgent: stringSetting(value.reviewAgent, 'reviewAgent', defaultAgent) }),
};
