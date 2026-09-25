import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Entry = { type?: string; id?: string; parentId?: string | null; message?: Message; customType?: string; data?: { message?: string; role?: string; text?: string; completed?: boolean } };
type Message = { role?: string; content?: unknown; stopReason?: string };
type TraceFile = { path: string; modified: number };
type CleanMessage = { role: "user" | "assistant"; text: string };

const traceRoots = () => [join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "sessions"), join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop", "archived")];

async function piopTracePath(path: string): Promise<string> {
  const canonical = await realpath(path);
  for (const root of traceRoots()) {
    let canonicalRoot: string;
    try { canonicalRoot = await realpath(root); } catch { continue; }
    const child = relative(canonicalRoot, canonical);
    if (child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
      && extname(canonical).toLowerCase() === ".jsonl" && (await stat(canonical)).isFile()) return canonical;
  }
  throw new Error("Only Piop traces in the current Piop profile’s sessions or archives can be read");
}

async function traceFiles(root: string): Promise<TraceFile[]> {
  const files: TraceFile[] = [];
  const visit = async (directory: string) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl") {
        try { files.push({ path, modified: (await stat(path)).mtimeMs }); } catch { }
      }
    }));
  };
  await visit(root);
  return files;
}

function expandHome(requested: string) {
  return requested === "~" ? homedir() : requested.startsWith("~/") ? join(homedir(), requested.slice(2)) : requested;
}

async function findTrace(query: string, cwd: string): Promise<{ selected?: string; matches: TraceFile[] }> {
  const requested = query.trim();
  if (!requested) throw new Error("Trace query cannot be empty");
  const expanded = expandHome(requested);
  const direct = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  if (isAbsolute(expanded) || requested.includes("/") || requested.includes("\\")) {
    return { selected: await piopTracePath(direct), matches: [] };
  }

  const files = (await Promise.all(traceRoots().map(traceFiles))).flat().sort((left, right) => right.modified - left.modified);
  if (requested.toLowerCase() === "latest") return { selected: files[0]?.path, matches: files.slice(0, 1) };
  const needle = requested.toLowerCase().replace(/\.jsonl$/, "");
  const matches = files.filter(({ path }) => path.toLowerCase().includes(needle));
  const exact = matches.filter(({ path }) => basename(path).toLowerCase() === requested.toLowerCase() || basename(path, ".jsonl").toLowerCase() === needle);
  return { selected: exact.length === 1 ? exact[0].path : matches.length === 1 ? matches[0].path : undefined, matches };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("").trim();
}

function syntheticUserMessage(text: string) {
  const value = text.trim();
  return /^<skill(?:\s|>)[\s\S]*<\/skill>$/.test(value)
    || /^\/pi-define-agents-(?:config|use)\b/.test(value);
}

function rememberResume(entry: Entry, resumeMessages: Set<string>) {
  if (entry.type === "custom" && entry.customType === "pi-desktop-resume" && typeof entry.data?.message === "string") resumeMessages.add(entry.data.message);
}

function spokenTraceMessage(entry: Entry): CleanMessage[] | undefined {
  if (entry.type === "custom" && entry.customType === "piop-voice" && entry.data?.completed === true && (entry.data.role === "user" || entry.data.role === "assistant") && typeof entry.data.text === "string" && entry.data.text.trim()) return [{ role: entry.data.role, text: entry.data.text.trim() }];
}

function originalUserText(text: string, resumeMessages: Set<string>) {
  return !syntheticUserMessage(text) && !resumeMessages.has(text);
}

export function cleanTrace(content: string): CleanMessage[] {
  const entries = content.split(/\r?\n/).flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line);
      return entry && typeof entry === "object" && !Array.isArray(entry) ? [entry as Entry] : [];
    } catch { return []; }
  });
  const indexed = new Map(entries.flatMap((entry) => typeof entry.id === "string" ? [[entry.id, entry] as const] : []));
  const branch: Entry[] = [];
  let cursor = [...entries].reverse().find((entry) => typeof entry.id === "string")?.id;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor); const entry = indexed.get(cursor); if (!entry) break;
    branch.unshift(entry); cursor = typeof entry.parentId === "string" ? entry.parentId : undefined;
  }
  const resumeMessages = new Set<string>();
  return branch.flatMap((entry): CleanMessage[] => {
    rememberResume(entry, resumeMessages);
    const spoken = spokenTraceMessage(entry);
    if (spoken) return spoken;
    if (entry.type !== "message" || !entry.message) return [];
    let text = textContent(entry.message.content);
    if (entry.message.role === "user") text = text.replace(/^<skill(?:\s[^>]*|)>[\s\S]*?<\/skill>\s*/, "").trim();
    if (!text) return [];
    if (entry.message.role === "user" && originalUserText(text, resumeMessages)) return [{ role: "user", text }];
    if (entry.message.role === "assistant" && entry.message.stopReason !== "toolUse") return [{ role: "assistant", text }];
    return [];
  });
}

function transcript(messages: CleanMessage[]) {
  return messages.map((message) => `${message.role === "user" ? "USER" : "ASSISTANT"}\n${message.text}`).join("\n\n");
}

export default function traceReader(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_trace",
    label: "Read trace",
    description: "Find a Piop .jsonl trace in the current Piop profile’s sessions or archives and return only original user prompts and completed assistant messages. Excludes tools, tool results, reasoning, skills, system/provider instructions, AGENTS.md, and intermediate assistant tool-call messages. Use a Piop trace path, session id, filename fragment, or latest. Traces outside Piop storage are not supported.",
    promptSnippet: "Read a clean Piop trace by path, session id, filename fragment, or latest",
    parameters: Type.Object({ query: Type.String({ description: "Trace path, session id, filename fragment, or the word latest" }), offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset from the preceding page's nextOffset" })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32000, description: "Maximum characters to return (default 16000)" })) }),
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const found = await findTrace(params.query, ctx.cwd);
      if (!found.selected) {
        if (!found.matches.length) throw new Error(`No Piop .jsonl trace matched ${JSON.stringify(params.query)}`);
        const choices = found.matches.slice(0, 20).map(({ path }) => path);
        return { content: [{ type: "text", text: `More than one trace matched. Call read_trace again with one exact path:\n${choices.join("\n")}` }], details: { matches: choices } };
      }
      const messages = cleanTrace(await readFile(await piopTracePath(found.selected), "utf8"));
      if (!messages.length) throw new Error("The trace contains no user prompts or completed assistant messages on its active branch");
      const text = transcript(messages); const offset = params.offset ?? 0; const end = Math.min(text.length, offset + (params.limit ?? 16000));
      const nextOffset = end < text.length ? end : undefined;
      const continuation = nextOffset === undefined ? "" : `\n\n[More trace content: call read_trace with query ${JSON.stringify(found.selected)} and offset ${nextOffset}.]`;
      return { content: [{ type: "text", text: text.slice(offset, end) + continuation }], details: { path: found.selected, offset, nextOffset, totalCharacters: text.length } };
    },
  });
}
