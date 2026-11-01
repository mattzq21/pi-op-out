import { randomUUID } from 'node:crypto';
import { restore as restoreSaved, write as writeSaved } from '../../../resources/piop-storage/goals.cjs';
import { goalChangedPrompt, goalPrompt } from './prompts';
import type { GoalPlace } from './files';

export type GoalStatus = 'active' | 'complete';
export type Goal = { id: string; sessionId: string; objective: string; status: GoalStatus };

export const GOAL_PROMPT = 'piop-goal-context';

const GOAL_CHANGE = 'piop-goal-change';

export const GOAL_TOOL = 'update_goal_status';

export type ContextInsertion = { customType: string; content: string; display: boolean; details: Record<string, unknown> };

export class QueueGoal {
  goal: Goal | null;
  waitingForInput: boolean;
  private seen: string | undefined;
  private notices = new Map<string, string>();

  constructor(saved: { goal: Goal | null; waitingForInput: boolean } = { goal: null, waitingForInput: false }) {
    this.goal = saved.goal;
    this.waitingForInput = saved.goal !== null && saved.waitingForInput;
  }

  static restore(file: string | undefined): QueueGoal {
    return new QueueGoal(file ? restoreSaved(file) : undefined);
  }

  live(): Goal | undefined { return this.goal && this.goal.status !== 'complete' ? this.goal : undefined; }

  require(): Goal {
    if (!this.goal) throw new Error('No goal is set for this conversation.');
    return this.goal;
  }

  create(place: GoalPlace, objective: string, id: string = randomUUID()): Goal {
    return { id, sessionId: place.sessionId, objective, status: 'active' };
  }

  save(place: GoalPlace, next: Goal | null): void {
    if (next && next.sessionId !== place.sessionId) throw new Error('Goal belongs to another conversation');
    writeSaved(place.file, place.sessionId, next);
    this.goal = next && { ...next };
    if (!this.live()) this.waitingForInput = false;
  }

  prompt(): ContextInsertion {
    const goal = this.require();
    this.seen = goal.objective;
    return { customType: GOAL_PROMPT, content: goalPrompt(goal), display: true, details: { goalId: goal.id } };
  }

  notice(text: string): ContextInsertion {
    const id = randomUUID();
    if (this.goal) this.notices.set(id, this.goal.objective);
    return { customType: GOAL_CHANGE, content: text, display: false, details: { goalId: this.goal?.id, noticeId: id, contextRole: 'system' } };
  }

  added(message: any): void {
    if (message?.role !== 'custom' || message.customType !== GOAL_CHANGE) return;
    const objective = this.notices.get(message.details?.noticeId);
    if (objective === undefined) return;
    this.notices.delete(message.details.noticeId);
    this.seen = objective;
  }

  unseenEdit(): string | undefined {
    if (!this.goal || this.seen === undefined || this.seen === this.goal.objective) return undefined;
    return goalChangedPrompt(this.goal) ?? undefined;
  }

  markSeen(): void { if (this.goal) this.seen = this.goal.objective; }

  status(): any {
    return { type: 'extension_ui_request', id: randomUUID(), method: 'setStatus', statusKey: 'piop-goal', statusText: this.goal ? JSON.stringify(this.goal) : undefined };
  }
}
