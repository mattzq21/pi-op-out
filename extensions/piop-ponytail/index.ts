import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function ponytail(pi: ExtensionAPI) {
  const paths = ["ponytail-all/ponytail/SKILL.md", "caveman/SKILL.md"];
  const instructions = (await Promise.all(paths.map(async (path) =>
    (await readFile(join(homedir(), ".agents/skills", path), "utf8"))
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()
  ))).join("\n\n");
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
  }));
}
