import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connection } from '../../../daemon/resources/session-database/core.cjs';
import { CommandRefusedError } from '../../../daemon/src/pi_rejection';
import { SubmissionLedger } from '../../../daemon/src/host/submissions';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function ledger() {
  const root = mkdtempSync(join(tmpdir(), 'piop-submissions-'));
  roots.push(root);
  const lines: string[] = [];
  return { root, lines, ledger: new SubmissionLedger(root, line => lines.push(line)) };
}

function session(root: string, id: string, transcript?: string) {
  const path = join(root, id + '.jsonl');
  if (transcript !== undefined) writeFileSync(path, transcript);
  connection(root).prepare('INSERT INTO sessions VALUES (?, ?)').run(id, path);
}

const settled = () => Promise.resolve();

test('a refused message and an accepted one keep their outcome', async () => {
  const { ledger: sent } = ledger();
  await expect(sent.run('refused', 's', () => Promise.reject(new CommandRefusedError('No model')), settled)).rejects.toThrow('No model');
  expect(await sent.run('accepted', 's', () => Promise.resolve({ disposition: 'started' }), settled)).toEqual({ disposition: 'started' });
  expect(await sent.outcome('refused')).toEqual({ accepted: false, error: 'No model' });
  expect(await sent.outcome('accepted')).toEqual({ accepted: true });
  expect(await sent.outcome('unknown')).toEqual({ accepted: false, error: 'Piop did not receive this message' });
});

test('a failed request is decided by the saved transcript, after Pi stopped', async () => {
  const { root, lines, ledger: sent } = ledger();
  session(root, 's', JSON.stringify({ type: 'message', message: { role: 'user', content: 'Hi', piopSubmissionId: 'kept' } }) + '\n');
  let stopped = false;
  const stop = async () => { stopped = true; };
  expect(await sent.run('kept', 's', async () => { expect(stopped).toBe(false); throw new Error('Pi command timed out'); }, stop)).toBeNull();
  expect(stopped).toBe(true);
  expect(lines).toEqual(['Message kept was accepted, but its request failed: Pi command timed out']);
  const lost = sent.run('lost', 's', () => Promise.reject(new Error('Pi command timed out')), stop);
  await expect(lost).rejects.toBeInstanceOf(CommandRefusedError);
  expect(await sent.outcome('kept')).toEqual({ accepted: true });
  expect(await sent.outcome('lost')).toEqual({ accepted: false, error: 'Pi command timed out' });
});

test('the outcome waits while the message is being sent, and a repeat does not run it again', async () => {
  const { ledger: sent } = ledger();
  let finish!: () => void; let runs = 0;
  const running = sent.run('slow', 's', () => { runs += 1; return new Promise(resolve => { finish = () => resolve(null); }); }, settled);
  const outcome = sent.outcome('slow');
  const repeat = sent.run('slow', 's', async () => { runs += 1; }, settled);
  finish();
  await running;
  expect(await outcome).toEqual({ accepted: true });
  expect(await repeat).toBeNull();
  expect(runs).toBe(1);
});

test('a message left without an outcome by a stopped daemon is accepted only when the saved queue holds it', async () => {
  const { root } = ledger();
  session(root, 's');
  const db = connection(root);
  for (const id of ['queued', 'dropped']) db.prepare("INSERT INTO submission_outcomes VALUES (?, 's', 'received', NULL, ?)").run(id, Date.now());
  db.prepare("INSERT INTO queue_items VALUES (1, 's', 1, 'Hi', 'followUp', ?)").run(JSON.stringify({ goalSubmissionId: 'queued' }));
  const next = new SubmissionLedger(root, () => {});
  next.recover();
  expect(await next.outcome('queued')).toEqual({ accepted: true });
  expect(await next.outcome('dropped')).toEqual({ accepted: false, error: 'Piop stopped before it accepted the message' });
});
