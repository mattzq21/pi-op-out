import type { ComposerUpload } from "../types";

export interface DraftDestination {
  key: string;
  hostId: string;
  cwd?: string;
  sessionPath?: string;
  temporary: boolean;
  /** The group the new chat goes to, so its pending first message shows there. */
  groupId?: string;
}

export interface DraftRecord {
  key: string;
  destination?: DraftDestination;
  text: string;
  uploads: ComposerUpload[];
  updatedAt: number;
  retrySubmission?: { id: string; fingerprint: string };
}

export interface DraftSubmission {
  id: string;
  destination: DraftDestination;
  rawText: string;
  uploads: ComposerUpload[];
  /** dispatched: sent to the host, and its outcome is not known yet. */
  status: "preparing" | "dispatched";
  createdAt: number;
  error?: string;
}
