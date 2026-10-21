import { kind, text } from './json';
import { lockGate } from './lock_gate';
import * as Branching from './branching';
import * as Contributions from '../plugin_contributions';
import type { Host } from './controller';
import type { Session } from './session';

/** Runs a command from the view that owns the session. Commands that change the session check ownership first. */
export async function sessionCommand(host: Host, session: Session, runtime: string, command: any): Promise<any> {
  Contributions.pluginRequest(kind(command));
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
  if (['fork', 'fork_after', 'copy_after', 'clone', 'new_session', 'switch_session'].includes(kind(command))) return Branching.switchSession(host, session, runtime, command);
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
  Contributions.assertCommandAvailable(message);
  const queued = Contributions.queuedCommand(message);
  if (kind(command) === 'prompt' && (!message.startsWith('/') || queued) && !session.queue.held()) {
    command.type = !queued && command.streamingBehavior === 'steer' ? 'steer' : 'follow_up';
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
    await session.send(command);
    session.dialogs.resolve(id);
    return null;
  } finally { release(); }
}
