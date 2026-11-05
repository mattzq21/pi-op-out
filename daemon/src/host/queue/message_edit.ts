import { clone, text } from '../json';
import * as Contributions from '../../plugins';
import { enqueue } from './submission';
import { goalArgument } from '../goals/commands';
import type { QueueDelivery } from './delivery';
import type { QueueGate } from './gate';

export interface MessageEdit { entryId: string; message: string; keepImages: number[] }

export function messageEdit(command: any): MessageEdit {
  const entryId = text(command, 'entryId');
  if (!entryId) throw new Error('Select a message to edit.');
  const message = command.message;
  if (typeof message !== 'string') throw new Error('The edited message must be text.');
  const keep: unknown = command.keepImages ?? [];
  if (!Array.isArray(keep) || keep.some(index => !Number.isInteger(index) || index < 0) || new Set(keep).size !== keep.length) throw new Error('The edited message keeps an image that the message does not have.');
  if (!message.trim() && !keep.length) throw new Error('The edited message cannot be empty.');
  if (goalArgument(message) !== undefined) throw new Error('A goal cannot replace a sent message. Send /goal as a new message.');
  Contributions.assertCommandAvailable(message);
  return { entryId, message, keepImages: keep };
}

export async function editMessage(queue: QueueDelivery, gate: QueueGate, edit: MessageEdit, assertOwner: () => void): Promise<any> {
  const release = await gate.lock();
  try {
    assertOwner();
    if (queue.runsAtOnce(edit.message) || Contributions.queuedCommand(edit.message)) throw new Error('A command cannot replace a sent message. Send it as a new message.');
    if (queue.state.pending.length) throw new Error('Wait for the queued messages to be sent first.');
    if (queue.state.queuedGoal()) throw new Error('Clear the goal before you edit a sent message.');
    const rewound = await queue.execute({ type: 'rewind_message', entryId: edit.entryId, keep: edit.keepImages });
    if (rewound?.cancelled !== false) return { cancelled: true };
    const images = Array.isArray(rewound.images) ? clone(rewound.images) : [];
    return await enqueue(queue, { message: edit.message, ...images.length ? { images } : {} }, 'follow_up');
  } finally { release(); }
}
