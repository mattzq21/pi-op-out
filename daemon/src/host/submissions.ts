import { readFileSync } from 'node:fs';
import * as Registry from '../session_registry';
import { CommandRefusedError } from '../pi_rejection';
import { errorText } from '../util/sync';
import type { Database } from '../util/db';

export type Outcome = { accepted: true } | { accepted: false; error: string };

const KEPT_MS = 30 * 24 * 3600 * 1000;

export class SubmissionLedger {
  private live = new Map<string, Promise<Outcome>>();

  constructor(private root: string, private diagnostic: (line: string) => void) {}

  recover(): void {
    this.use(db => {
      db.prepare('DELETE FROM submission_outcomes WHERE updated_at<?').run(Date.now() - KEPT_MS);
      const open = db.prepare("SELECT submission_id, session_id FROM submission_outcomes WHERE outcome='received'").all() as Array<{ submission_id: string; session_id: string }>;
      for (const row of open) this.store(db, row.submission_id, row.session_id, this.decide(db, row.submission_id, row.session_id, 'Piop stopped before it accepted the message'));
    });
  }

  async run(id: string, sessionId: string, work: () => Promise<any>, settle: () => Promise<void>): Promise<any> {
    const running = this.live.get(id);
    if (running) return this.repeat(await running);
    if (this.use(db => this.saved(db, id))?.accepted) return null;
    let finish!: (outcome: Outcome) => void;
    this.live.set(id, new Promise(resolve => { finish = resolve; }));
    let outcome: Outcome = { accepted: false, error: 'Piop could not record the message' };
    try {
      try { this.use(db => this.store(db, id, sessionId, null)); } catch (error) {
        outcome = { accepted: false, error: errorText(error) };
        throw new CommandRefusedError(outcome.error, 'daemon');
      }
      let result: any;
      try { result = await work(); } catch (error) {
        if (error instanceof CommandRefusedError) { outcome = { accepted: false, error: error.message }; throw error; }
        await settle();
        outcome = this.use(db => this.decide(db, id, sessionId, errorText(error)));
        if (!outcome.accepted) throw new CommandRefusedError(outcome.error, 'daemon');
        this.diagnostic('Message ' + id + ' was accepted, but its request failed: ' + errorText(error));
        return null;
      }
      outcome = result === false ? { accepted: false, error: 'Message was not submitted' } : { accepted: true };
      return result;
    } finally {
      const decided = outcome;
      try { this.use(db => this.store(db, id, sessionId, decided)); this.live.delete(id); }
      catch (error) { this.diagnostic('Could not record the outcome of message ' + id + ': ' + errorText(error)); }
      finish(decided);
    }
  }

  async outcome(id: string): Promise<Outcome> {
    const running = this.live.get(id);
    if (running) return running;
    return this.use(db => this.saved(db, id)) ?? { accepted: false, error: 'Piop did not receive this message' };
  }

  private repeat(outcome: Outcome): any {
    if (outcome.accepted) return null;
    throw new CommandRefusedError(outcome.error, 'daemon');
  }

  private saved(db: Database, id: string): Outcome | undefined {
    const row = db.prepare('SELECT session_id, outcome, error FROM submission_outcomes WHERE submission_id=?').get(id) as { session_id: string; outcome: string; error: string | null } | undefined;
    if (!row) return undefined;
    if (row.outcome === 'accepted') return { accepted: true };
    if (row.outcome === 'rejected') return { accepted: false, error: row.error ?? 'Message was not submitted' };
    const outcome = this.decide(db, id, row.session_id, 'Piop stopped before it accepted the message');
    this.store(db, id, row.session_id, outcome);
    return outcome;
  }

  private decide(db: Database, id: string, sessionId: string, error: string): Outcome {
    if (db.prepare("SELECT 1 FROM queue_items WHERE json_extract(details_json, '$.goalSubmissionId')=?").get(id)) return { accepted: true };
    const row = db.prepare('SELECT session_path FROM sessions WHERE session_id=?').get(sessionId) as { session_path: string | null } | undefined;
    let transcript = '';
    try { if (row?.session_path) transcript = readFileSync(row.session_path, 'utf8'); }
    catch (reason: any) { if (reason?.code !== 'ENOENT') throw reason; }
    return transcript.includes('"piopSubmissionId":' + JSON.stringify(id)) ? { accepted: true } : { accepted: false, error };
  }

  private store(db: Database, id: string, sessionId: string, outcome: Outcome | null): void {
    const state = outcome === null ? 'received' : outcome.accepted ? 'accepted' : 'rejected';
    const error = outcome && !outcome.accepted ? outcome.error : null;
    db.prepare('INSERT INTO submission_outcomes VALUES (?, ?, ?, ?, ?) ON CONFLICT(submission_id) DO UPDATE SET session_id=excluded.session_id, outcome=excluded.outcome, error=excluded.error, updated_at=excluded.updated_at')
      .run(id, sessionId, state, error, Date.now());
  }

  private use<T>(work: (db: Database) => T): T {
    return work(Registry.connection(this.root));
  }
}
