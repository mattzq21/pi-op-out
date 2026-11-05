import { clientPayload } from './payload';

export interface SessionStateReport {
  sessionKey: string;
  epoch: string;
  state: any;
  working: boolean;
  messageable: boolean;
  settingsPending: boolean;
}

export interface SessionClosedReport { sessionKey: string; epoch: string; state: any; submitted: boolean }

// What the Host tells the rest of the daemon. The Host runs in the daemon process; these are plain calls.
export interface HostEvents {
  runtimeEvent(runtimeId: string, event: any): void;
  stderr(runtimeId: string, line: string): void;
  sessionState(report: SessionStateReport): void;
  sessionClosed(report: SessionClosedReport): void;
  sessionRemoved(sessionId: string, sessionPath: string | null): void;
  sessionsChanged(): void;
  providerAuthChanged(flow: unknown): void;
  fastModelsChanged(): void;
  agentDefinitionsChanged(): void;
  diagnostic(line: string): void;
}

// Gives the listener the client form of what can reach clients: tool payloads stay in the daemon until a client asks for them.
export function clientEvents(listener: HostEvents): HostEvents {
  return {
    runtimeEvent: (runtimeId, event) => listener.runtimeEvent(runtimeId, clientPayload(event)),
    stderr: (runtimeId, line) => listener.stderr(runtimeId, line),
    sessionState: report => listener.sessionState({ ...report, state: clientPayload(report.state) }),
    sessionClosed: report => listener.sessionClosed({ ...report, state: clientPayload(report.state) }),
    sessionRemoved: (sessionId, sessionPath) => listener.sessionRemoved(sessionId, sessionPath),
    sessionsChanged: () => listener.sessionsChanged(),
    providerAuthChanged: flow => listener.providerAuthChanged(flow),
    fastModelsChanged: () => listener.fastModelsChanged(),
    agentDefinitionsChanged: () => listener.agentDefinitionsChanged(),
    diagnostic: line => listener.diagnostic(line),
  };
}
