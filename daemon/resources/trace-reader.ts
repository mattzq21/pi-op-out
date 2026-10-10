import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Type as Schema, type Static } from "typebox";
import { Check, Parse } from "typebox/value";
import { open as openDatabase } from "./session-database.cjs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const entrySchema = Schema.Object({
  type: Schema.Optional(Schema.String()), id: Schema.Optional(Schema.String()), parentId: Schema.Optional(Schema.Union([Schema.String(), Schema.Null()])),
  message: Schema.Optional(Schema.Unknown()), customType: Schema.Optional(Schema.String()), data: Schema.Optional(Schema.Unknown()),
});

type Entry = Static<typeof entrySchema>;

const contentSchema = Schema.Union([Schema.String(), Schema.Array(Schema.Unknown())]);

const messageSchema = Schema.Object({ role: Schema.Optional(Schema.String()), content: Schema.Optional(contentSchema), stopReason: Schema.Optional(Schema.String()) });

const textPartSchema = Schema.Object({ type: Schema.Literal("text"), text: Schema.String() });

const resumeSchema = Schema.Object({ message: Schema.String() });

type TraceFile = { path: string; modified: number };

type CleanMessage = { role: "user" | "assistant"; text: string };

const profile = () => join(homedir(), process.env.PIOP_STORAGE_DIRECTORY || ".piop");

const traceRoots = () => [join(profile(), "sessions"), join(profile(), "archived")];

const registeredTraceSchema = Schema.Object({ session_id: Schema.String(), session_path: Schema.String() });

function registeredTraces(needle: string) {
  const db = openDatabase(profile());

  try {
    return db.prepare(`SELECT session_id, session_path FROM sessions WHERE session_path IS NOT NULL
      AND (instr(lower(session_path), ?)>0 OR instr(lower(session_id), ?)>0)`)
      .all(needle, needle).map(row => Parse(registeredTraceSchema, row));
  } finally { db.close(); }
}

function registeredIdentity(path: string) {
  const db = openDatabase(profile());

  try {
    const row = db.prepare(`SELECT session_id, session_path FROM sessions WHERE session_path=?`).get(path);

    if (!row) throw new Error("This conversation is not registered or was deleted");

    return Parse(registeredTraceSchema, row).session_id;
  } finally { db.close(); }
}

async function piopTracePath(path: string): Promise<string> {
  const canonical = await realpath(path);
  registeredIdentity(canonical);

  for (const root of traceRoots()) {
    let canonicalRoot: string;

    try { canonicalRoot = await realpath(root); } catch { continue; }

    const child = relative(canonicalRoot, canonical);

    if (child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
      && extname(canonical).toLowerCase() === ".jsonl" && (await stat(canonical)).isFile()) return canonical;
  }

  throw new Error("Only Piop traces in the current Piop profile’s sessions or archives can be read");
}

async function traceFiles(needle: string): Promise<TraceFile[]> {
  const files: TraceFile[] = [];

  for (const row of registeredTraces(needle)) {
    if (!traceRoots().some(root => {
      const child = relative(root, row.session_path);

      return child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    })) continue;

    try {
      const metadata = await stat(row.session_path);

      if (metadata.isFile() && extname(row.session_path).toLowerCase() === ".jsonl") files.push({ path: row.session_path, modified: metadata.mtimeMs });
    } catch { }
  }

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

  const needle = requested.toLowerCase().replace(/\.jsonl$/, "");
  const files = await matchingTraceFiles(requested, needle);

  if (requested.toLowerCase() === "latest") return { selected: files[0]?.path, matches: files.slice(0, 1) };
  const matches = files;
  const exact = matches.filter(({ path }) => basename(path).toLowerCase() === requested.toLowerCase() || basename(path, ".jsonl").toLowerCase() === needle);

  return { selected: exact.length === 1 ? exact[0].path : matches.length === 1 ? matches[0].path : undefined, matches };
}

async function matchingTraceFiles(requested: string, needle: string) {
  const files = await traceFiles(requested.toLowerCase() === "latest" ? "" : needle);

  return files.sort((left, right) => right.modified - left.modified);
}

function textContent(content: Static<typeof contentSchema> | undefined): string {
  if (!Array.isArray(content)) return content?.trim() ?? "";

  return content.flatMap(part => Check(textPartSchema, part) ? [part.text] : []).join("").trim();
}

function syntheticUserMessage(text: string) {
  const value = text.trim();

  return /^<skill(?:\s|>)[\s\S]*<\/skill>$/.test(value)
    || /^\/pi-define-agents-(?:config|use)\b/.test(value);
}

function rememberResume(entry: Entry, resumeMessages: Set<string>) {
  if (entry.type === "custom" && entry.customType === "pi-desktop-resume" && Check(resumeSchema, entry.data)) resumeMessages.add(entry.data.message);
}

function originalUserText(text: string, resumeMessages: Set<string>) {
  return !syntheticUserMessage(text) && !resumeMessages.has(text);
}

export function cleanTrace(content: string): CleanMessage[] {
  const entries = content.split(/\r?\n/).flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line);

      return Check(entrySchema, entry) ? [entry] : [];
    } catch { return []; }
  });

  const indexed = new Map(entries.flatMap((entry): Array<[string, Entry]> => entry.id !== undefined ? [[entry.id, entry]] : []));
  const branch: Entry[] = [];
  let cursor = [...entries].reverse().find((entry) => entry.id !== undefined)?.id;
  const visited = new Set<string>();

  while (cursor && !visited.has(cursor)) {
    visited.add(cursor); const entry = indexed.get(cursor);

    if (!entry) break;
    branch.unshift(entry); cursor = entry.parentId ?? undefined;
  }

  const resumeMessages = new Set<string>();

  return branch.flatMap((entry): CleanMessage[] => {
    rememberResume(entry, resumeMessages);

    if (entry.type !== "message" || !Check(messageSchema, entry.message)) return [];
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

      const selected = await piopTracePath(found.selected);
      const sessionId = registeredIdentity(selected);
      const body = await readFile(selected, "utf8");
      const header = Schema.Object({ type: Schema.Literal("session"), id: Schema.Literal(sessionId) });

      if (!Check(header, JSON.parse(body.split(/\r?\n/, 1)[0]))) throw new Error("The conversation file no longer matches its registered session");
      const messages = cleanTrace(body);

      if (!messages.length) throw new Error("The trace contains no user prompts or completed assistant messages on its active branch");
      const text = transcript(messages); const offset = params.offset ?? 0; const end = Math.min(text.length, offset + (params.limit ?? 16000));
      const nextOffset = end < text.length ? end : undefined;
      const continuation = nextOffset === undefined ? "" : `\n\n[More trace content: call read_trace with query ${JSON.stringify(found.selected)} and offset ${nextOffset}.]`;

      return { content: [{ type: "text", text: text.slice(offset, end) + continuation }], details: { path: found.selected, offset, nextOffset, totalCharacters: text.length } };
    },
  });
}
