import type { SessionSummary } from "../types";
import { openRolloutFile } from "./nativeTransport";
import { copyText } from "./clipboard";

export async function sessionDebugAction(session: SessionSummary, action: string, notify: (notice: { title: string; message: string }) => void) {
  const opening = action === "open-rollout";

  try {
    if (opening) await openRolloutFile(session.path, session.hostId ?? "local");
    else await copyText(session.id);
  } catch (reason) {
    notify({ title: opening ? "Could not open rollout file" : "Could not copy session ID", message: reason instanceof Error ? reason.message : String(reason) });
  }
}
