import type { SessionSummary } from "../types";

const rowKey = (session: SessionSummary) => `${session.hostId ?? "local"}:${session.id}`;

// The next chat list, with the row objects that did not change kept, so that only the changed rows render again.
// Gives the previous list itself when nothing changed.
export function reuseRows(previous: SessionSummary[], next: SessionSummary[]): SessionSummary[] {
  const saved = new Map(previous.map(row => [rowKey(row), row]));
  let same = previous.length === next.length;
  const rows = next.map((row, index) => {
    const old = saved.get(rowKey(row));
    const kept = old !== undefined && JSON.stringify(old) === JSON.stringify(row) ? old : row;
    if (kept !== previous[index]) same = false;

    return kept;
  });

  return same ? previous : rows;
}

// The list with one chat marked as working or idle. Gives the list itself when the chat is not in it or has that state.
export function markRunning(rows: SessionSummary[], hostId: string, sessionId: string, running: boolean): SessionSummary[] {
  const index = rows.findIndex(row => row.id === sessionId && (row.hostId ?? "local") === hostId);

  if (index < 0 || Boolean(rows[index].isRunning) === running) return rows;
  const next = [...rows];
  next[index] = { ...rows[index], isRunning: running };

  return next;
}
