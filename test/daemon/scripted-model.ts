import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One model reply: plain text, or a call of one tool. tokens is the input token count the model reports for it.
 * stall sends the text, then starts a call of tool stall and never finishes the response. drop cuts the connection after
 * the text, or after the started tool call, as a network failure does.
 */
export type Reply = ({ text: string; stall?: string; drop?: true } | { tool: string; arguments?: Record<string, unknown> }) & { tokens?: number };

/**
 * An OpenAI-compatible model server that answers with scripted replies, registered for Pi as provider "scripted"
 * in the daemon's agent folder (~/.piop/models.json). reply() decides each answer from the request it gets; a promise
 * keeps the agent busy until it settles. Model scripted-model has no thinking; scripted-thinker has thinking levels,
 * and its requests carry the chosen level as reasoning_effort.
 */
export async function scriptedModel(home: string, reply: (request: any) => Reply | Promise<Reply>) {
  const requests: any[] = [];
  let calls = 0;
  const server = createServer(async (request: IncomingMessage, response) => {
    let body = '';
    let parsed: any;
    // A request cut off by a stopped agent has no complete body and gets no answer.
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
    models: [{ id: 'scripted-model', contextWindow: 200000, maxTokens: 8192 }, { id: 'scripted-thinker', reasoning: true, contextWindow: 200000, maxTokens: 8192 }],
  } } }));
  // Open requests (a script that never answers) would hold the close forever.
  return { requests, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
