import { randomUUID } from 'node:crypto';
import { clone, flag, setEntry, text } from './json';

export interface Dialog {
  event: any;
  owner: string | null;
  generation: string;
}

export function interactive(event: any): boolean {
  return ['input', 'editor', 'select', 'confirm'].includes(event?.method);
}

function newDialog(event: any): Dialog {
  return { event, owner: null, generation: randomUUID() };
}

export interface DialogSession {
  views(): Array<[string, any]>;
  readonly(runtime: string): boolean;
  accepting(): boolean;
  publish(event: any, target: string | null): void;
  publishState(): void;
  resolved(): void;
}

export class SessionDialogs {
  private items: Array<[string, Dialog]> = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private asked = new Map<string, (answer: any) => void>();

  constructor(private session: DialogSession) {}

  get(id: string): Dialog | undefined { const found = this.items.find(([key]) => key === id); return found ? { ...found[1] } : undefined; }
  empty(): boolean { return this.items.length === 0; }

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

  ask(request: any): Promise<any> {
    if (!this.session.accepting()) return Promise.resolve({ cancelled: true });
    const id = randomUUID();
    return new Promise(resolve => {
      this.asked.set(id, resolve);
      this.receive({ ...clone(request), type: 'extension_ui_request', id });
    });
  }

  answer(id: string, answer: any): boolean {
    const resolve = this.asked.get(id);
    if (!resolve) return false;
    this.asked.delete(id);
    resolve(clone(answer));
    return true;
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

  clear(): void {
    this.stopTimers();
    this.items = [];
    for (const resolve of this.asked.values()) resolve({ cancelled: true });
    this.asked.clear();
  }
}
