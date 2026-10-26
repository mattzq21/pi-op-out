import { text } from './json';

/** A message pinned to the top of a chat. text is the first line of the message; it is empty for a prompt that has only attachments. */
export interface MessagePin { entryId: string; text: string }

export const PIN_LIMIT = 4;
const TEXT_LIMIT = 300;

/** The host parts that the pins use to find and reach the views of a chat. */
export interface PinViews {
  subscriptions: Map<string, { identity: string }>;
  readonlyViews(identity: string): string[];
  output(packet: any): void;
}

/** The pinned messages of each chat, by chat identity. They are kept only in daemon memory. */
export class MessagePins {
  private chats = new Map<string, MessagePin[]>();

  constructor(private host: PinViews) {}

  /** Runs pin_message or unpin_message from a view of the chat, then sends the new pins to all views of the chat. */
  command(identity: string, command: any): null {
    const entryId = text(command, 'entryId');
    if (!entryId) throw new Error('A pin needs a saved message');
    const pins = this.chats.get(identity) ?? [];
    let next: MessagePin[];
    if (command.type === 'pin_message') {
      if (typeof command.text !== 'string') throw new Error('A pin needs the message text');
      if (pins.some(pin => pin.entryId === entryId)) return null;
      if (pins.length >= PIN_LIMIT) throw new Error('Only ' + PIN_LIMIT + ' messages can be pinned. Unpin one first.');
      const line = command.text.split('\n').find((part: string) => part.trim())?.trim() ?? '';
      next = [...pins, { entryId, text: line.slice(0, TEXT_LIMIT) }];
    } else {
      next = pins.filter(pin => pin.entryId !== entryId);
      if (next.length === pins.length) return null;
    }
    if (next.length) this.chats.set(identity, next);
    else this.chats.delete(identity);
    for (const runtime of this.views(identity)) this.send(runtime, next);
    return null;
  }

  /** Sends the pins of the chat to a view that attached to it. */
  attached(runtime: string, identity: string): void { this.send(runtime, this.chats.get(identity) ?? []); }

  private views(identity: string): Set<string> {
    const runtimes = new Set(this.host.readonlyViews(identity));
    for (const [runtime, session] of this.host.subscriptions) if (session.identity === identity) runtimes.add(runtime);
    return runtimes;
  }

  private send(runtime: string, pins: MessagePin[]): void {
    this.host.output({ type: 'event', runtimeId: runtime, event: { type: 'pinned_messages', pins: structuredClone(pins) } });
  }
}
