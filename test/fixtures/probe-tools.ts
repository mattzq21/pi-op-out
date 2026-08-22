import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function probeTools(pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const path = process.env.PI_DESKTOP_TOOL_PROBE;
    if (path) writeFileSync(path, JSON.stringify(pi.getAllTools().map((tool) => tool.name)));
  });
}
