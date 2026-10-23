import type { AgentConfig } from "../types";

export async function saveAgentConfiguration(next: AgentConfig, previous: AgentConfig | undefined, write: (configuration: AgentConfig) => Promise<string>) {
  if (!previous || !next.revision || next.revision !== previous.revision) throw new Error("Agent definitions changed in another window or client. Reload them before saving.");
  const savedRevision = await write(next);
  next.revision = savedRevision;

  return async () => {
    const restoredRevision = await write({ ...previous, revision: savedRevision });
    previous.revision = restoredRevision; next.revision = restoredRevision;
  };
}

export async function restoreAgentConfiguration(restore: (() => Promise<void>) | undefined, reason: string) {
  if (!restore) return;

  try { await restore(); }
  catch (rollback) { throw new Error(`Settings save failed: ${reason}. Agent definitions could not be restored: ${(rollback instanceof Error ? rollback.message : String(rollback))}. Reload settings before retrying.`); }
}
