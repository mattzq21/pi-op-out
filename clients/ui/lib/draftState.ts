import type { ComposerUpload } from "../types";

export interface DraftDestination {
  key: string;
  hostId: string;
  cwd?: string;
  sessionPath?: string;
  temporary: boolean;
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
  status: "preparing" | "uncertain";
  createdAt: number;
  error?: string;
}
