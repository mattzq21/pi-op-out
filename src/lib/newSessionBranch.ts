import { projectBranches } from "./nativeTransport";
import { ConversationChangedError } from "./conversationChanged";

export async function resolveNewSessionBranch(cwd: string | undefined, hostId: string, explicitGroup: boolean, current: () => boolean) {
  if (!cwd || explicitGroup) return cwd;
  const branches = await projectBranches(cwd, hostId);

  if (!current()) throw new ConversationChangedError();

  if (!branches?.current?.includes("|")) return cwd;
  const base = await projectBranches(cwd, hostId, branches.current.split("|")[0]);

  if (!current()) throw new ConversationChangedError();

  if (!base) throw new Error("Project is not a Git repository");

  return base.path;
}
