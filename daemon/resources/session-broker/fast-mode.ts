import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionAgentState } from "../../../extensions/piop-define-agents/contracts.ts";
import type { FastModeSession, FastModeSessionRequest } from "../../../extensions/piop-openai-fast-mode/src/types.ts";

/** The fast mode extension's saved choice entry. */
const STATE_ENTRY = "piop-fast-mode-state";

/** The fast mode extension's session interface, or undefined when the extension is not loaded. */
export function fastModeSession(pi: ExtensionAPI): FastModeSession | undefined {
  const request: FastModeSessionRequest = {};
  pi.events.emit("piop:fast-mode:session", request);

  return request.session;
}

/**
 * The saved choice entry for a new child session. An explicitly selected profile uses its fast mode default when it has one;
 * otherwise the child inherits this session's choice. Returns undefined when the fast mode extension is not loaded.
 */
export async function childFastModeEntry(pi: ExtensionAPI, profile: SessionAgentState, explicit: boolean) {
  const session = fastModeSession(pi);
  const declared = explicit ? profile.snapshot?.definition.fastMode : undefined;

  if (!session) return undefined;

  return { type: "custom" as const, customType: STATE_ENTRY, data: { enabled: declared ?? await session.getEnabled() } };
}
