import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { JsonValue } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const MAX_TEXT = 64 * 1024;

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export type Observation = { key: string; kind: "command" | "search" | "read"; label: string };

export type Outcome = { fingerprint: string; failed: boolean };

function stable(value: JsonValue, depth = 0): JsonValue {
  if (depth > 12) throw new Error("Nested tool input");

  if (Array.isArray(value)) return value.map(item => stable(item, depth + 1));

  if (!(value instanceof Object)) return value;

  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item, depth + 1)]));
}

export function fingerprint(value: ToolCallEvent["input"] | [string, ToolCallEvent["input"]]): string | undefined {
  try {
    const text = JSON.stringify(value);

    if (!text || text.length > MAX_TEXT) return;

    const parsed: JsonValue = JSON.parse(text);

    return digest(JSON.stringify(stable(parsed)));
  } catch { return; }
}

function polling(command: string) {
  if (/[;&|`$<>\r\n(){}\\]/.test(command)) return false;

  return /^(?:sleep|watch|wait|test)(?:\s|$)/.test(command)
    || /^tail\s+.*(?:-f|--follow)\b/.test(command)
    || /^(?:rg|grep)\b.*\s(?:-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)(?:\s|$)/.test(command)
    || /^(?:curl|wget)\s+.*\/(?:healthz?|readyz?|status)(?:[/?\s"']|$)/.test(command)
    || /^(?:gh\s+(?:run|pr)\s+(?:view|watch|checks)|kubectl\s+(?:get|wait)|ps|pgrep)(?:\s|$)/.test(command);
}

function shellSearch(command: string) {
  return /^(?:rg|grep|find)\s/.test(command) && !/[;&|`$<>\n]/.test(command);
}

const commandSchema = Type.Object({ command: Type.Optional(Type.Unknown()), cmd: Type.Optional(Type.Unknown()) });

function toolKind(name: string, input: ToolCallEvent["input"]): Observation["kind"] | undefined {
  if (/^(?:bash|powershell|exec_command)$/.test(name)) {
    if (!Check(commandSchema, input)) return;
    const command = input.command ?? input.cmd;

    if (!Check(Type.String(), command) || polling(command.trim())) return;

    return shellSearch(command.trim()) ? "search" : "command";
  }

  if (/^(?:grep|find|search|web_search|search_query)$/.test(name)) return "search";

  if (name === "read" || name === "read_file") return "read";
}

function toolName(name: string) {
  const short = name.split(".").at(-1) ?? name;

  if (!short.startsWith("mcp_")) return short;

  return short.match(/_(exec_command|web_search|search_query|grep|find|search|read_file)$/)?.[1] ?? short;
}

export function observe(event: ToolCallEvent): Observation | undefined {
  const name = toolName(event.toolName);
  const kind = toolKind(name, event.input);

  if (!kind) return;
  const input = Object.fromEntries(Object.entries(event.input).filter(([key]) => key !== "yield_time_ms"));
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

const exitSchema = Type.Union([Type.Number(), Type.Null()]);

const envelopeSchema = Type.Object({ output: Type.String(), exit_code: Type.Optional(exitSchema), session_id: Type.Optional(Type.Unknown()) });

const detailsSchema = Type.Object({ exitCode: Type.Optional(exitSchema), exit_code: Type.Optional(exitSchema), truncation: Type.Optional(Type.Unknown()), session_id: Type.Optional(Type.Unknown()) });

type ShellOutput = { text: string; exit?: number | null; running: boolean };

type ResultDetails = Static<typeof detailsSchema>;

function shellEnvelope(text: string): ShellOutput {
  try {
    const value = JSON.parse(text);

    if (Check(envelopeSchema, value)) return { text: value.output, exit: value.exit_code, running: value.session_id != null && value.exit_code == null };
  } catch { }

  const exit = text.match(/(?:^|\n)Process exited with code (\d+)(?:\n|$)/)?.[1];
  const output = text.match(/(?:^|\n)(?:Final output|Output):\n([\s\S]*)$/)?.[1];

  if (exit && output !== undefined) return { text: output, exit: Number(exit), running: false };

  return { text, exit: undefined, running: /(?:^|\n)Process running with session ID\b/.test(text) };
}

function resultExit(result: ShellOutput, details: ResultDetails) { return result.exit ?? details.exitCode ?? details.exit_code; }

function incomplete(details: ResultDetails, exit: ShellOutput["exit"]) { return Boolean(details.truncation || (details.session_id != null && exit == null)); }

export function outcome(event: ToolResultEvent): Outcome | undefined {
  const text = outputText(event);

  if (text === undefined) return;
  const shell = /^(?:bash|powershell|exec_command)$/.test(toolName(event.toolName));
  const result = shell ? shellEnvelope(text) : { text, exit: undefined, running: false };

  if (result.running || /(?:^|\n)Command (?:aborted|cancelled|canceled)\.?$/.test(text)) return;
  const details: ResultDetails = Check(detailsSchema, event.details) ? event.details : {};
  const exit = resultExit(result, details);

  if (incomplete(details, exit)) return;
  const failed = event.isError || (exit != null && exit !== 0);

  return { fingerprint: digest(JSON.stringify([failed, exit, result.text])), failed };
}
