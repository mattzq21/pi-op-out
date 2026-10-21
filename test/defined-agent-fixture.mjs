import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileAgentFixture } from './compile-defined-agent-fixture.mjs';

const appSettings = createRequire(import.meta.url)('../daemon/resources/session-broker/app-settings.cjs');

export const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export const profile = (name = 'general', extra = {}) => ({ name, model: '', effort: '', path_systemprompt: 'prompt.md', path_agent_prompt: '', tools: ['read'], skills: [], mcpServers: {}, extensions: [], ...extra });

export const readStoredConfig = dir => { const body = appSettings.readText(join(dir, 'config.json'));

  if (body === undefined) throw Object.assign(new Error(`Agent configuration is missing: ${join(dir, 'config.json')}`), { code: 'ENOENT' });

  return JSON.parse(body); };

export const writeStoredConfig = (dir, content) => appSettings.write(join(dir, 'config.json'), content);

export function writeCorruptConfig(dir, content) {
  appSettings.write(join(dir, 'config.json'), '{}');
  const db = new DatabaseSync(join(dir, 'sessions.sqlite'));

  try { db.prepare('UPDATE application_settings SET body=? WHERE name=?').run(Buffer.from(content), 'config.json'); } finally { db.close(); }
}

export const configured = agents => ({ agents: agents, webSearchDefaultApplied: true, sessionToolsDefaultApplied: true, subagentsDefaultApplied: true, workhorseDefaultApplied: true });

