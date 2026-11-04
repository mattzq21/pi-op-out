import type { SettingsContribution } from './settings';

export type CoreExtension = 'session' | 'context-bar';

export type CommandDelivery = 'immediate' | 'queued';

export interface PluginExtension {
  after: CoreExtension;
  // The plugin's Pi extension, built into one file.
  source: string;
}

export interface BundledPlugin {
  id: string;
  name: string;
  extension?: PluginExtension;
  commands?: Record<string, CommandDelivery>;
  requests?: Record<string, string>;
  settings?: SettingsContribution<any>;
  agentTools?: string[];
  enabledByDefault?: boolean;
}
