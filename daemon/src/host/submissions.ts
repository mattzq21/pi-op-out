import { readFileSync } from 'node:fs';
import { isGoalSubmissionQueued, lookup, pruneSubmissionOutcomes, receivedSubmissions, saveSubmissionOutcome, submissionOutcome } from '../../resources/session-database/index.ts';
import { CommandRefusedError } from '../pi_rejection';
import { errorText } from '../util/sync';

export type Outcome = { accepted: true } | { accepted: false; error: string };

const KEPT_MS = 30 * 24 * 3600 * 1000;

export class SubmissionLedger {
  private live = new Map<string, Promise<Outcome>>();

  constructor(private root: string, private diagnostic: (line: string) => void) {}

  recover(): void {
    pruneSubmissionOutcomes(this.root, Date.now() - KEPT_MS);
    for (const row of receivedSubmissions(this.root)) this.store(row.submission_id, row.session_id, this.decide(row.submission_id, row.session_id, 'Piop stopped before it accepted the message'));
  }

  async run(id: string, sessionId: string, work: () => Promise<any>, settle: () => Promise<void>): Promise<any> {
    const running = this.live.get(id);
    if (running) return this.repeat(await running);
    if (this.saved(id)?.accepted) return null;
    let finish!: (outcome: Outcome) => void;
    this.live.set(id, new Promise(resolve => { finish = resolve; }));
    let outcome: Outcome = { accepted: false, error: 'Piop could not record the message' };
    try {
      try { this.store(id, sessionId, null); } catch (error) {
        outcome = { accepted: false, error: errorText(error) };
        throw new CommandRefusedError(outcome.error, 'daemon');
      }
      let result: any;
      try { result = await work(); } catch (error) {
        if (error instanceof CommandRefusedError) { outcome = { accepted: false, error: error.message }; throw error; }
        await settle();
        outcome = this.decide(id, sessionId, errorText(error));
        if (!outcome.accepted) throw new CommandRefusedError(outcome.error, 'daemon');
        this.diagnostic('Message ' + id + ' was accepted, but its request failed: ' + errorText(error));
        return null;
      }
      outcome = result === false ? { accepted: false, error: 'Message was not submitted' } : { accepted: true };
      return result;
    } finally {
      const decided = outcome;
      try { this.store(id, sessionId, decided); this.live.delete(id); }
      catch (error) { this.diagnostic('Could not record the outcome of message ' + id + ': ' + errorText(error)); }
      finish(decided);
    }
  }

  async outcome(id: string): Promise<Outcome> {
    const running = this.live.get(id);
    if (running) return running;
    return this.saved(id) ?? { accepted: false, error: 'Piop did not receive this message' };
  }

  private repeat(outcome: Outcome): any {
    if (outcome.accepted) return null;
    throw new CommandRefusedError(outcome.error, 'daemon');
  }

  private saved(id: string): Outcome | undefined {
    const row = submissionOutcome(this.root, id);
    if (!row) return undefined;
    if (row.outcome === 'accepted') return { accepted: true };
    if (row.outcome === 'rejected') return { accepted: false, error: row.error ?? 'Message was not submitted' };
    const outcome = this.decide(id, row.session_id, 'Piop stopped before it accepted the message');
    this.store(id, row.session_id, outcome);
    return outcome;
  }

  private decide(id: string, sessionId: string, error: string): Outcome {
    if (isGoalSubmissionQueued(this.root, id)) return { accepted: true };
    const path = lookup(this.root, sessionId);
    let transcript = '';
    try { if (path) transcript = readFileSync(path, 'utf8'); }
    catch (reason: any) { if (reason?.code !== 'ENOENT') throw reason; }
    return transcript.includes('"piopSubmissionId":' + JSON.stringify(id)) ? { accepted: true } : { accepted: false, error };
  }

  private store(id: string, sessionId: string, outcome: Outcome | null): void {
    const state = outcome === null ? 'received' : outcome.accepted ? 'accepted' : 'rejected';
    const error = outcome && !outcome.accepted ? outcome.error : null;
    saveSubmissionOutcome(this.root, id, sessionId, state, error);
  }
}
