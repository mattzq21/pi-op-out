import type { SettingsContribution } from './settings';

export type CoreExtension = 'session' | 'context-bar';

export type CommandDelivery = 'immediate' | 'immediateWithImages' | 'queued' | 'queuedWithPrompt';

export interface PluginExtension {
  after: CoreExtension;
  files: Array<[string, string]>;
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
