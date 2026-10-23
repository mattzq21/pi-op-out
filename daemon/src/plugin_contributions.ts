import { CATALOG } from '../plugins/catalog';
import type { BundledPlugin, CoreExtension } from '../plugins/types';

export { CATALOG };
export type { BundledPlugin, CoreExtension };

/** Plugins that run in this daemon. The plugin service sets them when it starts; they change only with a daemon restart. */
let active: ReadonlySet<string> | null = null;

export function activate(ids: readonly string[]): void { active = new Set(ids); }

function loaded(): ReadonlySet<string> {
  if (active === null) throw new Error('Plugins have not started');
  return active;
}

export function enabled(): BundledPlugin[] {
  const ids = loaded();
  return CATALOG.filter(plugin => ids.has(plugin.id));
}

/** The slash command at the start of a message, without the slash. The runtime bridge uses the same rule. */
export function commandName(message: string): string | undefined {
  return /^\/(\S+)/.exec(message)?.[1];
}

function commandOwner(name: string): BundledPlugin | undefined {
  return CATALOG.find(plugin => plugin.commands && Object.hasOwn(plugin.commands, name));
}

function disabledCommand(plugin: BundledPlugin, name: string): string {
  return 'The ' + plugin.name + ' plugin is disabled. Enable it to use /' + name + '.';
}

/** Throws when the message starts with a command of a disabled plugin, so the message does not reach the model as text. */
export function assertCommandAvailable(message: string): void {
  const name = commandName(message);
  const owner = name === undefined ? undefined : commandOwner(name);
  if (owner && !loaded().has(owner.id)) throw new Error(disabledCommand(owner, name!));
}

/** True when the message starts with a command of an enabled plugin that waits in the follow-up queue. */
export function queuedCommand(message: string): boolean {
  const name = commandName(message);
  const owner = name === undefined ? undefined : commandOwner(name);
  return owner !== undefined && loaded().has(owner.id) && owner.commands![name!] === 'queued';
}

/** True when an enabled plugin answers this client request. Throws when the request belongs to a disabled plugin. */
export function pluginRequest(type: string): boolean {
  const owner = CATALOG.find(plugin => plugin.requests && Object.hasOwn(plugin.requests, type));
  if (!owner) return false;
  if (!loaded().has(owner.id)) throw new Error('The ' + owner.name + ' plugin is disabled. Enable it to ' + owner.requests![type] + '.');
  return true;
}

/** Command rules for Pi agents: commands that wait in the follow-up queue, and commands of disabled plugins with the error to show. */
export function commandPolicy(): { queued: string[]; disabled: Record<string, string> } {
  const ids = loaded();
  const queued: string[] = [];
  const disabled: Record<string, string> = {};
  for (const plugin of CATALOG) for (const [name, delivery] of Object.entries(plugin.commands ?? {})) {
    if (!ids.has(plugin.id)) disabled[name] = disabledCommand(plugin, name);
    else if (delivery === 'queued') queued.push(name);
  }
  return { queued, disabled };
}

/** Commands that agent definitions can name on a host: the core commands and those of the plugins enabled there. */
export function agentCommands(core: string[], enabledIds: readonly string[]): string[] {
  const names = new Set(core);
  for (const plugin of CATALOG) if (enabledIds.includes(plugin.id)) for (const name of Object.keys(plugin.commands ?? {})) names.add(name);
  return [...names].sort();
}
