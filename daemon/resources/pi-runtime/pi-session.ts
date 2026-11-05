import type { AgentSession, AgentActivityOutcome, BuildSystemPromptOptions, ExtensionRunner, NormalizedBuildSystemPromptOptions } from '@earendil-works/pi-coding-agent';
import type { Agent, AgentLoopConfig, AgentMessage, AgentState } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ImageContent, SystemMessage } from '@earendil-works/pi-ai';

export type PiopMessage = AgentMessage & { piopQueueId?: string; piopSubmissionId?: string };

export interface PendingMessageQueue {
  messages: PiopMessage[];
  hasItems(): boolean;
  drain(): PiopMessage[];
}

export interface PiAgent extends Pick<Agent, keyof Agent> {
  readonly steeringQueue: PendingMessageQueue;
  readonly followUpQueue: PendingMessageQueue;
  _state?: AgentState;
  createLoopConfig(options?: { skipInitialSteeringPoll?: boolean }): AgentLoopConfig;
  runPromptMessages(messages: AgentMessage[], options?: { skipInitialSteeringPoll?: boolean }): Promise<void>;
  runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void>;
}

export interface PiSession extends Omit<Pick<AgentSession, keyof AgentSession>, 'agent' | 'getFollowUpMessages'> {
  readonly agent: PiAgent;
  getFollowUpMessages(): string[];
  _isAgentRunActive: boolean;
  _agentRunAbortRequested: boolean;
  _steeringMessages: string[];
  _followUpMessages: string[];
  _lastActivityOutcome: AgentActivityOutcome;
  _lastAssistantMessage: AssistantMessage | undefined;
  _failedResponse: AssistantMessage | undefined;
  _pendingToolNames: Set<string>;
  _extensionRunner: ExtensionRunner;
  _baseSystemPromptOptions: NormalizedBuildSystemPromptOptions;
  _runSystemPromptOptions: BuildSystemPromptOptions | undefined;
  _queueFollowUp(text: string, images?: ImageContent[]): Promise<void>;
  _emitQueueUpdate(): void;
  _findLastAssistantMessage(): AssistantMessage | undefined;
  _findPersistedMessageEntryId(message: AgentMessage): string | undefined;
  _omitRecoveryAttempt(message: AssistantMessage): void;
  _recordSelection(): void;
  _resolveIdleWaitIfIdle(): void;
  _preparePromptAndToolLoadout(options: BuildSystemPromptOptions): SystemMessage | undefined;
  _refreshFinalizedContext(): void;
  _handlePostAgentRun(): Promise<boolean>;
  _runBeforeSettleBoundary(): Promise<boolean>;
  _finishCancelledRetry(): void;
  _flushPendingBashMessages(): void;
  _flushPendingCustomMessages(): void;
  _emitAgentSettled(): Promise<void>;
}
