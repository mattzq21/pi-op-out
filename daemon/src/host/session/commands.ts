import { kind, text } from '../json';
import * as Branching from '../chats';
import * as Contributions from '../../plugins';
import { goalSubmission } from '../goals';
import { messageEdit } from '../queue';
import type { Host } from '../controller';
import type { Session } from './session';

export async function sessionCommand(host: Host, session: Session, runtime: string, command: any): Promise<any> {
  const submission = ['prompt', 'steer', 'follow_up', 'compact'].includes(kind(command)) ? text(command, 'goalSubmissionId') : '';
  if (!submission) return runSessionCommand(host, session, runtime, command);
  if (kind(command) === 'compact') delete command.goalSubmissionId;
  return host.submissions.run(submission, session.identity, () => runSessionCommand(host, session, runtime, command), () => session.settled());
}

async function runSessionCommand(host: Host, session: Session, runtime: string, command: any): Promise<any> {
  Contributions.pluginRequest(kind(command));
  const client = text(host.views.request(runtime), 'clientId');
  const assertOwner = () => {
    if (host.readonly(runtime) || host.views.session(runtime) !== session || !host.ownership().owns(session.identity, client, false)) {
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
  if (['fork', 'fork_after', 'copy_after', 'clone', 'new_session', 'switch_session'].includes(kind(command))) return Branching.switchSession(host, session, runtime, command);
  return queueCommand(session, command, kind(command).startsWith('get_') ? undefined : assertOwner);
}

export async function queueCommand(session: Session, original: any, assertOwner?: () => void): Promise<any> {
  assertOwner?.();
  const command = original;
  if (kind(command) === 'change_pending') return session.queue.changePending(text(command, 'id'), command.action ?? null, assertOwner);
  if (kind(command) === 'edit_message') return session.queue.editMessage(messageEdit(command), assertOwner);
  const message = text(command, 'message');
  const first = message.split(/\s+/).find(part => part) ?? '';
  if (first === '/goal' && Array.isArray(command.images) && command.images.length) throw new Error('Goals do not accept attachments. Remove the files and images before sending.');
  Contributions.assertCommandAvailable(message);
  const queued = Contributions.queuedCommand(message);
  const goal = goalSubmission(command);
  if (kind(command) === 'prompt' && (!message.startsWith('/') || queued || goal)) {
    command.type = !queued && !goal && command.streamingBehavior === 'steer' ? 'steer' : 'follow_up';
  }
  return session.queue.command(command, assertOwner);
}

async function answerDialog(host: Host, session: Session, runtime: string, command: any, assertOwner: () => void): Promise<any> {
  const id = text(command, 'id');
  const release = await host.lockDialog(session.epoch + ':' + id);
  try {
    assertOwner();
    const dialog = session.dialogs.get(id);
    if (!dialog || dialog.owner !== runtime) throw new Error('This question is no longer owned by this view. Reopen the conversation to refresh it.');
    if (!session.dialogs.answer(id, command)) await session.send(command);
    session.dialogs.resolve(id);
    return null;
  } finally { release(); }
}
