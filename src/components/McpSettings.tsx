import { createEffect, createSignal, onCleanup } from "solid-js";
import { mcpServersSchema } from "../lib/agentSchemas";
import type { McpServers } from "../types";

export function McpSettings(props: { agentName: string; value: McpServers; onChange: (value: McpServers) => void; onError: (error: string | undefined) => void }) {
  const [text, setText] = createSignal("");
  const [error, setError] = createSignal<string>();
  let lastValue = "";
  let lastAgent = "";
  const report = (message: string | undefined) => { setError(message); props.onError(message); };

  createEffect(() => {
    const value = JSON.stringify(props.value);

    if (value === lastValue && props.agentName === lastAgent) return;
    lastValue = value; lastAgent = props.agentName;
    setText(JSON.stringify(props.value, null, 2)); report(undefined);
  });
  onCleanup(() => props.onError(undefined));

  const change = (value: string) => {
    setText(value);

    try {
      const parsed = mcpServersSchema.parse(JSON.parse(value));
      lastValue = JSON.stringify(parsed);
      props.onChange(parsed); report(undefined);
    } catch (reason) { report(`MCP configuration: ${reason instanceof Error ? reason.message : String(reason)}`); }
  };

  return <section class="agent-mcp-settings">
    <h3>MCP servers</h3>
    <p>Server entries use pi’s mcpServers format. Connections start when the chat opens. Servers from pi’s user and project mcp.json files are also available.</p>
    <label class="field"><span>Server configuration (JSON)</span>
      <textarea rows={14} spellcheck={false} aria-label="MCP server configuration" aria-invalid={Boolean(error())} value={text()} onInput={event => change(event.currentTarget.value)} />
    </label>
    {error() && <small class="mcp-error" role="alert">{error()}</small>}
  </section>;
}
