import { startDaemon } from './harness';
import { scriptedModel, type Reply } from './scripted-model';

/** The text of a model request message, whatever its content form. */
export function text(message: any): string {
  if (!message) return '';
  return typeof message.content === 'string' ? message.content : (message.content ?? []).map((part: any) => part.text ?? '').join('');
}

/** True when an agent already called tool in this conversation. */
export const called = (messages: any[], tool: string) => messages.some(message => message.role === 'assistant' && message.tool_calls?.some((call: any) => call.function.name === tool));

/**
 * A real daemon whose agents use a scripted model. Each agent follows the script whose key is in its first message
 * (a child or a messaged chat gets its task as a delivered message).
 */
export async function agentDaemon() {
  const daemon = await startDaemon();
  const scripts = new Map<string, (messages: any[]) => Reply | Promise<Reply>>();
  const model = await scriptedModel(daemon.home, request => {
    const first = text(request.messages.find((message: any) => message.role !== 'system' && text(message)));
    const script = [...scripts].find(([start]) => first.includes(start))?.[1];
    if (!script) throw new Error('No script for an agent that started with: ' + first.slice(0, 200));
    return script(request.messages);
  });
  let runtimes = 0;

  /** A new root chat that uses the scripted model. */
  const rootChat = async () => {
    const chat = await daemon.invoke('create_temporary_chat', { hostId: 'local' });
    const runtimeId = 'root-' + ++runtimes;
    await daemon.invoke('start_pi', { runtimeId, clientId: 'laptop', cwd: chat.cwd, sessionId: chat.sessionId });
    const command = (value: any) => daemon.invoke('pi_command', { runtimeId, command: value });
    await command({ type: 'set_model', provider: 'scripted', modelId: 'scripted-model' });
    const history = async () => (await command({ type: 'get_entries' })).entries.filter((entry: any) => entry.type === 'message').map((entry: any) => entry.message);
    /** Waits until the chat's history satisfies check. */
    const until = async (check: (messages: any[]) => boolean) => {
      for (const deadline = Date.now() + 60000; Date.now() < deadline; await Bun.sleep(100)) { const messages = await history(); if (check(messages)) return messages; }
      throw new Error('Chat never reached the expected state: ' + JSON.stringify(await history()).slice(-2000));
    };
    return { ...chat, runtimeId, command, history, until };
  };

  return { daemon, model, scripts, rootChat, close: async () => { await model.close(); await daemon.stop(); } };
}
