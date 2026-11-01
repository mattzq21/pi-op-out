import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, type Client } from './harness';
import { scriptedModel, type Reply } from './scripted-model';

/** The text of a model request message, whatever its content form. */
export function text(message: any): string {
  if (!message) return '';
  return typeof message.content === 'string' ? message.content : (message.content ?? []).map((part: any) => part.text ?? '').join('');
}

/** True when an agent already called tool in this conversation. */
export const called = (messages: any[], tool: string) => messages.some(message => message.role === 'assistant' && message.tool_calls?.some((call: any) => call.function.name === tool));

/** Makes path a Git repository with one commit and its own author, and returns it. */
export function gitRepository(path: string): string {
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' });
  mkdirSync(path, { recursive: true });
  git('init', '--quiet');
  git('config', 'user.name', 'Piop Test');
  git('config', 'user.email', 'piop@example.com');
  writeFileSync(join(path, 'README.md'), 'start\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'initial');
  return path;
}

/** The host's agent definitions, as the settings page reads them. */
export async function agentDefinitions(daemon: Client): Promise<any> {
  return (await daemon.invoke('provider_auth', { hostId: 'local', request: { action: 'draft_catalog' } })).config;
}

/** Saves the agent profiles that change makes from the saved ones, as Settings → Agents does. */
export async function saveAgentDefinitions(daemon: Client, change: (agents: any[]) => any[]): Promise<any> {
  const configuration = await agentDefinitions(daemon);
  return daemon.invoke('save_agent_definitions', { hostId: 'local', configuration: { revision: configuration.revision, agents: change(configuration.agents) } });
}

/**
 * A real daemon whose agents use a scripted model. Each agent follows the script whose key is in its first message
 * (a child or a messaged chat gets its task as a delivered message).
 */
export async function agentDaemon() {
  const daemon = await startDaemon();
  const scripts = new Map<string, (messages: any[]) => Reply | Promise<Reply>>();
  const model = await scriptedModel(daemon.home, request => {
    const first = text(request.messages.find((message: any) => !['system', 'developer'].includes(message.role) && text(message)));
    const script = [...scripts].find(([start]) => first.includes(start))?.[1];
    if (!script) throw new Error('No script for an agent that started with: ' + first.slice(0, 200));
    return script(request.messages);
  });
  let runtimes = 0;

  /**
   * A new root chat that uses the scripted model. visible opens it in a shown, focused window, which receives its dialogs.
   * repository starts it in a new Git repository with one commit, as branching needs.
   */
  const rootChat = async ({ visible = false, repository = false, subfolder = '' } = {}) => {
    const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    const runtimeId = 'root-' + ++runtimes;
    const projectRoot = repository ? gitRepository(join(daemon.home, 'repository-' + runtimeId)) : chat.cwd;
    const cwd = join(projectRoot, subfolder);
    mkdirSync(cwd, { recursive: true });
    await daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd, sessionId: chat.sessionId, ...(visible ? { presence: { visible: true, focused: true } } : {}) });
    const command = (value: any) => daemon.invoke('pi_command', { runtimeId, command: value });
    await command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    const history = async () => (await command({ type: 'get_entries' })).entries.filter((entry: any) => entry.type === 'message').map((entry: any) => entry.message);
    /** Waits until the chat's history satisfies check. */
    const until = async (check: (messages: any[]) => boolean) => {
      for (const deadline = Date.now() + 60000; Date.now() < deadline; await Bun.sleep(100)) { const messages = await history(); if (check(messages)) return messages; }
      throw new Error('Chat never reached the expected state: ' + JSON.stringify(await history()).slice(-2000));
    };
    return { ...chat, cwd, runtimeId, command, history, until };
  };

  /** Saves the agent profiles that change makes from the saved ones, as Settings → Agents does. Only chats started afterwards use them. */
  const saveAgents = (change: (agents: any[]) => any[]) => saveAgentDefinitions(daemon, change);

  /** Adds tools to every agent profile, as Settings → Agents → Tools does. Only chats started afterwards use them. */
  const enableAgentTools = (...tools: string[]) => saveAgents(agents => agents.map(agent => ({ ...agent, tools: [...new Set([...(agent.tools ?? []), ...tools])] })));

  return { daemon, model, scripts, rootChat, saveAgents, enableAgentTools, close: async () => { await model.close(); await daemon.dispose(); } };
}
