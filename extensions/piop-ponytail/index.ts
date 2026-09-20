import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function ponytail(pi: ExtensionAPI) {
  const path = join(homedir(), ".agents/skills/ponytail-all/ponytail/SKILL.md");
  const instructions = (await readFile(path, "utf8")).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
  }));
}
