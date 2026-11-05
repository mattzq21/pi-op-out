import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, directory, bridge, storage] = process.argv.slice(2);
const sdk = name => import(pathToFileURL(join(root, `dist/core/${name}.js`)));
const { createAgentSession } = await sdk('sdk');
const { DefaultResourceLoader } = await sdk('resource-loader');
const { SettingsManager } = await sdk('settings-manager');
const { SessionManager } = await sdk('session-manager');
const { ModelRuntime } = await sdk('model-runtime');
const { createCodemodeExtension } = await import(pathToFileURL(join(root, 'dist/extensions/codemode/index.js')));
const { installSessionStorage, localTranscriptWrites } = await import(pathToFileURL(storage));
installSessionStorage(SessionManager, localTranscriptWrites());
const { installConnectionEvents, subscribeConnections } = await import('../../daemon/resources/mcp-connections.cjs');
const { McpServerConnection } = await import(pathToFileURL(join(root, 'dist/extensions/mcp/runtime.js')));
installConnectionEvents(McpServerConnection);
const { default: extension } = await import(pathToFileURL(bridge));
let api;
const capture = pi => { api = pi; };
const statuses = new Map(), errors = [], notices = [];
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
await modelRuntime.setRuntimeApiKey('openai', 'test-key-not-a-credential');
const model = modelRuntime.getModels().find(model => model.provider === 'openai');
const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: false, additionalSkillPaths: [join(directory, 'skill')], noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [createCodemodeExtension({ models: false }), extension, capture] });
await resourceLoader.reload();
if (resourceLoader.getExtensions().errors.length) throw new Error(JSON.stringify(resourceLoader.getExtensions().errors));
const file = readFileSync(join(directory, 'session-path'), 'utf8');
const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model, resourceLoader, settingsManager, sessionManager: SessionManager.open(file), tools: ['read', 'codemode', 'mcp__*'] });
await session.bindExtensions({ onError: error => errors.push(error), uiContext: { setStatus: (key, value) => { statuses.set(key, value); process.send?.({ event: 'status', key, value }); }, notify: (...args) => notices.push(args) } });
let requests = 0, mode = 'text', stage = 0, toolResults = [], watched;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
session.subscribe(event => { if (event.type === 'tool_execution_end') toolResults.push({ name: event.toolName, result: event.result, isError: event.isError }); });
session.agent.streamFunction = (model, _context, options) => {
  if (!options.signal?.aborted) requests++;
  let content = [{ type: 'text', text: 'done' }], stopReason = 'stop';
  if (!options.signal?.aborted && stage++ === 0 && mode !== 'text') {
    const name = mode === 'read' ? 'read' : session.getAllTools().find(tool => tool.name.endsWith('__ping') && tool.exposure !== 'hidden')?.name;
    if (!name) throw new Error('MCP ping tool is unavailable');
    const direct = mode === 'read' || session.getAllTools().find(tool => tool.name === name)?.exposure === 'direct';
    content = [{ type: 'toolCall', id: `call-${requests}`, name: direct ? name : 'codemode', arguments: mode === 'read' ? { path: join(directory, 'skill/SKILL.md') } : direct ? {} : { code: `text(await tools.${name}({}));` } }]; stopReason = 'toolUse';
  }
  const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, usage, stopReason: options.signal?.aborted ? 'aborted' : stopReason };
  return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
};
const snapshot = () => ({ requests, statuses: Object.fromEntries(statuses), errors, notices, toolResults, servers: api.getMcpServers().map(server => server.name), activeTools: session.getActiveToolNames(), streaming: session.isStreaming, followUps: session.getFollowUpMessages(), leaf: session.sessionManager.getLeafId(), entries: session.sessionManager.getEntries(), failures: session.sessionManager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'piop-skill-mcp-failed').map(entry => entry.data.skill) });
process.on('message', async command => {
  try {
    let result;
    if (command.op === 'prompt') { mode = command.mode ?? 'text'; stage = 0; toolResults = []; await session.prompt(command.text ?? 'test'); result = snapshot(); }
    else if (command.op === 'watch') { watched = new Promise(resolve => { const stop = subscribeConnections(connection => { if (connection.state === command.state) { stop(); resolve(); } }); }); result = snapshot(); }
    else if (command.op === 'watched') { await watched; result = snapshot(); }
    else if (command.op === 'queue') { await session.prompt(command.text, { streamingBehavior: 'followUp' }); result = snapshot(); }
    else if (command.op === 'snapshot') result = snapshot();
    else if (command.op === 'reload') { await session.reload(); result = snapshot(); }
    else if (command.op === 'branch') { await session.navigateTree(command.leaf); result = snapshot(); }
    else if (command.op === 'codemode') { const request = { servers: {}, sessionId: session.sessionManager.getSessionId(), codemode: command.value }; api.events.emit('piop:mcp:select', request); await request.registered; result = snapshot(); }
    else if (command.op === 'stop') { session.dispose(); process.send?.({ id: command.id, result: snapshot() }); process.disconnect(); return; }
    else throw new Error('Unknown test command');
    process.send?.({ id: command.id, result });
  } catch (error) { process.send?.({ id: command.id, error: String(error?.stack ?? error), snapshot: snapshot() }); }
});
process.send?.({ event: 'ready', ...snapshot() });
