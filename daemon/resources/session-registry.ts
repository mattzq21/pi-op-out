import * as sessionTables from './session-database.ts';

function sessionPath(root, id) { return sessionTables.lookup(root, id); }

export { sessionPath };
