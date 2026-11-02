import { createMemo, createSignal, Show } from "solid-js";
import { Key } from "@solid-primitives/keyed";
import { z } from "zod";
import "./skill-mcp-status.css";

const statusSchema = z.array(z.object({ name: z.string(), label: z.string(), state: z.enum(["connecting", "connected", "failed"]), error: z.string().optional() }));
type Server = z.infer<typeof statusSchema>[number];

function parseStatus(value?: string): { servers: Server[]; error?: string } {
  try { return { servers: statusSchema.parse(JSON.parse(value ?? "[]")) }; }
  catch { return { servers: [], error: "Could not read skill MCP status." }; }
}

export function skillMcpConnecting(value?: string) {
  return parseStatus(value).servers.some(server => server.state === "connecting");
}

export function SkillMcpStatus(props: { value?: string; disabled?: boolean; onAction: (name: string, action: "retry" | "remove") => Promise<unknown> }) {
  const status = createMemo(() => parseStatus(props.value));
  const attention = createMemo(() => status().servers.filter(server => server.state === "failed"));
  return <Show when={attention().length || status().error}><section class="skill-mcp-status" aria-label="Skill MCP servers">
    <Show when={status().error}>{error => <p role="alert">{error()}</p>}</Show>
    <Key each={attention()} by="name">{server => <ServerStatus server={server()} disabled={props.disabled} onAction={props.onAction} />}</Key>
  </section></Show>;
}

function ServerStatus(props: { server: Server; disabled?: boolean; onAction: (name: string, action: "retry" | "remove") => Promise<unknown> }) {
  const [pending, setPending] = createSignal<"retry" | "remove">();
  const [error, setError] = createSignal<string>();
  const act = async (action: "retry" | "remove") => {
    if (pending() && action !== "remove") return;
    setPending(action); setError(undefined);
    try { await props.onAction(props.server.name, action); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { if (pending() === action) setPending(undefined); }
  };
  return <div class="skill-mcp-row">
    <div role="alert"><strong>{props.server.label}</strong>
      <p>{props.server.error || "Connection failed."}</p>
      <Show when={error()}>{message => <p role="alert">{message()}</p>}</Show>
    </div>
    <div class="skill-mcp-actions">
      <button type="button" disabled={props.disabled || Boolean(pending())} onClick={() => act("retry")}>{pending() === "retry" ? "Retrying…" : "Retry"}</button>
      <button type="button" disabled={props.disabled || pending() === "remove"} onClick={() => act("remove")}>{pending() === "remove" ? "Removing…" : "Remove"}</button>
    </div>
  </div>;
}
