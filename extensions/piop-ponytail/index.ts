import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function ponytail(pi: ExtensionAPI) {
  const paths = ["ponytail.md", "caveman.md"];

  const instructions = (await Promise.all(paths.map(async (path) =>
    (await readFile(new URL(path, import.meta.url), "utf8")).trim()
  ))).join("\n\n");

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
  }));
}
