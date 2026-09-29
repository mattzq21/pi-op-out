import type { NativeTransport, ProjectBranches } from "./nativeTransport";
import type { SessionSummary } from "../types";

type Selection = { listing: ProjectBranches; createNew: boolean };
const selections = new WeakMap<NativeTransport, Selection>();
export const initialChatSelection = (owner?: NativeTransport) => owner ? selections.get(owner) : undefined;

export function seedChatSelection(owner: NativeTransport, cwd: string | undefined, hostId: string, sessions: SessionSummary[]) {
  if (!cwd) return;
  const matching = sessions.filter(session => (session.hostId ?? "local") === hostId && (session.cwd === cwd || session.worktreeRoot === cwd));
  const source = matching.find(session => session.cwdExists !== false && session.branch && session.projectRoot);
  if (!source || source.branch?.startsWith("Detached at ")) return;
  selections.set(owner, {
    listing: { path: source.worktreeRoot ?? cwd, mainPath: source.projectRoot!, current: source.branch!, branches: [source.branch!] },
    createNew: matching.some(session => !session.isDraft && session.messageCount > 0),
  });
}
