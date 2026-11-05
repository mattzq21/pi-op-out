import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import * as database from '../session-database.ts';
import { onMainThread } from '../main-thread.ts';
import * as stateRecords from './session-records.ts';
import * as goals from './goals.ts';
import * as auxiliaryCopies from './auxiliary-copies.ts';
import * as names from '../session-broker/session-names.ts';
import * as children from '../session-broker/session-child-index.ts';

// New chats: forks, branches, side chats, reviews, subagent and agent chats, and the copies of a fork's auxiliary chats.
// Their transcripts are written first. Then one transaction binds their reserved IDs and saves all that belongs to them:
// names, records, links to parents, goals and copied subagent runs. A stop before the commit leaves files that no
// session row has, and the start sweep removes them.

export interface NewChat { path: string; entries: any[]; name?: string; goalSource?: string }

export interface ForkRequest extends NewChat { source: string; cutoff?: string; cwd?: { from: string; to: string } }

const uuid = Type.String({ pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' });

const chatFields = {
  path: Type.String(),
  entries: Type.Array(Type.Object({ type: Type.String() }), { minItems: 1 }),
  name: Type.Optional(Type.String()),
  // The chat whose goal the new chat gets.
  goalSource: Type.Optional(uuid),
};

const chatSchema = Type.Object(chatFields, { additionalProperties: false });

const forkSchema = Type.Object({
  ...chatFields,
  // The chat that is forked. Its side chats, reviews and subagents made by cutoff are copied with the fork.
  source: uuid,
  cutoff: Type.Optional(Type.String()),
  // Copies that worked in from work in to.
  cwd: Type.Optional(Type.Object({ from: Type.String(), to: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });

const headerSchema = Type.Object({ type: Type.Literal('session'), id: uuid, cwd: Type.String(), timestamp: Type.String() });

function checked(root: string, chat: NewChat): NewChat {
  if (!Check(chatSchema, chat)) throw new Error('Invalid new chat');
  const header = chat.entries[0];

  if (!Check(headerSchema, header) || !path.isAbsolute(header.cwd)) throw new Error('A new chat needs a valid session header');
  const file = chat.path;

  if (!path.isAbsolute(file) || path.resolve(file) !== file || !path.basename(file).endsWith(`_${header.id}.jsonl`)) throw new Error('The path of a new chat must end with its ID');

  if (database.storageRoot(file) !== root) throw new Error('A new chat must be in the session storage of this daemon');

  if (chat.entries.some(stateRecords.isName)) throw new Error('A new chat gets its name from its name field, not from its entries');

  if (chat.name !== undefined) names.validName(chat.name);

  return chat;
}

function snapshots(file: string): string { return file.slice(0, -'.jsonl'.length) + '.snapshots'; }

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

// Writes the transcript in full to a new file, which appears at its path only when complete. Its snapshot folder holds
// the file while it is written.
function write(chat: NewChat): void {
  const folder = path.dirname(chat.path);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });

  if (fs.realpathSync(folder) !== folder) throw new Error('The folder of a new chat must not be a link');
  fs.mkdirSync(snapshots(chat.path), { recursive: true, mode: 0o700 });
  const temporary = path.join(snapshots(chat.path), 'new-chat.pending');
  const body = stateRecords.stored(chat.entries).map(entry => JSON.stringify(entry) + '\n').join('');

  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);

    try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.linkSync(temporary, chat.path);
  } finally { fs.rmSync(temporary, { force: true }); }
  fs.rmdirSync(snapshots(chat.path));
}

const commit = onMainThread('new-chats.commit', (root: string, chats: NewChat[], plan?: auxiliaryCopies.CopyPlan) => {
  database.transaction(root, 'IMMEDIATE', () => {
    for (const chat of chats) {
      const id = chat.entries[0].id;
      database.bind(root, id, chat.path);

      if (chat.name !== undefined) database.saveSessionName(root, id, chat.name, true);
      stateRecords.insertRecords(root, id, stateRecords.capture(chat.entries));

      if (chat.goalSource !== undefined) goals.copyGoal(root, chat.goalSource, id);
      children.register(root, id, chat.entries);
    }

    if (!plan) return;
    const sources = new Map([plan.ids[0], ...plan.copies.map(copy => [copy.sourceId, copy.sessionId] as [string, string])].map(([from, to]) => [to, from]));
    auxiliaryCopies.copySubagentRuns(root, plan, chats.map(chat => ({ sourceId: sources.get(chat.entries[0].id) as string, sessionId: chat.entries[0].id, entries: chat.entries })));
  });
});

// Gives back the reserved IDs that no saved chat uses.
const release = onMainThread('new-chats.release', (root: string, ids: string[]) => {
  for (const id of ids) database.releaseReservedSession(root, id);
});

function removeFiles(files: string[], error: Error): Error {
  for (const file of files) {
    try {
      fs.rmSync(snapshots(file), { recursive: true, force: true });
      fs.rmSync(file, { force: true });
    } catch (failure) { error.message += `; ${file} is removed at the next start: ${(failure as Error).message}`; }
  }

  return error;
}

// Saves chats (validated) with all that belongs to them, or nothing. plan is the copy plan of a fork.
function save(root: string, chats: NewChat[], plan?: auxiliaryCopies.CopyPlan): void {
  const written: string[] = [];

  try {
    for (const chat of chats) {
      if (fs.existsSync(chat.path) || fs.existsSync(snapshots(chat.path))) throw new Error('A new chat must not have files yet');
      written.push(chat.path);
      write(chat);
    }

    for (const folder of new Set(chats.map(chat => path.dirname(chat.path)))) syncDirectory(folder);
    commit(root, chats, plan);
  } catch (error) {
    const failure = removeFiles(written, error instanceof Error ? error : new Error(String(error)));

    try { release(root, chats.map(chat => chat.entries[0].id)); }
    catch (cleanup) { failure.message += `; its reserved IDs are given back at the next start: ${(cleanup as Error).message}`; }
    throw failure;
  }
}

// Saves one new chat.
function create(root: string, chat: NewChat): void {
  root = fs.realpathSync(root);
  save(root, [checked(root, chat)]);
}

// Saves a fork of the chat request.source, with copies of the side chats, reviews and subagents under it.
function fork(root: string, request: ForkRequest): void {
  root = fs.realpathSync(root);

  if (!Check(forkSchema, request)) throw new Error('Invalid fork');
  const { source, cutoff, cwd, ...fields } = request;
  const chat = checked(root, fields);

  if (!database.lookup(root, source)) throw new Error('The forked chat is not saved');
  const [header, ...history] = chat.entries;
  const plan = auxiliaryCopies.planAuxiliaryCopies({ root, sourceId: source, target: { id: header.id, path: chat.path }, cutoff, cwd });
  const retries = auxiliaryCopies.retryRecord(plan);
  const main: NewChat = { ...chat, entries: [header, ...auxiliaryCopies.rewriteForkHistory(history, plan), ...retries ? [retries] : []] };
  const copies = plan.copies.map(copy => checked(root, { path: copy.sessionPath, entries: copy.entries, ...copy.name === undefined ? {} : { name: copy.name }, goalSource: copy.sourceId }));

  save(root, [main, ...copies], copies.length ? plan : undefined);
}

// The requests of Pi's storage channel.
const OPERATIONS = {
  create: (root: string, request: NewChat) => { create(root, request); return null; },
  fork: (root: string, request: ForkRequest) => { fork(root, request); return null; },
};

export { create, fork, OPERATIONS };
