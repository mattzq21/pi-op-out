import type { SessionSummary } from "../types";
import { openRolloutFile } from "./nativeTransport";

export async function sessionDebugAction(session: SessionSummary, action: string, notify: (notice: { title: string; message: string }) => void) {
  const opening = action === "open-rollout";
  try {
    if (opening) await openRolloutFile(session.path, session.hostId ?? "local");
    else await navigator.clipboard.writeText(session.id);
  } catch (reason) {
    notify({ title: opening ? "Could not open rollout file" : "Could not copy session ID", message: String(reason) });
  }
}
