import { createMemo, createSignal, For, Show } from "solid-js";
import { Key } from "@solid-primitives/keyed";
import { CirclePlus, Pencil, Server, Trash2 } from "lucide-solid";
import { mcpServersSchema } from "../lib/agentSchemas";
import type { McpServers } from "../types";
import { IconButton } from "./IconButton";
import { Toggle } from "./Toggle";

export type McpEditorDraft = { text: string; error?: string };

type Servers = Record<string, Record<string, unknown>>;
type Issue = { path: PropertyKey[]; message: string };

/** Fields the form edits. Other fields stay as they are and are edited in the JSON view. */
const FORM_FIELDS = new Set(["type", "command", "args", "url", "enabled"]);
const COMMAND_FIELDS = ["command", "args", "env", "cwd"];
const URL_FIELDS = ["url", "headers", "oauth"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The servers in the draft text, or undefined when the text is not an object of server objects. */
function parseServers(text: string): Servers | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) && Object.values(value).every(isObject) ? value as Servers : undefined;
  } catch { return undefined; }
}

const usesUrl = (server: Record<string, unknown>) => server.url !== undefined && server.type !== "stdio";
const issueText = (issues: Issue[]) => issues.map(issue => issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message).join("; ");

export function McpSettings(props: { value: McpServers; draft?: McpEditorDraft; onDraft: (draft: McpEditorDraft) => void; onChange: (value: McpServers) => void }) {
  const [jsonView, setJsonView] = createSignal(false);
  const text = () => props.draft?.text ?? JSON.stringify(props.value, null, 2);
  const servers = createMemo(() => parseServers(text()));
  const issues = createMemo<Issue[]>(() => {
    const current = servers();
    if (!current) return [];
    const result = mcpServersSchema.safeParse(current);
    return result.success ? [] : result.error.issues;
  });
  const showJson = () => jsonView() || !servers();

  const changeText = (value: string) => {
    try {
      const parsed = mcpServersSchema.parse(JSON.parse(value));
      props.onDraft({ text: value });
      props.onChange(parsed);
    } catch (reason) { props.onDraft({ text: value, error: `MCP configuration: ${reason instanceof Error ? reason.message : String(reason)}` }); }
  };

  const commit = (next: Servers) => {
    const value = JSON.stringify(next, null, 2);
    const result = mcpServersSchema.safeParse(next);
    if (result.success) { props.onDraft({ text: value }); props.onChange(result.data); }
    else props.onDraft({ text: value, error: `MCP configuration: ${issueText(result.error.issues)}` });
  };

  const current = () => servers() ?? {};
  const update = (name: string, server: Record<string, unknown>) => commit({ ...current(), [name]: server });
  const remove = (name: string) => commit(Object.fromEntries(Object.entries(current()).filter(([key]) => key !== name)));
  const rename = (name: string, next: string) => commit(Object.fromEntries(Object.entries(current()).map(([key, server]) => [key === name ? next : key, server])));
  const add = () => {
    let index = 1;
    while (`server${index === 1 ? "" : `-${index}`}` in current()) index += 1;
    commit({ ...current(), [`server${index === 1 ? "" : `-${index}`}`]: { command: "", args: [] } });
  };

  return <section class="agent-mcp-settings">
    <div class="agent-mcp-header">
      <div><h3>MCP servers</h3><p>Connections start on the first message. Servers in pi’s mcp.json files are also available.</p></div>
      <button type="button" class="mcp-view-toggle" aria-label="Edit MCP servers as JSON" aria-pressed={showJson()} disabled={!servers()} onClick={() => setJsonView(!jsonView())}>JSON</button>
    </div>
    <Show when={!showJson()} fallback={<>
      <textarea class="mcp-json" rows={12} spellcheck={false} aria-label="MCP server configuration" aria-invalid={Boolean(props.draft?.error)} value={text()} onInput={event => changeText(event.currentTarget.value)} />
      {props.draft?.error && <small class="mcp-error" role="alert">{props.draft.error}</small>}
    </>}>
      <Show when={Object.keys(current()).length} fallback={<p class="agent-mcp-empty">This agent has no MCP servers.</p>}>
        <div class="mcp-list">
          <Key each={Object.entries(current())} by={([name]) => name}>{entry =>
            <McpServerCard name={entry()[0]} server={entry()[1]} names={Object.keys(current())} issues={issues().filter(issue => issue.path[0] === entry()[0]).map(issue => ({ ...issue, path: issue.path.slice(1) }))}
              onChange={server => update(entry()[0], server)} onRename={next => rename(entry()[0], next)} onRemove={() => remove(entry()[0])} />}
          </Key>
        </div>
      </Show>
      <For each={issues().filter(issue => issue.path.length === 0)}>{issue => <small class="mcp-error" role="alert">{issue.message}</small>}</For>
      <button type="button" class="secondary-button" onClick={add}><CirclePlus size={15} />Add server</button>
    </Show>
  </section>;
}

