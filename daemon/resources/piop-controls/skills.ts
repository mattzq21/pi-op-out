import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CALL = /\/skill:(\S+)(?:\s+|$)/y;

function leadingCalls(text: string) {
  const names: string[] = [];
  let at = 0;

  for (let match; at < text.length; at = CALL.lastIndex) {
    CALL.lastIndex = at;
    match = CALL.exec(text);
    if (!match) break;
    names.push(match[1]);
  }

  return { names, rest: text.slice(at).trim() };
}

export default function skills(pi: ExtensionAPI) {
  pi.on("input", (event, ctx) => {
    const { names, rest } = leadingCalls(event.text);
    if (!names.length) return;
    const available = new Map(pi.getCommands().flatMap(command => command.source === "skill" ? [[command.name.replace(/^skill:/, ""), command.sourceInfo.path] as const] : []));
    try {
      const blocks = [...new Set(names)].map(name => {
        const path = available.get(name);
        if (!path) throw new Error(`Skill "${name}" is not available`);
        return `<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${stripFrontmatter(readFileSync(path, "utf8")).trim()}\n</skill>`;
      });
      return { action: "transform" as const, text: [...blocks, rest].filter(Boolean).join("\n\n") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus("piop-input-rejected", JSON.stringify({ text: event.text, error: message }));
      ctx.ui.notify(message, "error");
      return { action: "handled" as const };
    }
  });
}
