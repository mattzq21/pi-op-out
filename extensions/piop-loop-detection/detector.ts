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

const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function validConfig(value: unknown): value is Config {
  const config = value as Config | undefined;

  return !!config && typeof config.enabled === "boolean" && integer(config.threshold, 3, 10) && integer(config.cooldownSeconds, 30, 3600);
}

function validEvidence(value: Evidence | EditEvidence) {
  return value && hash(value.key) && integer(value.count, 1, 1000) && integer(value.seq, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.at, 0, Number.MAX_SAFE_INTEGER) && typeof value.warned === "boolean";
}

function validWarning(value: Warning | undefined) {
  return value === undefined || (!!value && typeof value.text === "string" && value.text.length <= 512 && integer(value.remaining, 0, 3));
}

function validSnapshot(value: Snapshot) {
  return value.version === 1 && validConfig(value.config) && hash(value.scope) && hash(value.profile)
    && integer(value.seq, 0, Number.MAX_SAFE_INTEGER) && integer(value.lastWarningAt, 0, Number.MAX_SAFE_INTEGER)
    && integer(value.lastWarningSeq, -100, Number.MAX_SAFE_INTEGER) && validWarning(value.warning);
}

function validLists(value: Snapshot) {
  return Array.isArray(value.attempts) && value.attempts.length <= LIMIT && value.attempts.every(item => validEvidence(item) && hash(item.result))
    && Array.isArray(value.edits) && value.edits.length <= LIMIT && value.edits.every(item => validEvidence(item) && hash(item.before) && hash(item.after))
    && Array.isArray(value.information) && value.information.length <= LIMIT && value.information.every(hash);
}

export class LoopDetector {
  state: Snapshot;

  constructor(scope: string, profile: string) {
    this.state = { version: 1, config: defaults(), scope, profile, seq: 0, attempts: [], edits: [], information: [], lastWarningAt: 0, lastWarningSeq: -100 };
  }

  restore(value: unknown, now: number) {
    if (!value || typeof value !== "object") return;
    const saved = value as Snapshot;

    if (!validSnapshot(saved) || !validLists(saved)) return;
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

    if (!hash(change.before) || !hash(change.after) || typeof change.path !== "string") return;
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
