import { clone, jsonEqual, kind, merge, setEntry, text } from './json';
import { assistantDelta } from './payload';

/** Messages and tool runs that Pi streams before it saves them to the transcript. */
export class LiveOutput {
  private messages: Array<[string, any]> = [];
  private tools: Array<[string, any]> = [];

  receive(event: any): void {
    switch (kind(event)) {
      case 'message_start': setEntry(this.messages, text(event.message, 'role'), clone(event.message ?? null)); break;
      case 'message_update': {
        const update = event.assistantMessageEvent;
        let next: any;
        if (update?.partial !== undefined && update.partial !== null) next = clone(update.partial);
        else if (event.message !== undefined && event.message !== null) next = clone(event.message);
        else {
          const live = this.messages.find(([role]) => role === 'assistant');
          if (live) { const message = live[1]; live[1] = null; next = assistantDelta(message, update ?? null); }
        }
        if (next !== undefined) {
          if (event.usage !== undefined) next.usage = clone(event.usage);
          const role = typeof next?.role === 'string' ? next.role : 'assistant';
          setEntry(this.messages, role, next);
        }
        break;
      }
      case 'message_end': {
        const message = event.message;
        this.messages = this.messages.filter(([role]) => message?.role !== role);
        break;
      }
      case 'tool_execution_start': case 'tool_execution_update': {
        const id = text(event, 'toolCallId');
        const found = this.tools.find(([key]) => key === id);
        const tool = found ? clone(found[1]) : {};
        merge(tool, clone(event));
        tool.type = 'tool_execution_start';
        setEntry(this.tools, id, tool);
        break;
      }
      case 'tool_execution_end': this.tools = this.tools.filter(([id]) => event.toolCallId !== id); break;
    }
  }

  clear(): void {
    this.messages = [];
    this.tools = [];
  }

  /** The payload of a running tool, or undefined when the tool is not running. */
  toolPayload(id: string): any | undefined {
    const live = this.tools.find(([key]) => key === id)?.[1];
    if (live === undefined) return undefined;
    const partial = live?.partialResult;
    const result = partial && typeof partial === 'object' && !Array.isArray(partial) ? clone(partial) : {};
    if (live?.args !== undefined) result.toolInput = clone(live.args);
    return result;
  }

  runningTools(): any[] { return this.tools.map(([, value]) => clone(value)); }

  /** Adds streamed messages that the saved history does not hold yet to its end. */
  addTo(history: any): void {
    for (const [, live] of this.messages) {
      const entries = Array.isArray(history?.entries) ? history.entries : [];
      if (!entries.some((entry: any) => jsonEqual(entry?.message?.role, live?.role) && jsonEqual(entry?.message?.timestamp, live?.timestamp))) {
        const id = 'live-' + text(live, 'role') + '-' + JSON.stringify(live?.timestamp ?? null);
        const message = clone(live);
        if (message && typeof message === 'object') message.streaming = live?.role === 'assistant';
        const entry = { type: 'message', id, parentId: history?.leafId ?? null, message };
        if (Array.isArray(history?.entries)) history.entries.push(entry);
        if (history && typeof history === 'object' && !Array.isArray(history)) history.leafId = id;
      }
    }
  }
}
