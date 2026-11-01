import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Reply = ({ text: string; stall?: string; drop?: true } | { tool: string; arguments?: Record<string, unknown> }) & { tokens?: number };

export async function scriptedModel(home: string, reply: (request: any) => Reply | Promise<Reply>) {
  const requests: any[] = [];
  let calls = 0;
  const server = createServer(async (request: IncomingMessage, response) => {
    let body = '';
    let parsed: any;
    try { for await (const chunk of request) body += chunk; parsed = JSON.parse(body); } catch { response.destroy(); return; }
    requests.push(parsed);
    let answer: Reply;
    try { answer = await reply(parsed); } catch (error: any) { response.writeHead(500).end(error.message); return; }
    if (response.destroyed) return;
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'scripted', object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if ('text' in answer && answer.stall) {
      response.write(chunk({ role: 'assistant', content: answer.text }, null) + chunk({ tool_calls: [{ index: 0, id: 'call_' + ++calls, type: 'function', function: { name: answer.stall, arguments: '{"comm' } }] }, null));
      if (answer.drop) setTimeout(() => response.destroy(), 100);
      return;
    }
    if ('text' in answer && answer.drop) {
      response.write(chunk({ role: 'assistant', content: answer.text }, null));
      setTimeout(() => response.destroy(), 100);
      return;
    }
    if ('text' in answer) response.write(chunk({ role: 'assistant', content: answer.text }, null) + chunk({}, 'stop'));
    else response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + ++calls, type: 'function', function: { name: answer.tool, arguments: JSON.stringify(answer.arguments ?? {}) } }] }, null) + chunk({}, 'tool_calls'));
    if (answer.tokens) response.write('data: ' + JSON.stringify({ id: 'scripted', object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [], usage: { prompt_tokens: answer.tokens, completion_tokens: 0, total_tokens: answer.tokens } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  mkdirSync(join(home, '.piop'), { recursive: true });
  writeFileSync(join(home, '.piop', 'models.json'), JSON.stringify({ providers: { scripted: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'scripted',
    models: [{ id: 'scripted-model', input: ['text', 'image'], contextWindow: 200000, maxTokens: 8192 }, { id: 'scripted-thinker', reasoning: true, contextWindow: 200000, maxTokens: 8192 }],
  } } }));
  return { requests, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
