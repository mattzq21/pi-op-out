import type { SettingsContribution } from './settings';

/** Core Pi extensions, in load order. A plugin extension loads right after the one it names. */
export type CoreExtension = 'goals' | 'context-bar';

/**
 * How Piop delivers a plugin's slash command.
 * immediate: Pi runs it when it is sent.
 * queued: it waits in the follow-up queue like a message and runs when the conversation reaches it. It never reaches the model.
 */
export type CommandDelivery = 'immediate' | 'queued';

/** A Pi extension that a plugin adds to every agent. Its files install in plugins/<plugin id>/ of the generated extension root; index.ts is the entry. */
export interface PluginExtension {
  after: CoreExtension;
  files: Array<[string, string]>;
}

/** A plugin bundled with the daemon, and what it adds to the daemon when it is enabled. */
export interface BundledPlugin {
  id: string;
  name: string;
  extension?: PluginExtension;
  /** Slash commands the plugin owns, without the slash. */
  commands?: Record<string, CommandDelivery>;
  /** Client requests the plugin's extension answers, with the action each one does, for the disabled error. */
  requests?: Record<string, string>;
  settings?: SettingsContribution<any>;
}
