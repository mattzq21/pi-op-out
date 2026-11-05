import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { leadingCalls, skillPaths } from "./skill-calls.ts";

export default function skills(pi: ExtensionAPI) {
  pi.on("input", (event, ctx) => {
    const { names, rest } = leadingCalls(event.text);
    if (!names.length) return;
    const available = skillPaths(pi);
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
