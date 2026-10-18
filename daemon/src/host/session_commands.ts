import { flag, kind, text } from './json';
import { lockGate } from './lock_gate';
import * as Branching from './branching';
import type { Host } from './controller';
import type { Session } from './session';
import { HTML_PREVIEW_VIEWPORT_COMMAND } from '../../../extensions/piop-html-preview/interface';
import { ANSWER_QUESTION_COMMAND } from '../../../extensions/piop-user-questions/interface';

/** Runs a command from the view that owns the session. Commands that change the session check ownership first. */
export async function sessionCommand(host: Host, session: Session, runtime: string, command: any): Promise<any> {
  const client = text(host.attachments.get(runtime), 'clientId');
  const assertOwner = () => {
    if (host.readonlyMap.has(runtime) || host.subscriptions.get(runtime) !== session || !host.ownership().owns(session.identity, client, false)) {
      throw new Error('Session ownership changed; take ownership before changing it');
    }
  };
  if (!kind(command).startsWith('get_')) assertOwner();
  if (kind(command) === 'abort') return queueCommand(session, command, assertOwner);
  if (kind(command) === 'extension_ui_response') return answerDialog(host, session, runtime, command, assertOwner);
  if (!kind(command).startsWith('get_') || kind(command) === 'get_snapshot') await session.settings.reconcile(false);
  if (!kind(command).startsWith('get_')) {
    assertOwner();
    const error = session.settings.error();
    if (error !== null) throw new Error(error);
  }
  if (['fork', 'fork_after', 'clone', 'new_session', 'switch_session'].includes(kind(command))) return Branching.switchSession(host, session, runtime, command);
  if (typeof command?.clientHtmlPreviewSize === 'number') await session.raw({ type: HTML_PREVIEW_VIEWPORT_COMMAND, size: command.clientHtmlPreviewSize });
  return queueCommand(session, command, kind(command).startsWith('get_') ? undefined : assertOwner);
}

/** Sends a command through the session queue, after it turns prompts into steer or follow-up messages. */
export async function queueCommand(session: Session, original: any, assertOwner?: () => void): Promise<any> {
  assertOwner?.();
  const command = original;
  if (kind(command) === 'change_pending') return session.queue.changePending(text(command, 'id'), command.action ?? null, assertOwner);
  const message = text(command, 'message');
  const first = message.split(/\s+/).find(part => part) ?? '';
  if (first === '/goal' && Array.isArray(command.images) && command.images.length) throw new Error('Goals do not accept attachments. Remove the files and images before sending.');
  const review = first === '/review' || first === '/rs';
  if (kind(command) === 'prompt' && (!message.startsWith('/') || review) && !session.queue.held()) {
    command.type = !review && command.streamingBehavior === 'steer' ? 'steer' : 'follow_up';
  }
  return session.queue.command(command, assertOwner);
}

async function answerDialog(host: Host, session: Session, runtime: string, command: any, assertOwner: () => void): Promise<any> {
  const id = text(command, 'id');
  const release = await lockGate(host.dialogGates, session.epoch + ':' + id);
  try {
    assertOwner();
    const dialog = session.dialogs.get(id);
    if (!dialog || dialog.owner !== runtime) throw new Error('This question is no longer owned by this view. Reopen the conversation to refresh it.');
    if (typeof dialog.event?.asyncQuestion !== 'string') {
      await session.send(command);
      session.dialogs.resolve(id);
      return null;
    }
    const response = dialog.queuedResponse ?? session.queue.questionResponse(text(dialog.event, 'asyncQuestion'))
      ?? { type: ANSWER_QUESTION_COMMAND, requestId: dialog.event.asyncQuestion, value: command.value ?? null, cancelled: flag(command, 'cancelled') };
    session.dialogs.change(id, item => { item.answering = true; });
    try {
      const prepare = structuredClone(response);
      prepare.action = 'prepare';
      const prepared = await session.raw(prepare);
      assertOwner();
      if (typeof prepared?.message === 'string' && prepared.message && !dialog.answerQueued) {
        await session.queue.command({ type: session.working() ? 'steer' : 'follow_up', message: prepared.message, questionResponse: structuredClone(response) }, assertOwner);
        session.dialogs.change(id, item => { item.answerQueued = true; item.queuedResponse = structuredClone(response); });
      }
      const resolve = structuredClone(response);
      resolve.action = 'resolve';
      resolve.queueId = prepared?.queueId ?? null;
      assertOwner();
      await session.raw(resolve);
      return null;
    } finally { session.dialogs.change(id, item => { item.answering = false; }); }
  } finally { release(); }
}
