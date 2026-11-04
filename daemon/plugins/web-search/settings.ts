import { stringSetting, type SettingsContribution } from '../settings';

export type WebSearchSettings = {
  webSearchModel: string;
};

const defaultModel = () => 'openai/gpt-6.1-sol';

export const webSearchSettings: SettingsContribution<WebSearchSettings> = {
  defaults: () => ({ webSearchModel: defaultModel() }),
  parse: value => ({ webSearchModel: stringSetting(value.webSearchModel, 'webSearchModel', defaultModel) }),
};
