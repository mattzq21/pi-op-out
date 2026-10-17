import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One model reply: plain text, or a call of one tool. */
export type Reply = { text: string } | { tool: string; arguments?: Record<string, unknown> };

/**
 * An OpenAI-compatible model server that answers with scripted replies, registered for Pi as provider "scripted"
 * in the daemon's agent folder (~/.piop/models.json). reply() decides each answer from the request it gets.
 */
export async function scriptedModel(home: string, reply: (request: any) => Reply) {
  const requests: any[] = [];
  let calls = 0;
  const server = createServer(async (request: IncomingMessage, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    let answer: Reply;
    try { answer = reply(parsed); } catch (error: any) { response.writeHead(500).end(error.message); return; }
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'scripted', object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if ('text' in answer) response.write(chunk({ role: 'assistant', content: answer.text }, null) + chunk({}, 'stop'));
    else response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + ++calls, type: 'function', function: { name: answer.tool, arguments: JSON.stringify(answer.arguments ?? {}) } }] }, null) + chunk({}, 'tool_calls'));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  mkdirSync(join(home, '.piop'), { recursive: true });
  writeFileSync(join(home, '.piop', 'models.json'), JSON.stringify({ providers: { scripted: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'scripted',
    models: [{ id: 'scripted-model', contextWindow: 200000, maxTokens: 8192 }],
  } } }));
  return { requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
