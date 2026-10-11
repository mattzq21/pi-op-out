import { STORAGE_DIRECTORY } from './config';
import type { CommandSpec } from './process_io';

export function nodeCommand(args: string[], extra: Partial<CommandSpec> = {}): CommandSpec {
  return { program: process.execPath, args, ...extra, env: { PIOP_STORAGE_DIRECTORY: STORAGE_DIRECTORY, ...(extra.env ?? {}) } };
}
