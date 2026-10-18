import { randomUUID } from 'node:crypto';
import { array, clone, flag, setEntry, text } from './json';

export interface Dialog {
  event: any;
  owner: string | null;
  generation: string;
  answering: boolean;
  answerQueued: boolean;
  queuedResponse: any | null;
}

export function interactive(event: any): boolean {
  return ['input', 'editor', 'select', 'confirm'].includes(event?.method);
}

function newDialog(event: any): Dialog {
  return { event, owner: null, generation: randomUUID(), answering: false, answerQueued: false, queuedResponse: null };
}

/** What the dialogs need from their session. */
export interface DialogSession {
  /** The session's views with their presence. */
  views(): Array<[string, any]>;
  readonly(runtime: string): boolean;
  /** False once the session closes or starts to stop. */
  accepting(): boolean;
  publish(event: any, target: string | null): void;
  publishState(): void;
  /** Called after a dialog is removed. */
  resolved(): void;
}

/** Dialogs and questions from Pi. Each dialog is shown in one visible view that can answer it. */
export class SessionDialogs {
  private items: Array<[string, Dialog]> = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private session: DialogSession) {}

  get(id: string): Dialog | undefined { const found = this.items.find(([key]) => key === id); return found ? { ...found[1] } : undefined; }
  change(id: string, change: (dialog: Dialog) => void): void { const found = this.items.find(([key]) => key === id); if (found) change(found[1]); }
  empty(): boolean { return this.items.length === 0; }
  /** True when a dialog needs an answer now, or an answer to a question is being sent. */
  blocking(): boolean { return this.items.some(([, dialog]) => typeof dialog.event?.asyncQuestion !== 'string' || dialog.answering); }
  /** True when a dialog waits for an answer. */
  waiting(): boolean { return this.items.some(([, dialog]) => !dialog.answering); }

  receive(event: any): void {
    if (!this.session.accepting()) return;
    const id = text(event, 'id');
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const dialog = newDialog(clone(event));
    setEntry(this.items, id, dialog);
    const timeout = event.timeout;
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0) {
      const generation = dialog.generation;
      this.timers.set(id, setTimeout(() => {
        if (this.get(id)?.generation === generation) this.resolve(id);
      }, Math.min(timeout, 2147483647)));
    }
    this.route();
  }

  /** Replaces the question dialogs with the questions that Pi still waits for. */
  receiveQuestions(requests: any): void {
    if (!Array.isArray(requests)) return;
    const ids = requests.map(request => 'question:' + text(request, 'id'));
    const removed = this.items.filter(([id, dialog]) => typeof dialog.event?.asyncQuestion === 'string' && !ids.includes(id)).map(([id]) => id);
    for (const id of removed) this.resolve(id);
    for (const request of requests) {
      const id = 'question:' + text(request, 'id');
      if (this.get(id)) continue;
      const questions = array(request, 'questions').map((question, index) => ({
        id: 'question_' + index, header: 'Question', question: question?.title ?? null,
        options: array(question, 'options').map(label => ({ label, description: '' })),
      }));
      const event = { type: 'extension_ui_request', id, method: 'input', title: '__piop_request_user_input__', asyncQuestion: request?.id ?? null, placeholder: JSON.stringify({ questions }) };
      setEntry(this.items, id, newDialog(event));
    }
    this.route();
  }

  /** Gives each dialog to the focused visible view, or else to a visible view. */
  route(): void {
    const views = this.session.views().filter(([runtime]) => !this.session.readonly(runtime));
    const events: Array<[string, any]> = [];
    const owner = (views.find(([, view]) => flag(view, 'visible') && flag(view, 'focused')) ?? views.find(([, view]) => flag(view, 'visible')))?.[0] ?? null;
    for (const [id, dialog] of this.items) {
      if (dialog.owner !== null && views.some(([view, presence]) => view === dialog.owner && flag(presence, 'visible'))) continue;
      const previous = dialog.owner;
      dialog.owner = null;
      if (previous !== null) events.push([previous, { type: 'extension_ui_resolved', id }]);
      dialog.owner = owner;
      if (owner !== null) events.push([owner, clone(dialog.event)]);
    }
    for (const [runtime, event] of events) this.session.publish(event, runtime);
    this.session.publishState();
  }

  resolve(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const count = this.items.length;
    this.items = this.items.filter(([key]) => key !== id);
    if (count === this.items.length) return;
    this.session.publish({ type: 'extension_ui_resolved', id }, null);
    this.session.publishState();
    this.session.resolved();
  }

  stopTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Drops all dialogs without telling the views. */
  clear(): void {
    this.stopTimers();
    this.items = [];
  }
}
