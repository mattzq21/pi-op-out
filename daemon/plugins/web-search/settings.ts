import { stringSetting, type SettingsContribution } from '../settings';

/** The OpenAI model that answers web_search, chosen in Settings → Plugins → Web search. */
export interface WebSearchSettings {
  webSearchModel: string;
}

const defaultModel = () => 'gpt-6.1-sol';

export const webSearchSettings: SettingsContribution<WebSearchSettings> = {
  fields: ['webSearchModel'],
  defaults: () => ({ webSearchModel: defaultModel() }),
  parse: value => ({ webSearchModel: stringSetting(value.webSearchModel, 'webSearchModel', defaultModel) }),
};
