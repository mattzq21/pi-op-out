import { randomUUID } from 'node:crypto';
import { restore as restoreSaved, write as writeSaved } from '../../../resources/piop-storage/goals.cjs';
import { goalChangedPrompt, goalPrompt } from './prompts';
import type { GoalPlace } from './files';

export type GoalStatus = 'active' | 'complete';
export type Goal = { id: string; sessionId: string; objective: string; status: GoalStatus };

/** The goal prompt: a shown message that the model gets as a user message. Pi adds one each time the goal continues its work. */
export const GOAL_PROMPT = 'piop-goal-context';

/** A notice that the user changed the goal. It is saved where the change happened, and the model gets it there as a system message. */
const GOAL_CHANGE = 'piop-goal-change';

/** The tool that the agent sets the goal status with. */
export const GOAL_TOOL = 'update_goal_status';

/** A message that Piop adds to the conversation context. role system makes Pi give it to the model as a system message. */
export type ContextInsertion = { customType: string; content: string; display: boolean; details: Record<string, unknown> };

/**
 * The goal of one conversation. The conversation queue owns it: it reads the saved goal when the chat opens, so the chat shows it at once,
 * and saves each change before it reports it.
 */
export class QueueGoal {
  goal: Goal | null;
  /** True while the chat waits for the user's first message, for example a new branch. An active goal then cannot start. */
  waitingForInput: boolean;
  /** The objective that the model got last, in a goal prompt or an edit notice. Undefined until it gets one in this run of Pi. */
  private seen: string | undefined;
  /** The goal ID of each change notice that Pi did not add to the context yet, with the objective it gives. */
  private notices = new Map<string, string>();

  constructor(saved: { goal: Goal | null; waitingForInput: boolean } = { goal: null, waitingForInput: false }) {
    this.goal = saved.goal;
    this.waitingForInput = saved.goal !== null && saved.waitingForInput;
  }

  /** Reads the saved goal of the conversation at file. */
  static restore(file: string | undefined): QueueGoal {
    return new QueueGoal(file ? restoreSaved(file) : undefined);
  }

  /** The goal while it has a place in the queue: set and not complete. */
  live(): Goal | undefined { return this.goal && this.goal.status !== 'complete' ? this.goal : undefined; }

  require(): Goal {
    if (!this.goal) throw new Error('No goal is set for this conversation.');
    return this.goal;
  }

  /** A new active goal in place of the current one. */
  create(place: GoalPlace, objective: string, id: string = randomUUID()): Goal {
    return { id, sessionId: place.sessionId, objective, status: 'active' };
  }

  /** Saves next as the goal. Nothing changes when the save fails. */
  save(place: GoalPlace, next: Goal | null): void {
    if (next && next.sessionId !== place.sessionId) throw new Error('Goal belongs to another conversation');
    writeSaved(place.file, place.sessionId, next);
    this.goal = next && { ...next };
    if (!this.live()) this.waitingForInput = false;
  }

  /** The goal prompt for the next turn. The model gets the current objective with it. */
  prompt(): ContextInsertion {
    const goal = this.require();
    this.seen = goal.objective;
    return { customType: GOAL_PROMPT, content: goalPrompt(goal), display: true, details: { goalId: goal.id } };
  }

  /** A notice that the goal changed, saying text. The model gets the current objective with it. */
  notice(text: string): ContextInsertion {
    const id = randomUUID();
    if (this.goal) this.notices.set(id, this.goal.objective);
    return { customType: GOAL_CHANGE, content: text, display: false, details: { goalId: this.goal?.id, noticeId: id, contextRole: 'system' } };
  }

  /** Pi added a message to the context. A change notice gives the model the objective it names. */
  added(message: any): void {
    if (message?.role !== 'custom' || message.customType !== GOAL_CHANGE) return;
    const objective = this.notices.get(message.details?.noticeId);
    if (objective === undefined) return;
    this.notices.delete(message.details.noticeId);
    this.seen = objective;
  }

  /** The edit notice when the user changed the objective after the model got it, so the model has not seen the current objective. */
  unseenEdit(): string | undefined {
    if (!this.goal || this.seen === undefined || this.seen === this.goal.objective) return undefined;
    return goalChangedPrompt(this.goal) ?? undefined;
  }

  markSeen(): void { if (this.goal) this.seen = this.goal.objective; }

  /** The goal as the piop-goal status shows it to clients. */
  status(): any {
    return { type: 'extension_ui_request', id: randomUUID(), method: 'setStatus', statusKey: 'piop-goal', statusText: this.goal ? JSON.stringify(this.goal) : undefined };
  }
}
