import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Entry = { type?: string; id?: string; parentId?: string | null; message?: Message };
type Message = { role?: string; content?: unknown; stopReason?: string };
type TraceFile = { path: string; modified: number };
type CleanMessage = { role: "user" | "assistant"; text: string };

const traceRoots = () => [join(homedir(), ".pi", "agent", "sessions"), join(homedir(), ".pi-desktop", "archived")];

async function traceFiles(root: string): Promise<TraceFile[]> {
  const files: TraceFile[] = [];
  const visit = async (directory: string) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl") {
        try { files.push({ path, modified: (await stat(path)).mtimeMs }); } catch { /* The file may disappear while sessions are being indexed. */ }
      }
    }));
  };
  await visit(root);
  return files;
}

async function findTrace(query: string, cwd: string): Promise<{ selected?: string; matches: TraceFile[] }> {
  const requested = query.trim();
  if (!requested) throw new Error("Trace query cannot be empty");
  const expanded = requested === "~" ? homedir() : requested.startsWith("~/") ? join(homedir(), requested.slice(2)) : requested;
  const direct = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  try {
    if (extname(direct).toLowerCase() === ".jsonl" && (await stat(direct)).isFile()) return { selected: direct, matches: [] };
  } catch { /* Fall through to session discovery. */ }

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
    || /^<!--\s*pi-desktop-sequence:/.test(value)
    || /^\/pi-orchestration-(?:config|next|use)\b/.test(value);
}

export function cleanTrace(content: string): CleanMessage[] {
  const entries = content.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line) as Entry]; } catch { return []; } });
  const indexed = new Map(entries.flatMap((entry) => typeof entry.id === "string" ? [[entry.id, entry] as const] : []));
  const branch: Entry[] = [];
  let cursor = [...entries].reverse().find((entry) => typeof entry.id === "string")?.id;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor); const entry = indexed.get(cursor); if (!entry) break;
    branch.unshift(entry); cursor = typeof entry.parentId === "string" ? entry.parentId : undefined;
  }
  return branch.flatMap((entry): CleanMessage[] => {
    if (entry.type !== "message" || !entry.message) return [];
    const text = textContent(entry.message.content); if (!text) return [];
    if (entry.message.role === "user" && !syntheticUserMessage(text)) return [{ role: "user", text }];
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
    description: "Find a Pi .jsonl trace and return only original user prompts and completed assistant messages. Excludes tools, tool results, reasoning, skills, system/provider instructions, AGENTS.md, and intermediate assistant tool-call messages. Use an absolute/relative path, session id, filename fragment, or latest.",
    promptSnippet: "Read a clean Pi trace by path, session id, filename fragment, or latest",
    parameters: Type.Object({ query: Type.String({ description: "Trace path, session id, filename fragment, or the word latest" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const found = await findTrace(params.query, ctx.cwd);
      if (!found.selected) {
        if (!found.matches.length) throw new Error(`No Pi .jsonl trace matched ${JSON.stringify(params.query)}`);
        const choices = found.matches.slice(0, 20).map(({ path }) => path);
        return { content: [{ type: "text", text: `More than one trace matched. Call read_trace again with one exact path:\n${choices.join("\n")}` }], details: { matches: choices } };
      }
      const messages = cleanTrace(await readFile(found.selected, "utf8"));
      if (!messages.length) throw new Error("The trace contains no user prompts or completed assistant messages on its active branch");
      return { content: [{ type: "text", text: transcript(messages) }], details: { path: found.selected, messages } };
    },
  });
}
