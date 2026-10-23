import * as records from './settings_records';
import { reported } from './pi_discovery';

/** An argument choice or hint of a command. A hint has an empty value. */
export interface CommandOption { value: string; label: string; description?: string }

/** An extension command as Pi reported it: its name, description and argument options. */
export interface CommandInfo { name: string; description?: string; options?: CommandOption[] }

/**
 * The extension commands that Pi offers on this host, with their descriptions and argument options.
 * Each Pi session reports them when it starts, and the latest report is saved. Chats that have not started Pi use the saved report.
 */

const optionalText = (value: unknown, what: string): string | undefined => {
  if (value !== undefined && typeof value !== 'string') throw new Error(what + ' must be text');
  return value;
};

function option(value: any): CommandOption {
  if (!value || typeof value !== 'object' || typeof value.value !== 'string' || typeof value.label !== 'string') throw new Error('A reported command option must have a value and a label');
  const description = optionalText(value.description, 'A command option description');
  return { value: value.value, label: value.label, ...(description === undefined ? {} : { description }) };
}

function command(value: any): CommandInfo {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name) throw new Error('A reported command must have a name');
  const description = optionalText(value.description, 'A command description');
  if (value.options !== undefined && !Array.isArray(value.options)) throw new Error('Command options must be a list');
  return { name: value.name, ...(description === undefined ? {} : { description }), ...(value.options === undefined ? {} : { options: value.options.map(option) }) };
}

export function parseCommands(value: unknown): CommandInfo[] {
  if (!Array.isArray(value)) throw new Error('Reported commands must be a list');
  return value.map(command);
}

/** The saved commands of this host, or null before Pi first reported them. settingsFile locates the host storage. */
export function savedCommands(settingsFile: string): CommandInfo[] | null {
  const saved = records.commandInventory(settingsFile);
  return saved === null ? null : parseCommands(saved);
}

/** Saves the commands that a Pi session reported. */
export function recordCommands(value: unknown, settingsFile: string): void {
  records.saveCommandInventory(settingsFile, parseCommands(value));
  reported('commands');
}
