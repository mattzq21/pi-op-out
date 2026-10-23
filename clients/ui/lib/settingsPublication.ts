import type { SettingsChange } from "../types";

export class SettingsPublication {
  private latest = new Map<string, { revision: number; phaseRevision: number }>();
  private serial = 0;

  generation() { return this.serial; }

  accept(change: SettingsChange, host = "local") {
    if (change.revision === undefined) { this.serial++;

    return true; }

    const key = JSON.stringify([host, change.source ?? "legacy"]);
    const previous = this.latest.get(key);

    if (previous && change.revision < previous.revision) return false;

    const phaseRevision = change.phaseRevision ?? 0;

    if (previous?.revision === change.revision && phaseRevision < previous.phaseRevision) return false;
    this.latest.set(key, { revision: change.revision, phaseRevision });
    this.serial++;

    return true;
  }
}
