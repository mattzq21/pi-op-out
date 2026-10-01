import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';

export const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export const profile = (name = 'general', extra = {}) => ({ name, model: '', effort: '', path_systemprompt: 'prompt.md', path_agentprompt: '', tools: ['read'], skills: [], mcpServers: [], extensions: [], ...extra });

export const configured = agents => ({ agents: agents, webSearchDefaultApplied: true, sessionToolsDefaultApplied: true, subagentsDefaultApplied: true, diagramistDefaultApplied: true, askerAgentDefaultApplied: true, terminalAgentDefaultApplied: true });

export async function agentFixture(t, options = {}) {
  options = { files: {}, effort: 'high', model: { provider: 'test', id: 'default' }, config: configured([profile(), profile('reviewer')]), ...options };
  const dir = await mkdtemp(join(tmpdir(), 'piop-agent-contract-'));
  const home = join(dir, 'home'); await mkdir(home);
  const previous = { ...process.env };

  for (const name of ['PI_DEFINE_AGENTS_RUNTIME_DEFAULTS', 'PI_DEFINE_AGENTS_ACTIVE', 'PIOP_AGENT_DRAFT_STATE', 'PI_DESKTOP_MCP_CONFIG', 'PIOP_STORAGE_DIRECTORY']) delete process.env[name];
  Object.assign(process.env, options.env);
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  });

  const file = async (name, content) => { const path = join(dir, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);

  return path; };

  await file('prompt.md', 'System instructions');

  if (options.config !== null) await file('config.json', JSON.stringify(options.config));

  for (const [name, content] of Object.entries(options.files)) await file(name, content);

  for (const name of ['index', 'extension-loader', 'mcp-config']) {
    let source = await readFile(new URL(`../extensions/piop-define-agents/${name}.ts`, import.meta.url), 'utf8');
    source = source.replace('./extension-loader.ts', './extension-loader.mjs').replace('./mcp-config.ts', './mcp-config.mjs')
      .replace('import { homedir } from "node:os";', `const homedir = () => ${JSON.stringify(home)};`)
      .replace(/import \{ formatSkillsForPrompt, type BuildSystemPromptOptions \} from "@earendil-works\/pi-coding-agent";/, 'const formatSkillsForPrompt = (skills, tool) => `Skills via ${tool}: ${skills.map(skill => skill.filePath + (skill.disableModelInvocation ? " (explicit)" : "")).join(", ")}`;');

    if (name === 'index' && options.files['fs.mjs']) source = source.replace('from "node:fs/promises"', 'from "./fs.mjs"');
    await file(`${name}.mjs`, (await transform(source, { loader: 'ts', format: 'esm' })).code);
  }

  const handlers = new Map(), commands = new Map(), listeners = new Map(), statuses = new Map();
  const entries = structuredClone(options.entries ?? []), notices = [], modelSelections = [], fastSelections = [];
  const tools = new Map((options.tools ?? ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']).map(name => [name, { name }]));
  let activeTools = [], effort = options.effort;

  const emit = async (name, event = {}) => { let result;

  for (const handler of handlers.get(name) ?? []) { const next = await handler(event, ctx);

  if (next !== undefined) result = next; }

  return result; };

  const pi = {
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
    events: {
      on(name, handler) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set);

      return () => set.delete(handler); },
      emit(name, request) {
        if (name === 'piop:runtime-settings' && options.runtime) request.settings = options.runtime;

        if (name === 'piop:fast-mode') { if (request.apply) fastSelections.push({ enabled: request.enabled, ctx: request.ctx }); else request.models = options.fastModels ?? []; }

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

  return {
    dir, home, file, pi, ctx, entries, notices, statuses, commands, tools, modelSelections, fastSelections, emit,
    load: () => define(pi), start: () => emit('session_start'), input: text => emit('input', { text }),
    select: name => commands.get('pi-define-agents-use').handler(name, ctx),
    configure: value => commands.get('pi-define-agents-config').handler(encoded(value), ctx),
    config: async () => JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')),
    state: () => JSON.parse(process.env.PIOP_AGENT_DRAFT_STATE || 'null')?.state ?? entries.findLast(entry => entry.customType === 'pi-define-agents-state' && entry.data)?.data,
    capability: () => JSON.parse(Buffer.from(statuses.get('pi-define-agents').slice(5), 'base64url')),
    prompt: async (options = {}) => { await emit('before_agent_start', { systemPromptOptions: options });

    return options; },
  };
}
