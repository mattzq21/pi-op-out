import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installSessionLists, installSessionStorage, withSessionIds } from '../piop-storage/index.ts';
import { storageChannel } from '../session-database/index.ts';
import { patchMethod } from '../pi/index.ts';

export async function installStorage(runtimeRoot: string) {
  const { SessionManager } = await import(pathToFileURL(join(runtimeRoot, "dist/core/session-manager.js")).href);
  installSessionStorage(SessionManager, storageChannel.transcriptWrites);
  installSessionLists(SessionManager);
  const { AgentSessionRuntime } = await import(pathToFileURL(join(runtimeRoot, "dist/core/agent-session-runtime.js")).href);
  for (const name of ["newSession", "fork", "switchSession", "importFromJsonl"]) {
    patchMethod(AgentSessionRuntime.prototype, name, operation => function (this: any, ...args) { return withSessionIds(() => operation.apply(this, args)); });
  }
}
