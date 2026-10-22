import { agentCommands } from './resources';
import * as Contributions from './plugin_contributions';
import { loadAppSettings } from './settings';
import * as daemon from './daemon';
import type { App } from './app';
import { discoverPi } from './pi_discovery';
import type { PiRuntime } from './pi_runtime';

const ACTIONS = ['list', 'begin', 'poll', 'reply', 'cancel', 'logout', 'create', 'fast_models', 'draft_catalog'];

export async function forOwner(app: App, owner: string, hostId: string | undefined | null, request: any): Promise<any> {
  if (!ACTIONS.includes(request?.action)) throw new Error('Unknown provider authentication operation');
  if (JSON.stringify(request).length > 256 * 1024) throw new Error('Provider authentication request is too large');
  const settings = await loadAppSettings(app);
  const connection = await daemon.connect(app, app.pi, app.broker, settings, hostId ?? 'local');
  if (request.action === 'draft_catalog') {
    const definitions = await connection.request({ type: 'agent_definitions', reload: request.reload === true });
    let catalog = await connection.request({ type: 'provider_auth', owner, request: { action: 'draft_catalog' } });
    // A host where Pi never ran has no saved command hints. A short Pi run reports them.
    if (catalog?.commandDetails === null) {
      try {
        await discoverPi(app);
        catalog = await connection.request({ type: 'provider_auth', owner, request: { action: 'draft_catalog' } });
      } catch (error) { console.error('Piop could not get the command hints of this host: ' + (error instanceof Error ? error.message : String(error))); }
    }
    // Plugin commands depend on the plugins that run on the target host.
    const plugins = await connection.request({ type: 'plugin_status' });
    if (!Array.isArray(plugins?.enabled) || plugins.enabled.some((id: unknown) => typeof id !== 'string')) throw new Error('The host returned an invalid plugin status');
    const commands = Contributions.agentCommands(JSON.parse(agentCommands), plugins.enabled);
    const details = new Map((catalog?.commandDetails ?? []).map((command: any) => [command.name, command]));
    return { config: definitions?.config ?? null, models: catalog?.models ?? null, initialModel: catalog?.initialModel ?? null, initialThinking: catalog?.initialThinking ?? 'medium', commands, commandDetails: commands.flatMap(name => details.has(name) ? [details.get(name)] : []) };
  }
  return connection.request({ type: 'provider_auth', owner, request });
}

export async function cancelOwner(runtime: PiRuntime, owner: string): Promise<void> {
  for (const connection of runtime.connections.snapshot()) {
    try { await connection.request({ type: 'provider_auth_cancel_owner', owner }); } catch {}
  }
}
