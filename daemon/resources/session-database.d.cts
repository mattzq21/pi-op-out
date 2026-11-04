import type { DatabaseSync } from "node:sqlite";

// The shared connection of this process. Never close it.
export type Connection = Omit<DatabaseSync, "close">;

export function connection(root: string): Connection;
export function transaction<T>(database: Connection, behavior: "IMMEDIATE" | "DEFERRED" | "EXCLUSIVE", operation: () => T): T;
export function rollback(database: Connection, error: unknown): unknown;
export function reserveId(database: Connection): string;
export function pending(database: Connection, work: "transaction" | "recovery" | "retention"): boolean;
export function register(database: Connection, sessionId: string, sessionPath: string): void;
export function storageRoot(file: string): string;
export function lookup(root: string, sessionId: string): string | null | undefined;
export function markCleanup(root: string, kind: "goal"): void;