export async function agentFixture(t, options = {}) {
  options = { files: {}, effort: 'high', model: { provider: 'test', id: 'default' }, config: configured([profile(), profile('reviewer')]), ...options };
  const dir = await mkdtemp(join(tmpdir(), 'piop-agent-contract-'));
  const home = join(dir, 'home'); await mkdir(home);
  const previous = { ...process.env };

  for (const name of ['PI_DEFINE_AGENTS_RUNTIME_DEFAULTS', 'PI_DEFINE_AGENTS_ACTIVE', 'PIOP_AGENT_DRAFT_STATE', 'PI_DESKTOP_MCP_CONFIG', 'PIOP_STORAGE_DIRECTORY']) delete process.env[name];
  Object.assign(process.env, { HOME: home }, options.env);
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  });

  const file = async (name, content) => { const path = join(dir, name); await mkdir(dirname(path), { recursive: true });

  if (name === 'config.json') writeStoredConfig(dir, content); else await writeFile(path, content);

  return path; };

  await file('prompt.md', 'System instructions');

  if (options.config !== null) await file('config.json', JSON.stringify(options.config));

  for (const [name, content] of Object.entries(options.files)) await file(name, content);

  await compileAgentFixture(dir);

  const handlers = new Map(), commands = new Map(), listeners = new Map(), statuses = new Map();
  const entries = structuredClone(options.entries ?? []), notices = [], messages = [], modelSelections = [];
  const tools = new Map((options.tools ?? ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']).map(name => [name, { name }]));
  let activeTools = [], effort = options.effort;

  const emit = async (name, event = {}) => { let result;

  for (const handler of handlers.get(name) ?? []) { const next = await handler(event, ctx);

  if (next !== undefined) result = next; }

  return result; };

  const pi = {
    registerFlag() {}, getFlag: () => false, getSettings: () => ({}),
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand: (name, command) => commands.set(name, command), registerTool: tool => tools.set(tool.name, tool),
    getCommands: () => [...commands.keys()].map(name => ({ name })), getAllTools: () => [...tools.values()],
    getActiveTools: () => activeTools, setActiveTools: value => { activeTools = value; },
    getThinkingLevel: () => effort,
    setThinkingLevel(value) { effort = value;

    for (const handler of handlers.get('thinking_level_select') ?? []) handler({ level: value }, ctx); },
    async setModel(model) { modelSelections.push(model); ctx.model = model; await emit('model_select', { model });

    return true; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data: JSON.parse(JSON.stringify(data)) }),
    sendMessage: value => { messages.push(value); },
    events: {
      on(name, handler) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set);

      return () => set.delete(handler); },
      emit(name, request) {
        for (const handler of listeners.get(name) ?? []) handler(request);
      },
    },
  };

  const ctx = {
    isIdle: () => true, cwd: dir, model: options.model,
    modelRegistry: { find: (provider, id) => (options.models ?? [{ provider: 'test', id: 'default' }, { provider: 'test', id: 'review/model' }]).find(model => model.provider === provider && model.id === id) },
    sessionManager: { getSessionFile: () => join(dir, 'session'), getSessionId: () => 'session-id', getBranch: () => entries },
    ui: { setStatus: (name, value) => statuses.set(name, value), notify: (message, level) => notices.push({ message, level }) },
    reload: async () => { throw new Error('Unexpected resource reload'); },
  };

  const define = (await import(pathToFileURL(join(dir, 'index.mjs')))).default;
  const defineLocal = () => define(pi);

  let registerFastMode;
  const load = async () => {
    if (options.realMcp) {
      const { installAgentMcp } = await import('./mcp-agent-fixture.mjs');
      await installAgentMcp({ dir, pi, tools, ...options.realMcp });
    }
    const input = options.runtime ?? {};
    const enabledTools = input.enabledTools ?? [...tools.keys()];
    process.env.PIOP_AGENT_RESOURCES = JSON.stringify({
      tools: input.tools ?? { enabledTools, registeredTools: enabledTools },
      skills: input.skills ?? { userInvokedSkills: [], agentInvokedSkills: (options.config?.agents ?? []).flatMap(agent => agent?.skills ?? []) },
    });
    if (!options.realFastMode) return defineLocal();
    const loadFast = async () => {
      if (registerFastMode) registerFastMode();
      else {
        const { installFastMode } = await import('./fast-mode-fixture.mjs');
        registerFastMode = await installFastMode(t, { dir, pi, ctx, models: options.models, catalog: options.realFastMode.catalog, fastModels: options.realFastMode.fastModels });
      }
    };
    if (options.realFastMode.agentFirst) { await defineLocal(); await loadFast(); }
    else { await loadFast(); await defineLocal(); }
  };

  const rpc = async (command, payload) => {
    const request = { command, payload, ctx };
    pi.events.emit('piop:rpc', request);

    if (!request.ready) throw new Error('Agent RPC handler was not registered');

    return request.ready;
  };

  return {
    dir, home, file, pi, ctx, entries, notices, messages, statuses, commands, tools, modelSelections, emit,
    load, start: () => emit('session_start'), input: text => emit('input', { text }),
    reloadExtensions: async () => {
      await emit('session_shutdown');
      handlers.clear(); commands.clear(); listeners.clear(); statuses.clear();
      tools.clear();
      for (const name of options.tools ?? ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']) tools.set(name, { name });
      activeTools = [];
      await load(); await emit('session_start');
    },
    select: name => rpc('select_agent', { agent: name }),
    configure: async value => rpc('configure_agents', { configuration: { revision: (await rpc('get_agent_configuration')).revision, ...value } }),
    configuration: () => rpc('get_agent_configuration'),
    config: async () => readStoredConfig(dir),
    rawConfig: () => appSettings.readText(join(dir, 'config.json')),
    corruptConfig: content => writeCorruptConfig(dir, content),
    readSnapshot: async path => (await import(pathToFileURL(join(dir, 'prompts.mjs')))).readPrompt(path),
    state: () => JSON.parse(process.env.PIOP_AGENT_DRAFT_STATE || 'null')?.state ?? entries.findLast(entry => entry.customType === 'pi-define-agents-state' && entry.data)?.data,
    fastEnabled: () => { const request = {}; pi.events.emit('piop:fast-mode:session', request); return request.session.getEnabled(); },
    capability: () => JSON.parse(Buffer.from(statuses.get('pi-define-agents').slice(5), 'base64url')),
    prompt: async (options = {}) => { await emit('before_agent_start', { systemPromptOptions: options });

    return options; },
  };
}
