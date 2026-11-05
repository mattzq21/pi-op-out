import { commandInventoryJson, saveCommandInventoryJson } from '../../resources/session-database/index.ts';
import { reported } from '../pi';

export interface CommandOption { value: string; label: string; description?: string }

export interface CommandInfo { name: string; description?: string; options?: CommandOption[] }

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

// The commands that Pi last reported in the storage root, or null before the first report.
export function savedCommands(root: string): CommandInfo[] | null {
  const entries = commandInventoryJson(root);
  return entries === undefined ? null : parseCommands(JSON.parse(entries));
}

export function recordCommands(value: unknown, root: string): void {
  const entries = JSON.stringify(parseCommands(value));
  saveCommandInventoryJson(root, entries);
  reported('commands');
}
