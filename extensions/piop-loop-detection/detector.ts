import { Type } from "typebox";
import { Check } from "typebox/value";
import { digest, type Observation, type Outcome } from "./observations.ts";

export const LIMIT = 32;

const MAX_AGE = 15 * 60 * 1000;

const MAX_GAP = 24;

export type Config = { enabled: boolean; threshold: number; cooldownSeconds: number };

type Evidence = { key: string; result: string; count: number; seq: number; at: number; warned: boolean };

type EditEvidence = { key: string; before: string; after: string; count: number; seq: number; at: number; warned: boolean };

type Warning = { text: string; remaining: number };

export type Snapshot = {
  version: 1; config: Config; scope: string; profile: string; seq: number;
  attempts: Evidence[]; edits: EditEvidence[]; information: string[];
  lastWarningAt: number; lastWarningSeq: number; warning?: Warning;
};

export type FileChange = { path: string; before: string; after: string };

export const defaults = (): Config => ({ enabled: false, threshold: 4, cooldownSeconds: 120 });

const integer = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) => Type.Integer({ minimum, maximum });

const hashSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const configSchema = Type.Object({ enabled: Type.Boolean(), threshold: integer(3, 10), cooldownSeconds: integer(30, 3600) });

const evidenceProperties = { key: hashSchema, count: integer(1, 1000), seq: integer(0), at: integer(0), warned: Type.Boolean() };

export const snapshotSchema = Type.Object({
  version: Type.Literal(1), config: configSchema, scope: hashSchema, profile: hashSchema, seq: integer(0),
  attempts: Type.Array(Type.Object({ ...evidenceProperties, result: hashSchema }), { maxItems: LIMIT }),
  edits: Type.Array(Type.Object({ ...evidenceProperties, before: hashSchema, after: hashSchema }), { maxItems: LIMIT }),
  information: Type.Array(hashSchema, { maxItems: LIMIT }), lastWarningAt: integer(0), lastWarningSeq: integer(-100),
  warning: Type.Optional(Type.Object({ text: Type.String({ maxLength: 512 }), remaining: integer(0, 3) })),
});

const fileChangeSchema = Type.Object({ path: Type.String(), before: hashSchema, after: hashSchema });

export function validConfig(value: unknown): value is Config { return Check(configSchema, value); }

export class LoopDetector {
  state: Snapshot;

  constructor(scope: string, profile: string) {
    this.state = { version: 1, config: defaults(), scope, profile, seq: 0, attempts: [], edits: [], information: [], lastWarningAt: 0, lastWarningSeq: -100 };
  }

  restore(saved: Snapshot | undefined, now: number) {
    if (!Check(snapshotSchema, saved)) return;
    this.state.config = { ...saved.config };

    if (saved.scope !== this.state.scope || saved.profile !== this.state.profile) return;
    this.state = structuredClone(saved);
    this.state.lastWarningSeq = Math.min(this.state.seq, this.state.lastWarningSeq);

    if (this.state.lastWarningAt > now) this.state.lastWarningAt = 0;
    this.prune(now);

    if (now - saved.lastWarningAt > MAX_AGE || saved.lastWarningAt > now) this.state.warning = undefined;
  }

  reset() {
    this.state.attempts = []; this.state.edits = []; this.state.information = []; this.state.warning = undefined;
  }

  private prune(now: number) {
    const fresh = (item: Evidence | EditEvidence) => item.at <= now && now - item.at <= MAX_AGE && item.seq <= this.state.seq && this.state.seq - item.seq <= MAX_GAP;
    this.state.attempts = this.state.attempts.filter(fresh).slice(-LIMIT);
    this.state.edits = this.state.edits.filter(fresh).slice(-LIMIT);

    if (now - this.state.lastWarningAt > MAX_AGE) this.state.warning = undefined;
  }

  advance(now: number) { this.state.seq++; this.prune(now); }

  expire(now: number) { this.prune(now); }

  private progress() {
    this.state.attempts = []; this.state.warning = undefined;
  }

  private learn(result: string) {
    if (this.state.information.includes(result)) return;
    this.state.information = [...this.state.information, result].slice(-LIMIT);
    this.state.attempts = this.state.attempts.filter(item => --item.count > 0);
    this.state.warning = undefined;
  }

  private warn(item: Evidence | EditEvidence, text: string, now: number): string | undefined {
    const state = this.state;

    if (item.warned || now - state.lastWarningAt < state.config.cooldownSeconds * 1000 || state.seq - state.lastWarningSeq < 12) return;
    item.warned = true; state.lastWarningAt = now; state.lastWarningSeq = state.seq;
    state.warning = { text: text.slice(0, 512), remaining: 3 };

    return state.warning.text;
  }

  observe(action: Observation, result: Outcome, now: number): string | undefined {
    if (!this.state.config.enabled) return;
    const previous = this.state.attempts.find(item => item.key === action.key);

    if (!result.failed && action.kind === "command") {
      if (previous) this.progress();

      return;
    }

    if (action.kind === "read") { if (!result.failed) this.learn(result.fingerprint);

    return; }

    return this.repeat(action, result, previous, now);
  }

  private repeat(action: Observation, result: Outcome, previous: Evidence | undefined, now: number) {
    if (!result.failed && previous?.result !== result.fingerprint) this.learn(result.fingerprint);
    const count = previous?.result === result.fingerprint ? Math.min(1000, previous.count + 1) : 1;
    const item: Evidence = { key: action.key, result: result.fingerprint, count, seq: this.state.seq, at: now, warned: previous?.result === result.fingerprint && previous.warned === true };
    this.state.attempts = [...this.state.attempts.filter(entry => entry.key !== action.key), item].slice(-LIMIT);

    if (count < this.state.config.threshold) return;
    const issue = result.failed ? "has failed with the same result" : "has repeated with no new information";

    return this.warn(item, `${action.label} ${issue} ${count} times.`, now);
  }

  change(change: FileChange, now: number): string | undefined {
    if (!this.state.config.enabled || change.before === change.after) return;

    if (!Check(fileChangeSchema, change)) return;
    const item = this.recordEdit(change, now);

    if (item.count === 1) this.progress();

    if (item.count < Math.max(4, this.state.config.threshold)) return;

    return this.warn(item, `File ${JSON.stringify(change.path.slice(-160))} has alternated between the same two contents across ${item.count} edits.`, now);
  }

  private recordEdit(change: FileChange, now: number) {
    const key = digest(change.path);
    const previous = this.state.edits.find(item => item.key === key);
    const reversal = previous?.after === change.before && previous.before === change.after;
    const item: EditEvidence = { key, before: change.before, after: change.after, count: reversal ? Math.min(1000, previous.count + 1) : 1, at: now, seq: this.state.seq, warned: reversal && previous.warned };
    this.state.edits = [...this.state.edits.filter(entry => entry.key !== key), item].slice(-LIMIT);

    return item;
  }
}
