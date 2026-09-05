import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { desktopPauseContext } from "../../src-tauri/resources/session-broker.ts";
import { registerCodexCompactionExtension } from "./upstream/index.ts";
import type { ContextMessagesTransform } from "./upstream/native-compaction.ts";

// Native checkpoints rebuild provider input from the saved branch, bypassing
// normal context hooks. Apply the same desktop context rules to that history.
const desktopContext: ContextMessagesTransform = (messages, branch) => {
  const resumeMessages = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== "pi-desktop-resume") continue;
    const message = (entry.data as { message?: unknown } | undefined)?.message;
    if (typeof message === "string") resumeMessages.add(message);
  }
  const context = desktopPauseContext(messages, resumeMessages).filter((message) => message.role !== "custom" || message.customType !== "pi-desktop-mcp-status");
  for (const customType of ["pi-desktop-project-context", "pi-project-files-watch"]) {
    const index = context.findLastIndex((message) => message.role === "custom" && message.customType === customType);
    if (index > 0 && context[index - 1].role === "user") {
      const [message] = context.splice(index, 1);
      context.splice(index - 1, 0, message);
    }
  }
  return context;
};

export default function codexCompaction(pi: ExtensionAPI): void {
  registerCodexCompactionExtension(pi, undefined, desktopContext);
}