function McpServerCard(props: { name: string; server: Record<string, unknown>; names: string[]; issues: Issue[]; onChange: (server: Record<string, unknown>) => void; onRename: (name: string) => void; onRemove: () => void }) {
  const [nameError, setNameError] = createSignal<string>();
  const url = () => usesUrl(props.server);
  const set = (fields: Record<string, unknown>) => props.onChange({ ...props.server, ...fields });
  const without = (fields: string[]) => Object.fromEntries(Object.entries(props.server).filter(([key]) => !fields.includes(key) && key !== "type"));
  const extra = () => Object.keys(props.server).filter(key => !FORM_FIELDS.has(key));

  const rename = (input: HTMLInputElement) => {
    const next = input.value.trim();
    if (next === props.name) return setNameError(undefined);
    const error = !/^[a-zA-Z0-9_-]+$/.test(next) ? "Use letters, digits, underscores or hyphens."
      : props.names.some(name => name !== props.name && name.replaceAll("-", "_") === next.replaceAll("-", "_")) ? "Another server uses this name." : undefined;
    setNameError(error);
    if (error) { input.value = props.name; return; }
    props.onRename(next);
  };

  return <div class="mcp-card">
    <div class="mcp-card-head">
      <span class="config-icon mcp"><Server size={14} /></span>
      <label class="mcp-name" data-tooltip="Rename">
        <input aria-label="MCP server name" aria-invalid={Boolean(nameError())} spellcheck={false} value={props.name} onChange={event => rename(event.currentTarget)}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); else if (event.key === "Escape") { event.currentTarget.value = props.name; setNameError(undefined); event.currentTarget.blur(); } }} />
        <Pencil size={12} aria-hidden="true" />
      </label>
      <Toggle label={`Enable ${props.name}`} checked={props.server.enabled !== false} onChange={enabled => set({ enabled })} />
      <IconButton label={`Remove ${props.name}`} onClick={props.onRemove}><Trash2 size={15} /></IconButton>
    </div>
    <div class="mcp-card-body">
      <div class="mcp-transport-toggle" role="group" aria-label={`${props.name} connection`}>
        <button type="button" aria-pressed={!url()} onClick={() => url() && props.onChange({ ...without(URL_FIELDS), command: "", args: [] })}>Command</button>
        <button type="button" aria-pressed={url()} onClick={() => !url() && props.onChange({ ...without(COMMAND_FIELDS), url: "" })}>URL</button>
      </div>
      <Show when={url()} fallback={
        <div class="command-fields stdio-fields">
          <label><span>Command</span><input aria-label={`${props.name} command`} placeholder="npx" value={String(props.server.command ?? "")} onInput={event => set({ command: event.currentTarget.value })} /></label>
          <label><span>Arguments, one per line</span><textarea rows={3} spellcheck={false} aria-label={`${props.name} arguments`} value={Array.isArray(props.server.args) ? props.server.args.join("\n") : ""} onChange={event => set({ args: event.currentTarget.value.split("\n").map(arg => arg.trim()).filter(Boolean) })} /></label>
        </div>}>
        <div class="command-fields stdio-fields">
          <label><span>URL</span><input aria-label={`${props.name} URL`} placeholder="https://example.com/mcp" value={String(props.server.url ?? "")} onInput={event => set({ url: event.currentTarget.value })} /></label>
        </div>
      </Show>
      <Show when={extra().length}><p class="mcp-card-extra">Also set in JSON: {extra().join(", ")}</p></Show>
      <Show when={nameError()}>{error => <small class="mcp-error" role="alert">{error()}</small>}</Show>
      <For each={props.issues}>{issue => <small class="mcp-error" role="alert">{issue.path.length ? `${issue.path.join(".")}: ` : ""}{issue.message}</small>}</For>
    </div>
  </div>;
}
