import { text } from './json';
import type { HostEvents } from './events';

export interface MessagePin { entryId: string; role: 'prompt' | 'response'; text: string; timestamp: number }

export const PIN_LIMIT = 4;
const TEXT_LIMIT = 300;

export interface PinViews {
  readonly views: { runtimesOf(identity: string): Set<string> };
  readonly events: HostEvents;
}

export class MessagePins {
  private chats = new Map<string, MessagePin[]>();

  constructor(private host: PinViews) {}

  command(identity: string, command: any): null {
    const entryId = text(command, 'entryId');
    if (!entryId) throw new Error('A pin needs a saved message');
    const pins = this.chats.get(identity) ?? [];
    let next: MessagePin[];
    if (command.type === 'pin_message') {
      if (typeof command.text !== 'string') throw new Error('A pin needs the message text');
      if (command.role !== 'prompt' && command.role !== 'response') throw new Error('A pin is for a prompt or a response');
      if (typeof command.timestamp !== 'number' || !Number.isFinite(command.timestamp)) throw new Error('A pin needs the time of the message');
      if (pins.some(pin => pin.entryId === entryId)) return null;
      if (pins.length >= PIN_LIMIT) throw new Error('Only ' + PIN_LIMIT + ' messages can be pinned. Unpin one first.');
      const line = command.text.split('\n').find((part: string) => part.trim())?.trim() ?? '';
      const pin = { entryId, role: command.role, text: line.slice(0, TEXT_LIMIT), timestamp: command.timestamp };
      const index = pins.findIndex(other => other.timestamp > pin.timestamp);
      next = index < 0 ? [...pins, pin] : [...pins.slice(0, index), pin, ...pins.slice(index)];
    } else {
      next = pins.filter(pin => pin.entryId !== entryId);
      if (next.length === pins.length) return null;
    }
    if (next.length) this.chats.set(identity, next);
    else this.chats.delete(identity);
    for (const runtime of this.views(identity)) this.send(runtime, next);
    return null;
  }

  attached(runtime: string, identity: string): void { this.send(runtime, this.chats.get(identity) ?? []); }

  private views(identity: string): Set<string> { return this.host.views.runtimesOf(identity); }

  private send(runtime: string, pins: MessagePin[]): void {
    this.host.events.runtimeEvent(runtime, { type: 'pinned_messages', pins: structuredClone(pins) });
  }
}
