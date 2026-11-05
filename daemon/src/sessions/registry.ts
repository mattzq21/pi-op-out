import * as SessionTables from '../../resources/session-database/index.ts';

export function ids(root: string): string[] {
  return SessionTables.registeredSessionIds(root);
}

export function reserve(root: string): string {
  return SessionTables.reserveId(root);
}

// Gives back an identity that was reserved and not used for a saved chat.
export function releaseReservation(root: string, id: string): void {
  SessionTables.releaseReservedSession(root, id);
}

export function setTaskRunning(root: string, id: string, running: boolean): void {
  SessionTables.setRunningTask(root, id, running);
}

export function runningTasks(root: string): string[] {
  return SessionTables.runningTaskIds(root);
}
