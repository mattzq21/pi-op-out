import { agentCommands } from './resources';
import { loadAppSettings } from './settings';
import * as daemon from './daemon';
import type { App } from './app';
import type { PiRuntime } from './pi_runtime';

const ACTIONS = ['list', 'begin', 'poll', 'reply', 'cancel', 'logout', 'create', 'fast_models', 'draft_catalog'];

export async function forOwner(app: App, owner: string, hostId: string | undefined | null, request: any): Promise<any> {
  if (!ACTIONS.includes(request?.action)) throw new Error('Unknown provider authentication operation');
  if (JSON.stringify(request).length > 256 * 1024) throw new Error('Provider authentication request is too large');
  const settings = await loadAppSettings(app);
  const connection = await daemon.connect(app, app.pi, app.broker, settings, hostId ?? 'local');
  if (request.action === 'draft_catalog') {
    const definitions = await connection.request({ type: 'agent_definitions' });
    const catalog = await connection.request({ type: 'provider_auth', owner, request });
    return { config: definitions?.config ?? null, models: catalog?.models ?? null, commands: JSON.parse(agentCommands) };
  }
  return connection.request({ type: 'provider_auth', owner, request });
}

export async function cancelOwner(runtime: PiRuntime, owner: string): Promise<void> {
  for (const connection of runtime.connections.snapshot()) {
    try { await connection.request({ type: 'provider_auth_cancel_owner', owner }); } catch {}
  }
}
