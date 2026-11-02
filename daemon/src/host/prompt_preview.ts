import { randomUUID } from 'node:crypto';
import { errorText } from '../util/sync';
import { kind, text } from './json';
import { parseLaunchSpec } from './protocol';
import { RuntimeWorker } from './worker';

const TIMEOUT = 120_000;

const running = new Set<RuntimeWorker>();

// Each build starts a new Pi runtime without a saved conversation, selects the agent, and lets it build its
// first model request. The request stops before it reaches the provider, and the runtime stops after it.
export async function previewPrompt(spec: unknown, agent: string, home: string): Promise<unknown> {
  const launch = parseLaunchSpec(spec);
  if (launch.env.PIOP_PROMPT_PREVIEW !== '1' || !launch.args.includes('--no-session')) throw new Error('A prompt preview needs a preview runtime');
  if (!agent.trim()) throw new Error('Choose an agent to preview');
  const notices: string[] = [];
  const output: string[] = [];
  const remember = (line: string) => { if (output.push(line) > 20) output.shift(); };
  const worker = RuntimeWorker.spawn(launch, randomUUID(), TIMEOUT, {
    event: async event => {
      if (kind(event) === 'extension_ui_request' && event.method === 'notify' && ['error', 'warning'].includes(event.notifyType)) notices.push(text(event, 'message'));
    },
    runtimeEvent: async event => { throw new Error('A prompt preview cannot use ' + event.name); },
    response: event => {
      if (event?.success !== true) throw new Error(typeof event?.error === 'string' ? event.error : 'Pi command failed');
      return event.data ?? null;
    },
    stderr: remember,
    diagnostic: remember,
    finished: () => {},
    disconnectError: status => 'Pi stopped before the prompt preview was ready' + (status ? ' (' + status + ')' : '') + (output.length ? ':\n' + output.join('\n') : ''),
  }, home);
  running.add(worker);
  try {
    await worker.request({ type: 'select_agent', agent }, 'select_agent', null);
    const preview = await worker.request({ type: 'prompt_preview' }, 'prompt_preview', null);
    const problems = [...new Set(notices.filter(Boolean))];
    return problems.length ? { ...preview, notices: problems } : preview;
  } catch (error) {
    throw new Error([...new Set(notices.filter(Boolean)), errorText(error)].join('\n'));
  } finally {
    await worker.stop();
    running.delete(worker);
  }
}

export async function stopPromptPreviews(): Promise<void> {
  await Promise.all([...running].map(worker => worker.stop()));
}
