import { createHash } from "node:crypto";
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const MAX_TEXT = 64 * 1024;
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export type Observation = { key: string; kind: "command" | "search" | "read"; label: string };
export type Outcome = { fingerprint: string; failed: boolean };

function stable(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error("Nested tool input");
  if (Array.isArray(value)) return value.map(item => stable(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item, depth + 1)]));
}

export function fingerprint(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    if (!text || text.length > MAX_TEXT) return;
    return digest(JSON.stringify(stable(value)));
  } catch { return; }
}

function polling(command: string) {
  if (/[;&|`$<>\r\n(){}\\]/.test(command)) return false;
  return /^(?:sleep|watch|wait|test)(?:\s|$)/.test(command)
    || /^tail\s+.*(?:-f|--follow)\b/.test(command)
    || /^(?:rg|grep)\b.*\s(?:-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)(?:\s|$)/.test(command)
    || /^(?:curl|wget)\s+.*\/(?:healthz?|readyz?|status)(?:[/?\s"']|$)/.test(command)
    || /^(?:git\s+(?:status|diff)|gh\s+(?:run|pr)\s+(?:view|watch|checks)|kubectl\s+(?:get|wait)|ps|pgrep)(?:\s|$)/.test(command);
}

function shellSearch(command: string) {
  return /^(?:rg|grep|find)\s/.test(command) && !/[;&|`$<>\n]/.test(command);
}

function toolKind(name: string, input: Record<string, unknown>): Observation["kind"] | undefined {
  if (/^(?:bash|powershell|exec_command)$/.test(name)) {
    const command = input.command ?? input.cmd;
    if (typeof command !== "string" || polling(command.trim())) return;
    return shellSearch(command.trim()) ? "search" : "command";
  }
  if (/^(?:grep|find|search|web_search|search_query)$/.test(name)) return "search";
  if (name === "read" || name === "read_file") return "read";
}

function toolName(name: string) {
  const short = name.split(".").at(-1)!;
  if (!short.startsWith("mcp_")) return short;
  return short.match(/_(exec_command|web_search|search_query|grep|find|search|read_file)$/)?.[1] ?? short;
}

export function observe(event: ToolCallEvent): Observation | undefined {
  const name = toolName(event.toolName);
  const kind = toolKind(name, event.input);
  if (!kind) return;
  const input: Record<string, unknown> = { ...event.input };
  delete input.yield_time_ms;
  const key = fingerprint([event.toolName, input]);
  if (!key) return;
  return { key, kind, label: `${name.slice(0, 64)} call ${event.toolCallId.replace(/[^\w.-]/g, "").slice(0, 64)}` };
}

function outputText(event: ToolResultEvent): string | undefined {
  let text = "";
  for (const part of event.content) {
    if (part.type !== "text" || text.length + part.text.length > MAX_TEXT) return;
    text += part.text + "\n";
  }
  return text.replaceAll("\r\n", "\n").trimEnd();
}

function shellEnvelope(text: string) {
  try {
    const value = JSON.parse(text);
    if (typeof value?.output === "string") return { text: value.output, exit: value.exit_code, running: value.session_id != null && value.exit_code == null };
  } catch { }
  const exit = text.match(/(?:^|\n)Process exited with code (\d+)(?:\n|$)/)?.[1];
  const output = text.match(/(?:^|\n)(?:Final output|Output):\n([\s\S]*)$/)?.[1];
  if (exit && output !== undefined) return { text: output, exit: Number(exit), running: false };
  return { text, exit: undefined, running: /(?:^|\n)Process running with session ID\b/.test(text) };
}

function resultExit(event: ToolResultEvent, exit: unknown) {
  const details = event.details as { exitCode?: number; exit_code?: number } | undefined;
  return exit ?? details?.exitCode ?? details?.exit_code;
}

function incomplete(event: ToolResultEvent, exit: unknown) {
  const details = event.details as { truncation?: unknown; session_id?: unknown } | undefined;
  return !!details?.truncation || (details?.session_id != null && exit == null);
}

export function outcome(event: ToolResultEvent): Outcome | undefined {
  const text = outputText(event);
  if (text === undefined) return;
  const shell = /^(?:bash|powershell|exec_command)$/.test(toolName(event.toolName));
  const result = shell ? shellEnvelope(text) : { text, exit: undefined, running: false };
  if (result.running || /(?:^|\n)Command (?:aborted|cancelled|canceled)\.?$/.test(text)) return;
  const exit = resultExit(event, result.exit);
  if (incomplete(event, exit)) return;
  const failed = event.isError || (typeof exit === "number" && exit !== 0);
  return { fingerprint: digest(JSON.stringify([failed, exit, result.text])), failed };
}
