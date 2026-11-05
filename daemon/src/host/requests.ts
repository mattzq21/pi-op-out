// What the daemon asks of the Host. The Host checks these values again where it uses them.

export interface HostConfiguration {
  contextCapSettings: unknown;
  settings: Record<string, unknown>;
  autoCompaction: boolean;
  autoRetry: boolean;
}

export interface AttachRequest {
  clientId: string;
  runtimeId: string;
  sessionKey: string;
  spec: unknown;
  timeout: number;
  cwd: string | null;
  presence: Record<string, unknown>;
  takeOwnership?: boolean;
}

export interface MutationRequest {
  sessionId: string;
  sessionPath: string;
  clientId: string;
  archived: boolean;
  operation: 'archive' | 'delete' | 'relocate' | 'restore';
}

export interface MutationEnd { token: string; success: boolean }

export type OrchestrationRequest = { sessionKey: string } & (
  | { action: 'locate' | 'preview' | 'branch_off' | 'read'; sessionPath?: string }
  | { action: 'rename'; name: string | null }
  | { action: 'watch'; stateKey: string | null; waitMs: number | null }
  | { action: 'interrupt'; deliveryId?: string | null }
  | { action: 'send' | 'settle_first_message' | 'resume'; [field: string]: unknown }
);
