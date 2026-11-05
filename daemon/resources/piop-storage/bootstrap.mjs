import { withSessionIds } from "./identities.mjs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installSessionStorage } from "./session-storage.mjs";
import { installSessionLists } from "../sdk-session-list.mjs";
import { transcriptWrites } from "../storage-channel.cjs";
import { patchMethod } from "../pi-patch.cjs";

export async function installStorage(runtimeRoot) {
  const { SessionManager } = await import(pathToFileURL(join(runtimeRoot, "dist/core/session-manager.js")).href);
  installSessionStorage(SessionManager, transcriptWrites);
  installSessionLists(SessionManager);
  const { AgentSessionRuntime } = await import(pathToFileURL(join(runtimeRoot, "dist/core/agent-session-runtime.js")).href);
  for (const name of ["newSession", "fork", "switchSession", "importFromJsonl"]) {
    patchMethod(AgentSessionRuntime.prototype, name, operation => function (...args) { return withSessionIds(() => operation.apply(this, args)); });
  }
}
