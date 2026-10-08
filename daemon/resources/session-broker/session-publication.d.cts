export interface ReviewPublicationRecord {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  parentSessionId: string;
  hostId: string;
  publicationId: string;
}

export interface PublicationOptions {
  review?: { record: ReviewPublicationRecord; parentSessionPath: string };
  dependencies?: {
    workspace?: { path: string; kind: "existing" | "created-directory" | "created-worktree"; branch?: string };
    checkpoints?: { root: string; ref: string; commit: string }[];
  };
  beforeWrite?: () => void | Promise<void>;
  sidecars?: string[];
}

export interface PublicationDependencies {
  version: 1;
  workspace: { path: string; kind: "existing" | "created-directory" | "created-worktree"; branch?: string; identity: string };
  goalAssets: { version: 1; policy: "shared-profile"; directories: { path: string; identity: string }[] };
  checkpoints: { root: string; ref: string; commit: string; sourceRef?: string }[];
}

export interface DiagnosticPublication {
  kind: "publication-diagnostic";
  sessionId: string;
  journalPath: string;
  transcriptPaths: string[];
  dependencies?: PublicationDependencies;
  sidecars: { path: string; identity?: string; bytes?: number; digest?: string }[];
}

export interface SessionPublication {
  id: string;
  root: string;
  sessionPath: string;
  warnings: string[];
}

export interface PublicationRecovery {
  recovered: string[];
  pendingReviews: ReviewPublicationRecord[];
  quarantined: { path: string; reason: string }[];
  active: string[];
  warnings: string[];
}

export class SessionPublicationError extends Error {
  publicationPending: boolean;
  dependenciesRetained: boolean;
  journalPath: string;
}

export function publish(target: string, body: string, options?: PublicationOptions): Promise<SessionPublication>;
export function recover(root: string): PublicationRecovery;
export function retainedDependencies(root: string): DiagnosticPublication[];
export function pendingReviews(parentPath: string, parentId: string): { publication: SessionPublication; record: ReviewPublicationRecord }[];
export function acknowledge(publication: SessionPublication): boolean;
export function release(publication: SessionPublication): void;
export function abandon(publication: SessionPublication): void;
export function reviewVisibility(file: string, parentId: string): "pending" | "legacy" | null;
