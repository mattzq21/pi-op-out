import { withSessionIds } from "./identities.mjs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installSessionStorage } from "./session-storage.mjs";
import { installSessionLists } from "../sdk-session-list.mjs";
import references from "../transcript-references.cjs";

export async function installStorage(runtimeRoot) {
  const { SessionManager } = await import(pathToFileURL(join(runtimeRoot, "dist/core/session-manager.js")).href);
  installSessionStorage(SessionManager, references.publish);
  installSessionLists(SessionManager);
  const { AgentSessionRuntime } = await import(pathToFileURL(join(runtimeRoot, "dist/core/agent-session-runtime.js")).href);
  for (const name of ["newSession", "fork", "switchSession", "importFromJsonl"]) {
    const operation = AgentSessionRuntime.prototype[name];
    if (typeof operation !== "function") throw new Error(`Pi session operation is unavailable: ${name}`);
    AgentSessionRuntime.prototype[name] = function (...args) { return withSessionIds(() => operation.apply(this, args)); };
  }
}
