export interface ReviewPublicationRecord {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  parentSessionId: string;
  hostId: string;
  publicationId: string;
}

export interface PublicationOptions {
  goalSource?: string;
  review?: { record: ReviewPublicationRecord; parentSessionPath: string };
  dependencies?: {
    workspace?: { path: string; kind: "existing" | "created-directory" };
  };
  beforeWrite?: () => void | Promise<void>;
}

export interface PublicationDependencies {
  version: 1;
  workspace: { path: string; kind: "existing" | "created-directory"; identity: string };
  goalAssets: { version: 1; policy: "shared-profile"; directories: { path: string; identity: string }[] };
}

export interface DiagnosticPublication {
  kind: "publication-diagnostic";
  sessionId: string;
  journalPath: string;
  transcriptPaths: string[];
  dependencies?: PublicationDependencies;
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

export function publish(target: string, body: string, withReferences: (operation: () => Promise<SessionPublication>) => Promise<SessionPublication>, options?: PublicationOptions): Promise<SessionPublication>;
export function recover(root: string): PublicationRecovery;
export function retainedDependencies(root: string): DiagnosticPublication[];
export function pendingReviews(parentPath: string, parentId: string): Promise<{ publication: SessionPublication; record: ReviewPublicationRecord }[]>;
export function acknowledge(publication: SessionPublication): Promise<boolean>;
export function release(publication: SessionPublication): void;
export function reviewVisibility(file: string, parentId: string): "pending" | "legacy" | null;
