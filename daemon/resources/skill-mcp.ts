import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { skillMcpServerSchema, skillMcpServersSchema } from "../../pi-extensions/piop-define-agents/mcp-schema.ts";
import { subscribeConnections } from "./mcp-connections.ts";
import { leadingCalls, skillPaths } from "./piop-controls/skill-calls.ts";

const ENTRY = "piop-skill-mcp";
const FAILED_ENTRY = "piop-skill-mcp-failed";
const STATUS = "piop-skill-mcp";
export const SKILL_MCP_FAILED = "This skill's embedded MCP failed to load";
const manifestSchema = z.object({ mcpServers: skillMcpServersSchema }).strict();
const savedSchema = z.array(z.object({ file: z.string(), servers: z.array(z.object({ alias: z.string(), name: z.string().regex(/^[a-zA-Z0-9_]+$/), config: skillMcpServerSchema })) }));
type Server = { alias: string; name: string; config: McpServerConfig & { exposure: keyof typeof REACH }; state: "connecting" | "connected"; connection?: object };
type Connection = { name: string; state: string };
const REACH = { direct: "", codemode: " (call from codemode scripts)", deferred: " (find with tool_search)" };
const configSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() });
const namespace = (name: string) => name.replaceAll("-", "_");

// Pi prefers servers from its own mcp.json files over registered ones with the same name. Pi skips invalid files.
function configuredNames(paths: string[]) {
  return paths.flatMap(path => {
    let content: string;
    try { content = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    let parsed;
    try { parsed = configSchema.safeParse(JSON.parse(content.replace(/^\uFEFF/, ""))); } catch { return []; }
    return parsed.success ? Object.keys(parsed.data.mcpServers ?? {}) : [];
  });
}

const SKILL_BLOCK = /<skill name="[^"]+" location="([^"]+)">\n[\s\S]*?\n<\/skill>(?:\n\n|$)/y;

function invokedSkillPaths(prompt: string) {
  const paths: string[] = [];
  for (let at = 0, match; at < prompt.length; at = SKILL_BLOCK.lastIndex) {
    SKILL_BLOCK.lastIndex = at;
    match = SKILL_BLOCK.exec(prompt);
    if (!match) break;
    paths.push(match[1]);
  }
  return paths;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function skillMcp(pi: ExtensionAPI, ready: (ctx: ExtensionContext) => Promise<void>, wait: () => Promise<void>, mcpConfigs: (ctx: ExtensionContext) => string[]) {
  const loaded = new Map<string, Map<string, Server>>();
  const registered = new Set<string>();
  const changed = new Set<() => void>();
  let codemode = true, generation = 0;
  let context: ExtensionContext | undefined;
  let statusText: string | undefined;
  // Skills that start the same server with the same settings share one Server object.
  const all = () => [...new Set([...loaded.values()].flatMap(servers => [...servers.values()]))];
  const used = (server: Server) => [...loaded.values()].some(servers => [...servers.values()].includes(server));
  const publish = () => {
    const users = new Map<Server, string[]>();
    for (const [file, servers] of loaded) for (const server of servers.values()) users.set(server, [...users.get(server) ?? [], basename(dirname(file))]);
    const value = JSON.stringify([...users].map(([server, skills]) => ({ name: server.name, label: `${skills.join(", ")}: ${server.alias}`, state: server.state })));
    if (context && value !== statusText) { context.ui.setStatus(STATUS, value === "[]" ? undefined : value); statusText = value; }
    for (const notify of changed) notify();
  };
  const save = () => pi.appendEntry(ENTRY, [...loaded].map(([file, servers]) => ({ file, servers: [...servers.values()].map(({ alias, name, config }) => ({ alias, name, config })) })));
  const stop = (server: Server) => {
    if (!registered.has(server.name)) return;
    registered.delete(server.name);
    pi.unregisterMcpServer(server.name);
  };
  const report = (file: string) => {
    const skill = basename(dirname(file));
    try { pi.appendEntry(FAILED_ENTRY, { skill }); }
    catch (error) { context?.ui.notify(`The embedded MCP of skill "${skill}" failed to load, and the chat could not save this notice: ${errorText(error)}`, "error"); }
  };
  const drop = (file: string) => {
    const servers = loaded.get(file);
    if (!servers) return;
    loaded.delete(file);
    for (const server of servers.values()) if (!used(server)) stop(server);
    try { save(); }
    catch (error) { context?.ui.notify(`Could not save the skill MCP servers of this chat: ${errorText(error)}`, "error"); }
    publish();
  };
  const fail = (server: Server) => {
    for (const [file] of [...loaded].filter(([, servers]) => [...servers.values()].includes(server))) { drop(file); report(file); }
  };
  const conflict = (server: Pick<Server, "name">, ctx: ExtensionContext) => {
    const key = namespace(server.name);
    const taken = all().some(other => other !== server && namespace(other.name) === key)
      || pi.getMcpServers().some(other => !registered.has(other.name) && namespace(other.name) === key)
      || configuredNames(mcpConfigs(ctx)).some(name => namespace(name) === key);
    return taken ? new Error(`The MCP server name "${server.name}" is already in use in this chat`) : undefined;
  };
  const register = (server: Server, ctx: ExtensionContext) => {
    if (registered.has(server.name)) return;
    server.state = "connecting"; delete server.connection;
    publish();
    if (server.config.exposure === "codemode" && !codemode) return fail(server);
    try {
      const error = conflict(server, ctx);
      if (error) throw error;
      pi.registerMcpServer(server.name, server.config);
      registered.add(server.name);
    } catch { fail(server); }
  };
  const registerAll = (servers: Iterable<Server>, ctx: ExtensionContext) => {
    for (const server of servers) if (used(server)) register(server, ctx);
  };
  const clear = () => {
    generation++;
    context = undefined; statusText = undefined;
    for (const server of all()) stop(server);
    loaded.clear();
    publish();
  };
  const unsubscribe = subscribeConnections((connection: Connection) => {
    const server = all().find(server => server.name === connection.name);
    if (!server || connection.state === "closed" || connection.state === "disconnected") return;
    if (connection.state === "connecting") server.connection = connection;
    if (server.connection && server.connection !== connection) return;
    server.connection = connection;
    if (connection.state === "connected") server.state = "connected";
    else if (connection.state === "connecting") server.state = "connecting";
    else return fail(server);
    publish();
  });

  const settle = async (ctx: ExtensionContext, current = generation) => {
    if (!all().length) return;
    await ready(ctx);
    await wait();
    if (current !== generation) throw new Error("The session changed while loading skill MCP servers");
    if (all().some(server => server.state === "connecting")) await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (current === generation && !ctx.signal?.aborted && all().some(server => server.state === "connecting")) return;
        changed.delete(finish); ctx.signal?.removeEventListener("abort", finish);
        if (current !== generation || ctx.signal?.aborted) reject(new Error("Skill MCP startup was interrupted")); else resolve();
      };
      changed.add(finish); ctx.signal?.addEventListener("abort", finish, { once: true }); finish();
    });
  };

  const start = (file: string, ctx: ExtensionContext): Map<string, Server> | undefined => {
    let content: string;
    try { content = readFileSync(join(dirname(file), "mcp.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const definitions = manifestSchema.parse(JSON.parse(content)).mcpServers;
    const replace = (value: string) => value.replaceAll("${SKILL_DIR}", dirname(file)).replaceAll("${PROJECT_DIR}", ctx.cwd);
    const servers = new Map(Object.entries(definitions).filter(([, config]) => config.enabled !== false).map(([alias, supplied]): [string, Server] => {
      const { piopInjectAgentId, ...rest } = supplied;
      if (piopInjectAgentId) throw new Error("Skill MCP servers do not support piopInjectAgentId");
      const config = JSON.parse(JSON.stringify(rest, (_key, value) => typeof value === "string" ? replace(value) : value)) as Server["config"];
      if ("command" in config && (config.command.startsWith("./") || config.command.startsWith("../"))) config.command = resolve(dirname(file), config.command);
      const server: Server = { alias, name: namespace(alias), config, state: "connecting" };
      const shared = all().find(other => other.name === server.name);
      if (!shared) { const error = conflict(server, ctx); if (error) throw error; return [alias, server]; }
      if (!isDeepStrictEqual(shared.config, server.config)) throw new Error(`The MCP server name "${server.name}" is already in use in this chat with other settings`);
      return [alias, shared];
    }));
    if (!servers.size) return;
    loaded.set(file, servers);
    save();
    registerAll(servers.values(), ctx);
    publish();
    return servers;
  };

  const load = async (path: string, ctx: ExtensionContext): Promise<string | undefined> => {
    const current = generation;
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    if (basename(expanded) !== "SKILL.md") return;
    const file = realpathSync(resolve(ctx.cwd, expanded));
    context = ctx;
    let servers = loaded.get(file);
    if (!servers) {
      try { servers = start(file, ctx); }
      catch { drop(file); report(file); throw new Error(SKILL_MCP_FAILED); }
      if (!servers) return;
    }
    await settle(ctx, current);
    if (loaded.get(file) !== servers) throw new Error(SKILL_MCP_FAILED);
    return `Skill MCP tools: ${[...servers.values()].map(({ alias, name, config }) => `${alias}: mcp__${name}__*${REACH[config.exposure]}`).join(", ")}.`;
  };

  const reject = (event: { text: string }, ctx: ExtensionContext, error: unknown) => {
    const message = errorText(error);
    ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error: message }));
    ctx.ui.notify(message, "error");
    return { action: "handled" as const };
  };

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError || typeof event.input.path !== "string") return;
    try {
      const message = await load(event.input.path, ctx);
      if (message) return { content: [...event.content, { type: "text" as const, text: message }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: errorText(error) }], isError: true };
    }
  });
  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior) return;
    try {
      await settle(ctx);
      const available = skillPaths(pi);
      for (const name of leadingCalls(event.text).names) {
        const path = available.get(name);
        if (path) await load(path, ctx);
      }
    } catch (error) { return reject(event, ctx, error); }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      await settle(ctx);
      if (!("prompt" in event)) return;
      const contents: string[] = [];
      for (const path of invokedSkillPaths(event.prompt)) {
        const content = await load(path, ctx);
        if (content) contents.push(content);
      }
      if (contents.length) return { message: { customType: "skill-mcp", content: contents.join("\n"), display: false } };
    } catch (error) {
      ctx.abort();
      ctx.ui.notify(errorText(error), "error");
    }
  });
  pi.on("session_start", (_event, ctx) => {
    clear(); context = ctx; statusText = undefined;
    const entry = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === ENTRY);
    if (entry?.type === "custom") {
      const saved = savedSchema.parse(entry.data);
      const shared = new Map<string, Server>();
      for (const group of saved) loaded.set(group.file, new Map(group.servers.map(saved => {
        const server = shared.get(saved.name) ?? { ...saved, config: saved.config as Server["config"], state: "connecting" };
        shared.set(server.name, server);
        return [saved.alias, server];
      })));
      registerAll(all(), ctx);
    }
    publish();
  });
  pi.on("session_shutdown", (_event, ctx) => { clear(); ctx.ui.setStatus(STATUS, undefined); unsubscribe(); });

  return {
    select(enabled: boolean) {
      if (codemode === enabled) return;
      codemode = enabled;
      const reach = all().filter(server => server.config.exposure === "codemode");
      for (const server of reach) stop(server);
      if (context) registerAll(reach, context);
    },
  };
}
