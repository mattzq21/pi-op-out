import * as stateRecords from '../piop-storage/session-records.ts';
import * as tables from '../session-database.ts';

export interface IndexedChild { sessionId: string; kind: string; archived: boolean }

// Saves, inside the caller's transaction, the link of the new chat sessionId to its parent.
function register(root: string, sessionId: string, entries: any[]): void {
  const parent = stateRecords.auxiliaryParent(entries, sessionId);

  if (parent) tables.addAuxiliaryChild(root, parent.parentSessionId, sessionId, parent.kind);
}

// The auxiliary chats directly under parentId, with their kind and archive state.
function children(root: string, parentId: string): IndexedChild[] {
  return tables.descendantSessionRows(root, parentId).map(row => ({ sessionId: row.sessionId, kind: row.kind, archived: row.archived }));
}

// children, for the parent chat saved at parentPath.
function chatChildren(parentPath: string, parentId: string): IndexedChild[] { return children(tables.storageRoot(parentPath), parentId); }

// The chats of the tree of sessionId: its root chat and every side chat under that root. sessionId comes first.
function tree(root: string, sessionId: string): string[] { return tables.sessionTreeIds(root, sessionId); }

export { register, children, chatChildren, tree };
