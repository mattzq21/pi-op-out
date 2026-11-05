import { agentCommands } from '../resources';
import * as Contributions from '../plugins';
import { localHost } from '../local_host';
import type { App } from '../app';
import { discoverPi } from '../pi';
import { GOAL_COMMAND } from '../host';
import type { PiRuntime } from '../pi';

const ACTIONS = ['list', 'begin', 'poll', 'reply', 'cancel', 'logout', 'create', 'remove', 'fast_models', 'draft_catalog'];

export async function forOwner(app: App, owner: string, request: any): Promise<any> {
  if (!ACTIONS.includes(request?.action)) throw new Error('Unknown provider authentication operation');
  if (JSON.stringify(request).length > 256 * 1024) throw new Error('Provider authentication request is too large');
  const host = localHost(app).host;
  if (request.action === 'draft_catalog') {
    if (request.cwd !== undefined && typeof request.cwd !== 'string') throw new Error('Invalid project directory');
    const definitions = await host.agentDefinitionsFor(request.reload === true, request.cwd || undefined);
    let catalog = await host.providerAuth(owner, { action: 'draft_catalog' });
    if (catalog?.commandDetails === null) {
      try {
        await discoverPi(app);
        catalog = await host.providerAuth(owner, { action: 'draft_catalog' });
      } catch (error) { console.error('Piop could not get the command hints of this host: ' + (error instanceof Error ? error.message : String(error))); }
    }
    const plugins = await host.pluginStatus();
    if (!Array.isArray(plugins?.enabled) || plugins.enabled.some((id: unknown) => typeof id !== 'string')) throw new Error('The host returned an invalid plugin status');
    const commands = Contributions.agentCommands([...JSON.parse(agentCommands), GOAL_COMMAND.name], plugins.enabled);
    const details = new Map([...(catalog?.commandDetails ?? []), GOAL_COMMAND].map((command: any) => [command.name, command]));
    return { config: definitions?.config ?? null, models: catalog?.models ?? null, initialModel: catalog?.initialModel ?? null, initialThinking: catalog?.initialThinking ?? 'medium', commands, commandDetails: commands.flatMap(name => details.has(name) ? [details.get(name)] : []), skills: catalog?.skills ?? null };
  }
  return host.providerAuth(owner, request);
}

export async function cancelOwner(runtime: PiRuntime, owner: string): Promise<void> {
  if (!runtime.host?.alive) return;
  try { await runtime.host.host.cancelProviderAuth(owner); }
  catch (error) { console.error('Could not cancel the sign-in flows of ' + owner + ': ' + (error instanceof Error ? error.message : String(error))); }
}
