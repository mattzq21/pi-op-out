import type { DatabaseSync } from "node:sqlite";

export function open(root: string): DatabaseSync;
export function register(database: DatabaseSync, sessionId: string, sessionPath: string): void;
