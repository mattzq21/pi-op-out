import type { ChatMessage, ContentPart } from '../types';
import type { AssistantEvent } from './messageSchemas';

const MAX_CONTENT_INDEX_GAP = 8;

const MAX_CONTENT_PARTS = 64;

function validIndex(index: number | undefined): index is number {
  return Number.isInteger(index) && index !== undefined && index >= 0;
}

function contentAt(message: ChatMessage, index: number) {
  const content: ContentPart[] = Array.isArray(message.content) ? [...message.content] : message.content ? [{ type: 'text', text: message.content }] : [];

  if (index > content.length + MAX_CONTENT_INDEX_GAP || index >= MAX_CONTENT_PARTS) return;

  while (content.length <= index) {
    if (content.length >= MAX_CONTENT_PARTS) return;
    content.push({ type: 'text', text: '' });
  }

  return content;
}

function toolCall(current: ContentPart, event: AssistantEvent, index: number): Extract<ContentPart, { type: 'toolCall' }> {
  return current?.type === 'toolCall' ? current : { type: 'toolCall', id: event.id || `tool-${index}`, name: event.toolName || 'tool', arguments: {}, partialArgs: '' };
}

function finishToolCall(current: ContentPart, event: AssistantEvent, index: number): ContentPart {
  if (!event.toolCall) return current;
  const tool = toolCall(current, event, index);

  return { type: 'toolCall', id: event.toolCall.id || tool.id, name: event.toolCall.name || tool.name, arguments: {} };
}

type AssistantEventHandler = (current: ContentPart, event: AssistantEvent, index: number) => ContentPart;

const handlers = new Map<string, AssistantEventHandler>(Object.entries({
  text_start: () => ({ type: 'text', text: '' }),
  text_delta: (current, event) => ({ type: 'text', text: `${current?.type === 'text' ? current.text : ''}${event.delta || ''}` }),
  text_end: (_, event) => ({ type: 'text', text: event.content || '' }),
  thinking_start: () => ({ type: 'thinking', thinking: '' }),
  thinking_delta: (current, event) => ({ type: 'thinking', thinking: `${current?.type === 'thinking' ? current.thinking : ''}${event.delta || ''}` }),
  thinking_end: (_, event) => ({ type: 'thinking', thinking: event.content || '' }),
  toolcall_start: toolCall,
  toolcall_delta: toolCall,
  toolcall_end: finishToolCall,
} satisfies Record<string, AssistantEventHandler>));

export function applyAssistantMessageEvent(message: ChatMessage, event: AssistantEvent): ChatMessage {

  if (!validIndex(event.contentIndex)) return message;
  const content = contentAt(message, event.contentIndex);

  if (!content) return message;

  const handler = handlers.get(event.type ?? "");

  if (handler) content[event.contentIndex] = handler(content[event.contentIndex], event, event.contentIndex);

  return { ...message, content, streaming: true };
}
