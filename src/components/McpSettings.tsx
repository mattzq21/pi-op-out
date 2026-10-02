import { mcpServersSchema } from "../lib/agentSchemas";
import type { McpServers } from "../types";

export type McpEditorDraft = { text: string; error?: string };

export function McpSettings(props: { value: McpServers; draft?: McpEditorDraft; onDraft: (draft: McpEditorDraft) => void; onChange: (value: McpServers) => void }) {
  const change = (text: string) => {
    try {
      const parsed = mcpServersSchema.parse(JSON.parse(text));
      props.onDraft({ text });
      props.onChange(parsed);
    } catch (reason) { props.onDraft({ text, error: `MCP configuration: ${reason instanceof Error ? reason.message : String(reason)}` }); }
  };

  return <section class="agent-mcp-settings">
    <h3>MCP servers</h3>
    <p>Server entries use pi’s mcpServers format. Connections start when you send the first message. Servers from pi’s user and project mcp.json files are also available.</p>
    <label class="field"><span>Server configuration (JSON)</span>
      <textarea rows={14} spellcheck={false} aria-label="MCP server configuration" aria-invalid={Boolean(props.draft?.error)} value={props.draft?.text ?? JSON.stringify(props.value, null, 2)} onInput={event => change(event.currentTarget.value)} />
    </label>
    {props.draft?.error && <small class="mcp-error" role="alert">{props.draft.error}</small>}
  </section>;
}
